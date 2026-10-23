import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';

import { cacheFile, createFishSynthesizer, spokenText, ttsEndpoint } from './fish.ts';

const speech = { baseUrl: 'https://api.fish.audio', apiKey: 'sk-test', model: 's2.1-pro-free', referenceId: 'ref-1' };

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  return { calls, fetcher };
}

function audio(size = 256): Uint8Array {
  return new Uint8Array(size).fill(7);
}

function cacheDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'speech-cache');
}

describe('fish', () => {
  test('句首没有情绪标签才补上 cue', () => {
    assert.equal(spokenText('  在呢 ', '[happy]'), '[happy] 在呢');
    assert.equal(spokenText('[sad] 唉', '[happy]'), '[sad] 唉');
    assert.equal(spokenText('   ', '[happy]'), '');
  });

  test('地址补上 /v1/tts，已经有了就不重复', () => {
    assert.equal(ttsEndpoint('https://api.fish.audio'), 'https://api.fish.audio/v1/tts');
    assert.equal(ttsEndpoint('https://api.fish.audio/v1/tts/'), 'https://api.fish.audio/v1/tts');
    assert.equal(ttsEndpoint(' https://proxy.local/fish// '), 'https://proxy.local/fish/v1/tts');
  });

  test('缓存文件名和旧版公式一样，老缓存继续能用', () => {
    const legacy = (spoken: string, cue: string) =>
      createHash('sha256').update(`${speech.model}\n${cue}\n${speech.referenceId}\n${spoken}`).digest('hex');
    assert.equal(
      cacheFile('/cache', speech, ' 在呢 ', '[happy]'),
      join('/cache', `${legacy('[happy] 在呢', '[happy]')}.mp3`),
    );
    assert.equal(
      cacheFile('/cache', speech, '[sad] 唉', '[happy]'),
      join('/cache', `${legacy('[sad] 唉', '[happy]')}.mp3`),
    );
    // 用旧版 speech.js 算出来的值
    assert.equal(
      basename(cacheFile('/cache', speech, ' 在呢 ', '[happy]')),
      '181b5793bbeb5823c4dbfc14541b69467d65450ac20f33c64d7a205f5411e87a.mp3',
    );
    assert.equal(
      basename(cacheFile('/cache', speech, '[sad] 唉', '[happy]')),
      'de39144e92e95f52313e05c89eddb104cd67fdfa65a4cee59320cbbce81a7c32.mp3',
    );
  });

  test('请求带 Bearer 密钥和 model 头，合成结果留在缓存目录', async () => {
    const dir = cacheDir();
    const { calls, fetcher } = fakeFetch(() => new Response(audio()));
    const synthesizer = createFishSynthesizer({ speech, cacheDir: dir, fetch: fetcher });

    const file = await synthesizer.synthesize(' 在呢 ', '[happy]');
    assert.equal(file, cacheFile(dir, speech, ' 在呢 ', '[happy]'));
    assert.deepEqual(new Uint8Array(readFileSync(file)), audio());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, 'https://api.fish.audio/v1/tts');
    assert.equal(call?.init?.method, 'POST');
    assert.deepEqual(call?.init?.headers, {
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    });
    assert.deepEqual(JSON.parse(String(call?.init?.body)), {
      text: '[happy] 在呢',
      reference_id: 'ref-1',
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'balanced',
      normalize: true,
      chunk_length: 100,
      temperature: 0.7,
      top_p: 0.7,
    });
    assert.ok(call?.init?.signal instanceof AbortSignal);
  });

  test('有缓存就不再请求', async () => {
    const dir = cacheDir();
    const { calls, fetcher } = fakeFetch(() => new Response(audio()));
    const synthesizer = createFishSynthesizer({ speech, cacheDir: dir, fetch: fetcher });
    const first = await synthesizer.synthesize('喝口水', '[relaxed]');
    assert.equal(await synthesizer.synthesize('喝口水', '[relaxed]'), first);
    assert.equal(calls.length, 1);

    // 旧版留下的缓存文件也直接用
    const old = cacheFile(dir, speech, '早', '[calm]');
    writeFileSync(old, 'old mp3');
    assert.equal(await synthesizer.synthesize('早', '[calm]'), old);
    assert.equal(calls.length, 1);
  });

  test('接口报错带状态码和原因，密钥不进报错', async () => {
    const dir = cacheDir();
    const failing = (status: number, body: string) =>
      createFishSynthesizer({ speech, cacheDir: dir, fetch: fakeFetch(() => new Response(body, { status })).fetcher });
    await assert.rejects(failing(401, 'invalid key sk-test, try again').synthesize('在呢', '[happy]'), {
      message: '语音接口返回 401：invalid key , try again',
    });
    await assert.rejects(failing(500, '').synthesize('在呢', '[happy]'), { message: '语音接口返回 500' });
    await assert.rejects(failing(502, '错'.repeat(300)).synthesize('在呢', '[happy]'), {
      message: `语音接口返回 502：${'错'.repeat(180)}`,
    });
    assert.equal(existsSync(cacheFile(dir, speech, '在呢', '[happy]')), false);
  });

  test('返回的音频太短就当没有', async () => {
    const dir = cacheDir();
    const { fetcher } = fakeFetch(() => new Response(audio(64)));
    const synthesizer = createFishSynthesizer({ speech, cacheDir: dir, fetch: fetcher });
    await assert.rejects(synthesizer.synthesize('在呢', '[happy]'), { message: '语音接口没有返回音频' });
    assert.equal(existsSync(cacheFile(dir, speech, '在呢', '[happy]')), false);
  });

  test('空句不请求', async () => {
    const { calls, fetcher } = fakeFetch(() => new Response(audio()));
    const synthesizer = createFishSynthesizer({ speech, cacheDir: cacheDir(), fetch: fetcher });
    await assert.rejects(synthesizer.synthesize('  ', '[happy]'), { message: '没有可朗读的文字' });
    assert.equal(calls.length, 0);
  });
});
