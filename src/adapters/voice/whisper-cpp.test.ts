import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { cleanTranscript, createWhisperTranscriber, ensureAsrModel } from './whisper-cpp.ts';

const TINY_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-'));
}

/** 假的 whisper-cli：记下参数，照旧版的输出格式把结果写到 `-of` 指定的 .txt。 */
function fakeWhisper(dir: string, script = ''): string {
  const file = join(dir, 'whisper-cli');
  writeFileSync(
    file,
    String.raw`#!/bin/sh
printf '%s\n' "$@" > "$0.args"
out=''
while [ $# -gt 0 ]; do
  if [ "$1" = '-of' ]; then out="$2"; fi
  shift
done
${script}
printf '[00:00:00.000 --> 00:00:02.000]  今天 海淀\nread_audio: 16000 Hz\n[00:00:02.000 --> 00:00:03.000] 下雨吗\n' > "$out.txt"
`,
    { mode: 0o755 },
  );
  return file;
}

function argsOf(bin: string): string[] {
  return readFileSync(`${bin}.args`, 'utf8').split('\n').slice(0, -1);
}

/** 放一个够大的假模型，免得去下载。 */
function modelDir(): string {
  const dir = join(tempDir(), 'models');
  mkdirSync(dir);
  writeFileSync(join(dir, 'ggml-tiny.bin'), Buffer.alloc(1_000_001));
  return dir;
}

const noFetch = (async () => {
  throw new Error('不该下载');
}) as typeof fetch;

describe('whisper.cpp', () => {
  test('静音幻觉不当成主人说的话', () => {
    assert.equal(cleanTranscript('你'), '');
    assert.equal(cleanTranscript('谢谢观看'), '');
    assert.equal(cleanTranscript('今天海淀下雨吗'), '今天海淀下雨吗');
  });

  test('去掉时间戳、read_audio 行和空白，太短的不要', () => {
    const raw =
      '[00:00:00.000 --> 00:00:02.000]  今天 海淀\nread_audio: 16000 Hz\n[00:00:02.000 --> 00:00:03.000] 下雨吗\n';
    assert.equal(cleanTranscript(raw), '今天海淀下雨吗');
    assert.equal(cleanTranscript('嗯嗯。'), '');
    assert.equal(cleanTranscript('字幕由某某制作'), '');
    assert.equal(cleanTranscript('好'), '');
    assert.equal(cleanTranscript(''), '');
  });

  test('模型第一次下载，之后直接用', async () => {
    const dir = join(tempDir(), 'models');
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const file = await ensureAsrModel(dir, 'tiny', fetcher);
    assert.equal(file, join(dir, 'ggml-tiny.bin'));
    assert.deepEqual(urls, [TINY_URL]);
    assert.deepEqual([...readFileSync(file)], [1, 2, 3]);

    writeFileSync(file, Buffer.alloc(1_000_001));
    assert.equal(await ensureAsrModel(dir, 'tiny', fetcher), file);
    assert.equal(urls.length, 1);
  });

  test('不认识的模型和下载失败都报错', async () => {
    await assert.rejects(ensureAsrModel(tempDir(), 'small', noFetch), { message: '不支持的语音识别模型：small' });
    const missing = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await assert.rejects(ensureAsrModel(tempDir(), 'tiny', missing), { message: '模型下载失败 404' });
  });

  test('参数和旧版一样，识别完删掉 .txt，返回清理过的文字', async () => {
    const dir = tempDir();
    const bin = fakeWhisper(dir);
    const models = modelDir();
    const wav = join(dir, 'yoyo-mic-1.WAV');
    const transcriber = createWhisperTranscriber({ modelDir: models, model: 'tiny', bin, fetch: noFetch });
    assert.equal(await transcriber.transcribe(wav), '今天海淀下雨吗');
    const base = join(dir, 'yoyo-mic-1');
    assert.deepEqual(argsOf(bin), [
      '-m',
      join(models, 'ggml-tiny.bin'),
      '-f',
      wav,
      '-l',
      'zh',
      '-nt',
      '-otxt',
      '-of',
      base,
      '--no-prints',
    ]);
    assert.equal(existsSync(`${base}.txt`), false);
  });

  test('没指定程序就用 YOYO_WHISPER', async () => {
    const dir = tempDir();
    const bin = fakeWhisper(dir);
    const saved = process.env['YOYO_WHISPER'];
    process.env['YOYO_WHISPER'] = bin;
    try {
      const transcriber = createWhisperTranscriber({ modelDir: modelDir(), model: '', fetch: noFetch });
      assert.equal(await transcriber.transcribe(join(dir, 'a.wav')), '今天海淀下雨吗');
    } finally {
      if (saved === undefined) delete process.env['YOYO_WHISPER'];
      else process.env['YOYO_WHISPER'] = saved;
    }
  });

  test('找不到程序、退出码不是 0 都报错', async () => {
    const models = modelDir();
    const dir = tempDir();
    const missing = createWhisperTranscriber({
      modelDir: models,
      model: 'tiny',
      bin: join(dir, '没有'),
      fetch: noFetch,
    });
    await assert.rejects(missing.transcribe(join(dir, 'a.wav')), { message: '找不到 whisper-cli，先安装 whisper.cpp' });

    const noisy = fakeWhisper(tempDir(), `printf 'a\\nb\\nc\\n模型读不了\\n' >&2; exit 2`);
    const failing = createWhisperTranscriber({ modelDir: models, model: 'tiny', bin: noisy, fetch: noFetch });
    await assert.rejects(failing.transcribe(join(dir, 'a.wav')), { message: 'b c 模型读不了' });

    const quiet = fakeWhisper(tempDir(), 'exit 2');
    const silent = createWhisperTranscriber({ modelDir: models, model: 'tiny', bin: quiet, fetch: noFetch });
    await assert.rejects(silent.transcribe(join(dir, 'a.wav')), { message: 'whisper-cli 退出 2' });
  });
});
