/**
 * agent 的 `yoyo` 工具怎么跑命令行：另起一个 Node 进程跑 `paths.cliEntry`，设好 `YOYO_AGENT=1`，
 * 命令行就只给 agent 那部分。和主人在终端里敲的是同一个程序，别的 agent 也可以照这样调。
 */
import { execFile } from 'node:child_process';

import type { CliRun } from '../brain/tools.ts';
import type { Paths } from './paths.ts';

/** 设成 `1` 时命令行只给 agent 那部分，见 `cli/registry.ts` 的 `agentDomains`。 */
export const AGENT_ENV = 'YOYO_AGENT';

/** 一条命令最多跑多久。 */
export const CLI_TIMEOUT_MS = 20_000;
/** 交回给模型的输出最多多少字。 */
export const CLI_OUTPUT_MAX = 8000;

export interface CliRunnerOptions {
  /** 跑命令行的程序，缺省是当前的 Node。 */
  readonly node?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function createCliRunner(paths: Pick<Paths, 'cliEntry'>, options: CliRunnerOptions = {}): CliRun {
  const node = options.node ?? process.execPath;
  const env = { ...(options.env ?? process.env), [AGENT_ENV]: '1', NO_COLOR: '1' };
  return (argv) =>
    new Promise((resolve, reject) => {
      execFile(
        node,
        [paths.cliEntry, ...argv],
        { env, timeout: options.timeoutMs ?? CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const text = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          if (error && error.killed) return reject(new Error('命令跑太久，停下了'));
          if (error && !text) return reject(error);
          resolve(text.length > CLI_OUTPUT_MAX ? `${text.slice(0, CLI_OUTPUT_MAX)}\n…（太长，截掉了）` : text);
        },
      );
    });
}
