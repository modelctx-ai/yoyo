import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createFfmpegRecorder } from './ffmpeg.ts';

/** 假的 ffmpeg：把参数写到旁边的 .args 文件，其余照给定的脚本做。 */
function fakeBin(script: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'ffmpeg');
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\n${script}\n`, { mode: 0o755 });
  return file;
}

function argsOf(bin: string): string[] {
  return readFileSync(`${bin}.args`, 'utf8').split('\n').slice(0, -1);
}

describe('ffmpeg', () => {
  test('参数和旧版一样，录完返回文件路径', async () => {
    const bin = fakeBin('exit 0');
    const recorder = createFfmpegRecorder({ device: ':1', bin });
    assert.equal(await recorder.record('/tmp/yoyo-mic-1.wav', 5), '/tmp/yoyo-mic-1.wav');
    assert.deepEqual(argsOf(bin), [
      '-y',
      '-f',
      'avfoundation',
      '-i',
      ':1',
      '-t',
      '5',
      '-ac',
      '1',
      '-ar',
      '16000',
      '/tmp/yoyo-mic-1.wav',
    ]);
  });

  test('设备空着就用 :0', async () => {
    const bin = fakeBin('exit 0');
    await createFfmpegRecorder({ device: '', bin }).record('/tmp/a.wav', 3);
    assert.equal(argsOf(bin)[4], ':0');
  });

  test('失败时报 stderr 的最后三行，没有就报退出码', async () => {
    const noisy = fakeBin(`printf '第一行\\n第二行\\n第三行\\n设备打不开\\n' >&2\nexit 1`);
    await assert.rejects(createFfmpegRecorder({ device: ':0', bin: noisy }).record('/tmp/a.wav', 5), {
      message: '第二行 第三行 设备打不开',
    });
    const quiet = fakeBin('exit 1');
    await assert.rejects(createFfmpegRecorder({ device: ':0', bin: quiet }).record('/tmp/a.wav', 5), {
      message: 'ffmpeg 退出 1',
    });
  });
});
