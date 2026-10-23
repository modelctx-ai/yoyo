import { spawn } from 'node:child_process';

import type { AudioPlayer, PlayOptions } from '../../ports/index.ts';

export interface AfplayOptions {
  /** 播放程序，缺省 macOS 自带的 afplay。测试时换成假的。 */
  readonly bin?: string;
}

function argsFor(file: string, options: PlayOptions | undefined): string[] {
  return options?.volume === undefined ? [file] : ['-v', String(options.volume), file];
}

/** 用 afplay 播放本地音频。 */
export function createAfplayPlayer(options: AfplayOptions = {}): AudioPlayer {
  const bin = options.bin ?? 'afplay';
  return {
    play(file, playOptions) {
      return new Promise((resolve, reject) => {
        const child = spawn(bin, argsFor(file, playOptions), { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`afplay 退出 ${code}`));
        });
      });
    },
    fire(file, playOptions) {
      try {
        const child = spawn(bin, argsFor(file, playOptions), { stdio: 'ignore', detached: true });
        child.once('error', () => {
          /* 后台播放是附带的，放不出来也不管 */
        });
        child.unref();
      } catch {
        /* 同上 */
      }
    },
  };
}
