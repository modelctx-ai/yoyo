import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clipboard, Logger, UrlOpener } from '../../ports/index.ts';

/** 用 pbpaste 读粘贴板。读不到返回空字符串。 */
export function createPbpasteClipboard(): Clipboard {
  return {
    read() {
      try {
        return execFileSync('pbpaste', [], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
      } catch {
        return '';
      }
    },
  };
}

/** 用 open 在默认浏览器里打开网址。 */
export function createMacOpener(): UrlOpener {
  return {
    open(url) {
      const child = spawn('open', [url], { stdio: 'ignore', detached: true });
      child.once('error', () => {
        /* 打不开就算了，确认页到时会自己超时 */
      });
      child.unref();
    },
    reveal(path) {
      const child = spawn('open', ['-R', path], { stdio: 'ignore', detached: true });
      child.once('error', () => {
        /* 访达打不开就算了 */
      });
      child.unref();
    },
  };
}

export interface HotkeyHelperOptions {
  /** 助手的可执行文件。不在就先把源码编译到这里。 */
  readonly bin: string;
  /** hotkey.swift 的路径。 */
  readonly source: string;
  readonly inboxFile: string;
  readonly logger: Logger;
  /** Swift 编译器，缺省 swiftc。测试时换成假的。 */
  readonly swiftc?: string;
}

export interface HotkeyHelper {
  /** 停掉助手。它自己不看 yoyo 还在不在，不停就一直留着。 */
  stop(): void;
}

/** 按键助手：第一次先编译，之后直接启动。按下快捷键就往收件箱写一条 listen。没起成返回 null。 */
export function startHotkeyHelper(options: HotkeyHelperOptions): HotkeyHelper | null {
  const bin = options.bin;
  if (!existsSync(bin)) {
    mkdirSync(dirname(bin), { recursive: true, mode: 0o700 });
    const built = spawnSync(options.swiftc ?? 'swiftc', ['-O', '-o', bin, options.source], { encoding: 'utf8' });
    if (built.status !== 0) {
      options.logger.error('按键助手没编译成，仍可用 yoyo listen');
      return null;
    }
  }
  const child = spawn(bin, [options.inboxFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim();
    if (text) options.logger.error(text);
  });
  child.once('error', (error) => {
    options.logger.error(`按键助手没启动：${error.message}`);
  });
  child.unref();
  return {
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}
