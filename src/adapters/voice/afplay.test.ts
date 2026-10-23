import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vite-plus/test';

import { createAfplayPlayer } from './afplay.ts';

/** 假的播放程序：把参数写到旁边的 .args 文件，再按给定的退出码退出。 */
function fakeBin(exitCode: number): string {
  const file = join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'afplay');
  writeFileSync(
    file,
    String.raw`#!/bin/sh
printf '%s\n' "$@" > "$0.args"
exit ${exitCode}
`,
    { mode: 0o755 },
  );
  return file;
}

function argsOf(bin: string): string[] {
  return readFileSync(`${bin}.args`, 'utf8').split('\n').slice(0, -1);
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await delay(20);
  }
}

describe('afplay', () => {
  test('不给音量只传文件，给了音量加 -v', async () => {
    const bin = fakeBin(0);
    const player = createAfplayPlayer({ bin });
    await player.play('/tmp/在呢.mp3');
    assert.deepEqual(argsOf(bin), ['/tmp/在呢.mp3']);
    await player.play('/tmp/在呢.mp3', { volume: 0.5 });
    assert.deepEqual(argsOf(bin), ['-v', '0.5', '/tmp/在呢.mp3']);
  });

  test('退出码不是 0 就报错', async () => {
    const player = createAfplayPlayer({ bin: fakeBin(3) });
    await assert.rejects(player.play('/tmp/a.mp3'), { message: 'afplay 退出 3' });
  });

  test('找不到播放程序时 play 报错，fire 不报错', async () => {
    const player = createAfplayPlayer({ bin: join(tmpdir(), 'yoyo-没有这个程序') });
    await assert.rejects(player.play('/tmp/a.mp3'), { code: 'ENOENT' });
    assert.doesNotThrow(() => player.fire('/tmp/a.mp3', { volume: 0.18 }));
    await delay(100);
  });

  test('fire 在后台播放，不等结束', async () => {
    const bin = fakeBin(0);
    createAfplayPlayer({ bin }).fire('/tmp/keys.wav', { volume: 0.18 });
    await waitFor(() => existsSync(`${bin}.args`) && argsOf(bin).length === 3);
    assert.deepEqual(argsOf(bin), ['-v', '0.18', '/tmp/keys.wav']);
  });
});
