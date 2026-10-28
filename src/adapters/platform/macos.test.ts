import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vite-plus/test';

import type { Logger } from '../../ports/index.ts';
import { createPbpasteClipboard, startHotkeyHelper } from './macos.ts';
import { noopClipboard, noopOpener } from './noop.ts';

/** 假的按键助手：记下参数，往 stderr 说一句，然后退出。 */
const HELPER = String.raw`#!/bin/sh
printf '%s\n' "$@" > "$0.args"
echo 'hotkey needs accessibility permission' >&2
exit 2
`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-'));
}

function memoryLogger() {
  const errors: string[] = [];
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: (message) => errors.push(message) };
  return { errors, logger };
}

function argsOf(file: string): string[] {
  return readFileSync(`${file}.args`, 'utf8').split('\n').slice(0, -1);
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await delay(20);
  }
}

describe('按键助手', () => {
  test('已经编译过（或安装包里带着）就直接启动，传收件箱路径，stderr 记成错误', async () => {
    const binDir = join(tempDir(), 'bin');
    mkdirSync(binDir);
    const bin = join(binDir, 'yoyo-hotkey');
    writeFileSync(bin, HELPER, { mode: 0o755 });
    const { errors, logger } = memoryLogger();
    const inboxFile = join(tempDir(), 'inbox.jsonl');
    startHotkeyHelper({ bin, source: '/不存在/hotkey.swift', inboxFile, logger, swiftc: '/不存在/swiftc' });
    await waitFor(() => errors.length > 0);
    assert.deepEqual(errors, ['hotkey needs accessibility permission']);
    assert.deepEqual(argsOf(bin), [inboxFile]);
  });

  test('第一次先用 swiftc -O 编译再启动', async () => {
    const dir = tempDir();
    const swiftc = join(dir, 'swiftc');
    writeFileSync(
      swiftc,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\ncat > "$3" <<'EOF'\n${HELPER}EOF\nchmod 755 "$3"\n`,
      { mode: 0o755 },
    );
    const binDir = join(dir, 'bin');
    const bin = join(binDir, 'yoyo-hotkey');
    const source = join(dir, 'hotkey.swift');
    const inboxFile = join(dir, 'inbox.jsonl');
    const { errors, logger } = memoryLogger();
    startHotkeyHelper({ bin, source, inboxFile, logger, swiftc });
    assert.deepEqual(argsOf(swiftc), ['-O', '-o', bin, source]);
    assert.equal(statSync(binDir).mode & 0o777, 0o700);
    await waitFor(() => errors.length > 0);
    assert.deepEqual(errors, ['hotkey needs accessibility permission']);
    assert.deepEqual(argsOf(bin), [inboxFile]);
  });

  test('编译不成只记一行，不启动', () => {
    const binDir = join(tempDir(), 'bin');
    const { errors, logger } = memoryLogger();
    startHotkeyHelper({
      bin: join(binDir, 'yoyo-hotkey'),
      source: '/不存在/hotkey.swift',
      inboxFile: '/不存在/inbox.jsonl',
      logger,
      swiftc: join(tempDir(), '没有编译器'),
    });
    assert.deepEqual(errors, ['按键助手没编译成，仍可用 yoyo listen']);
    assert.equal(existsSync(join(binDir, 'yoyo-hotkey')), false);
  });

  test('助手源码就在适配器旁边', () => {
    const copied = readFileSync(new URL('./hotkey.swift', import.meta.url), 'utf8');
    assert.match(copied, /NSEvent\.addGlobalMonitorForEvents/);
    assert.match(copied, /\{\\"type\\":\\"listen\\"\}/);
  });
});

describe('粘贴板和打开网页', () => {
  test('没有 pbpaste 时读到空字符串', { skip: process.platform === 'darwin' }, () => {
    assert.equal(createPbpasteClipboard().read(), '');
  });

  test('别的平台用空实现', () => {
    assert.equal(noopClipboard.read(), '');
    assert.equal(noopOpener.open('http://127.0.0.1:1/'), undefined);
  });
});
