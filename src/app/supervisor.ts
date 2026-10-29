/**
 * 常驻进程的外层：按 config.json 组装应用、跑常驻循环；config.json 改了，就关掉这一份、按新的再组装一份。
 * 改坏了（不是 JSON、驱动桌宠却缺语音）只记一行，接着用现在的，等下一次改好。
 */
import { unwatchFile, watchFile, type Stats } from 'node:fs';

import { runDaemon, type DaemonOptions } from '../runtime/daemon.ts';
import { assertDirectorReady, loadConfig, type Config } from './config.ts';
import { createApp, type App, type AppOverrides, type Resume } from './container.ts';
import { consoleLogger, errorText } from './log.ts';
import type { Paths } from './paths.ts';
import type { Logger } from '../ports/index.ts';

/** 多久看一次 config.json 变了没有。按 stat 轮询：编辑器另存再改名、管理页原子写入都认得出。 */
export const CONFIG_POLL_MS = 1000;

/**
 * 盯着 config.json：内容变了、读得出来、驱动桌宠时语音也配齐了，才交给 `onChange`。
 * 只改了空白、写成同样的值不算变。一开始先对一次：上一份换下来的那会儿又改过，也不会漏。返回停止盯的函数。
 */
export function watchConfig(
  file: string,
  current: Config,
  onChange: (next: Config) => void,
  options: { readonly logger?: Logger; readonly intervalMs?: number } = {},
): () => void {
  const logger = options.logger ?? consoleLogger;
  let last = JSON.stringify(current);
  let problem = '';
  const check = (): void => {
    let next: Config;
    try {
      next = loadConfig(file);
      assertDirectorReady(next);
    } catch (error) {
      const text = errorText(error);
      // 同一个问题只记一次
      if (text !== problem) logger.warn(`config.json 改得不对，先接着用现在的：${text}`);
      problem = text;
      return;
    }
    problem = '';
    const key = JSON.stringify(next);
    if (key === last) return;
    last = key;
    onChange(next);
  };
  const listener = (now: Stats, before: Stats): void => {
    if (now.mtimeMs === before.mtimeMs && now.size === before.size && now.ino === before.ino) return;
    check();
  };
  watchFile(file, { interval: options.intervalMs ?? CONFIG_POLL_MS, persistent: false }, listener);
  check();
  return () => unwatchFile(file, listener);
}

export interface SuperviseOptions {
  readonly logger?: Logger;
  readonly intervalMs?: number;
  /** 测试替身。 */
  readonly create?: (config: Config, paths: Paths, overrides: AppOverrides) => Promise<App>;
  readonly run?: (app: App, options: DaemonOptions) => Promise<void>;
}

/** 跑常驻进程，config.json 改了就换上新的。收到退出信号时由常驻循环自己退出进程。 */
export async function supervise(config: Config, paths: Paths, options: SuperviseOptions = {}): Promise<void> {
  const logger = options.logger ?? consoleLogger;
  const create = options.create ?? createApp;
  const run = options.run ?? runDaemon;
  let current = config;
  let previous: Config | null = null;
  let resume: Resume | undefined;
  for (;;) {
    let app: App;
    // 文件里现在是哪份：组装不起来、退回上一份时，等文件再改才换，不拿同一份反复试
    let seen = current;
    try {
      app = await create(current, paths, resume ? { resume } : {});
    } catch (error) {
      // 按新配置组装不起来：退回上一份，不让常驻进程就此停下
      if (!previous) throw error;
      logger.error(`按新的 config.json 组装不起来，先接着用原来的：${errorText(error)}`);
      seen = current;
      current = previous;
      previous = null;
      app = await create(current, paths, resume ? { resume } : {});
    }
    const generation = new AbortController();
    let next: Config | null = null;
    const stop = watchConfig(
      paths.configFile,
      seen,
      (changed) => {
        next = changed;
        generation.abort();
      },
      { logger, ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}) },
    );
    // 管理页的端口和令牌留给下一份：开着的页面接着能用
    const web = await app.openWeb().catch(() => null);
    try {
      await run(app, { signal: generation.signal });
    } finally {
      stop();
    }
    if (next === null) return;
    resume = {
      schedule: { ...app.orchestrator.state },
      ...(web ? { webPort: Number(new URL(web.origin).port), webToken: web.token } : {}),
    };
    previous = current;
    current = next;
    logger.info('config.json 改了，换上新的');
  }
}
