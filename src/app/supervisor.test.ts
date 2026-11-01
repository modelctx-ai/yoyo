import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vite-plus/test';

import { memoryLogger } from '../runtime/testing.ts';
import { parseConfig, type Config } from './config.ts';
import type { App, AppOverrides } from './container.ts';
import { resolvePaths } from './paths.ts';
import { supervise, watchConfig } from './supervisor.ts';

const POLL = 20;

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await delay(10);
  }
}

/** 改 config.json：mtime 精度可能是秒，换个大小保证 stat 看得出变了。 */
let writes = 0;
function write(file: string, value: unknown): void {
  writes += 1;
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}${' '.repeat(writes)}`);
}

function tempConfig(value: unknown): { file: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-sup-'));
  const file = join(home, 'config.json');
  write(file, value);
  return { file, home };
}

const BASE = { stage: 'console', intervalSec: 300 };

/** 假应用：记下就地换上的配置，`idle` 由用例决定什么时候空下来。 */
function fakeApp(
  config: Config,
  state: Record<string, unknown>,
  options: { readonly web?: unknown; readonly idle?: () => Promise<void>; readonly reconfigured?: Config[] } = {},
): App {
  let current = config;
  return {
    get config() {
      return current;
    },
    reconfigure(next: Config) {
      current = next;
      options.reconfigured?.push(next);
    },
    orchestrator: { state, idle: options.idle ?? (async () => {}) },
    openWeb: async () => options.web ?? null,
  } as unknown as App;
}

/** 常驻循环的替身：等这一代被中止。 */
function fakeRun(): {
  readonly run: (app: App, options: { signal?: AbortSignal }) => Promise<void>;
  readonly runs: () => number;
  readonly finish: () => void;
} {
  let runs = 0;
  let finish: (() => void) | null = null;
  return {
    async run(_app, options) {
      runs += 1;
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
        finish = resolve;
      });
    },
    runs: () => runs,
    finish: () => (finish as unknown as () => void)(),
  };
}

describe('盯 config.json', () => {
  test('内容变了才交出去；只改空白不算；改坏了只记一次，改好了再交', async () => {
    const { file } = tempConfig(BASE);
    const logger = memoryLogger();
    const seen: Config[] = [];
    const stop = watchConfig(file, parseConfig(BASE), (next) => seen.push(next), { logger, intervalMs: POLL });
    try {
      write(file, BASE);
      await delay(POLL * 5);
      assert.equal(seen.length, 0, '值没变');

      write(file, { ...BASE, intervalSec: 600 });
      await waitFor(() => seen.length === 1);
      assert.equal(seen[0]?.intervalSec, 600);

      write(file, '{ "stage": ');
      await waitFor(() => logger.lines.length === 1);
      write(file, '{ "stage":  ');
      await delay(POLL * 5);
      assert.equal(logger.lines.length, 1, '同一个问题只记一次');
      assert.match(logger.lines[0] ?? '', /^config\.json 改得不对，先接着用现在的：config\.json 不是合法的 JSON/);

      // 驱动桌宠却没配语音：常驻进程起不来，不换
      write(file, { ...BASE, stage: 'dsh-pet' });
      await waitFor(() => logger.lines.length === 2);
      assert.match(logger.lines[1] ?? '', /speech\.baseUrl 还空着|speech\.apiKey 还空着/);

      write(file, { ...BASE, intervalSec: 900 });
      await waitFor(() => seen.length === 2);
      assert.equal(seen[1]?.intervalSec, 900);
    } finally {
      stop();
    }
  });
});

describe('换配置', () => {
  test('按新配置组装不起来：退回原来的，等文件再改才换', async () => {
    const { file, home } = tempConfig(BASE);
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: file });
    const logger = memoryLogger();
    const created: number[] = [];
    let runs = 0;
    let finish: (() => void) | null = null;
    const create = async (config: Config): Promise<App> => {
      created.push(config.context.keep);
      if (config.context.keep === 60) throw new Error('MCP 连不上');
      return fakeApp(config, { nextWhisper: 1, lastTalk: 0, lastCompact: null, memeFailedAt: null });
    };
    const run = async (_app: App, options: { signal?: AbortSignal }): Promise<void> => {
      runs += 1;
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
        finish = resolve;
      });
    };
    const running = supervise(parseConfig(BASE), paths, { logger, intervalMs: POLL, create, run });
    await waitFor(() => runs === 1);

    write(file, { ...BASE, context: { keep: 60 } });
    await waitFor(() => runs === 2);
    assert.deepEqual(created, [40, 60, 40]);
    assert.ok(logger.lines.includes('按新的 config.json 组装不起来，先接着用原来的：MCP 连不上'));
    await delay(POLL * 5);
    assert.equal(created.length, 3, '同一份不反复试');

    write(file, { ...BASE, context: { keep: 90 } });
    await waitFor(() => runs === 3);
    assert.deepEqual(created, [40, 60, 40, 90]);
    (finish as unknown as () => void)();
    await running;
  });

  test('改了就关掉这一份、按新的再组装；碎碎念排期、管理页端口和令牌接着用', async () => {
    const { file, home } = tempConfig(BASE);
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: file });
    const logger = memoryLogger();
    const created: { config: Config; overrides: AppOverrides }[] = [];
    let finish: (() => void) | null = null;
    let runs = 0;

    const create = async (config: Config, _paths: typeof paths, overrides: AppOverrides): Promise<App> => {
      created.push({ config, overrides });
      const generation = created.length;
      return fakeApp(
        config,
        { nextWhisper: 1000 * generation, lastTalk: 7, lastCompact: null, memeFailedAt: null },
        { web: { origin: 'http://127.0.0.1:4570', url: 'u', token: `token-${generation}` } },
      );
    };
    const run = async (_app: App, options: { signal?: AbortSignal }): Promise<void> => {
      runs += 1;
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
        finish = resolve;
      });
    };

    const running = supervise(parseConfig(BASE), paths, { logger, intervalMs: POLL, create, run });
    await waitFor(() => created.length === 1);
    assert.deepEqual(created[0]?.overrides, {});

    write(file, { ...BASE, context: { keep: 60 } });
    await waitFor(() => created.length === 2);
    assert.equal(created[1]?.config.context.keep, 60);
    assert.deepEqual(created[1]?.overrides.resume, {
      schedule: { nextWhisper: 1000, lastTalk: 7, lastCompact: null, memeFailedAt: null },
      webPort: 4570,
      webToken: 'token-1',
    });
    assert.ok(logger.lines.includes('config.json 改了，换上新的'));

    // 常驻循环自己结束（收到退出信号），外层也结束
    await waitFor(() => runs === 2);
    (finish as unknown as () => void)();
    await running;
    assert.equal(created.length, 2);
  });

  test('改的都是就地生效的项：交给应用，不重建；改到要重建的项才重建', async () => {
    const { file, home } = tempConfig(BASE);
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: file });
    const logger = memoryLogger();
    const created: Config[] = [];
    const reconfigured: Config[] = [];
    const daemon = fakeRun();
    const create = async (config: Config): Promise<App> => {
      created.push(config);
      return fakeApp(config, { nextWhisper: 1 }, { reconfigured });
    };
    const running = supervise(parseConfig(BASE), paths, { logger, intervalMs: POLL, create, run: daemon.run });
    await waitFor(() => daemon.runs() === 1);

    write(file, { ...BASE, intervalSec: 600, weather: { enabled: false } });
    await waitFor(() => reconfigured.length === 1);
    assert.equal(reconfigured[0]?.intervalSec, 600);
    assert.equal(reconfigured[0]?.weather.enabled, false);
    assert.ok(
      logger.lines.includes('config.json 改了，就地换上：intervalSec、weather.enabled'),
      logger.lines.join('\n'),
    );
    await delay(POLL * 5);
    assert.equal(created.length, 1, '没重建');

    // 就地换上以后再改要重建的：和就地换上的那份比，新的一份带着前面就地改的
    write(file, { ...BASE, intervalSec: 600, weather: { enabled: false }, llm: { tools: true } });
    await waitFor(() => created.length === 2);
    assert.equal(created[1]?.llm.tools, true);
    assert.equal(created[1]?.intervalSec, 600);
    assert.equal(reconfigured.length, 1);
    await waitFor(() => daemon.runs() === 2);
    daemon.finish();
    await running;
  });

  test('要重建：等主线程这一轮说完；等太久照样重建', async () => {
    const { file, home } = tempConfig(BASE);
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: file });
    let release: (() => void) | null = null;
    let busy = true;
    const created: Config[] = [];
    const daemon = fakeRun();
    const idle = (): Promise<void> =>
      busy
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    const create = async (config: Config): Promise<App> => {
      created.push(config);
      return fakeApp(config, { nextWhisper: 1 }, { idle });
    };
    const options = { logger: memoryLogger(), intervalMs: POLL, create, run: daemon.run, rebuildWaitMs: 60_000 };
    const running = supervise(parseConfig(BASE), paths, options);
    await waitFor(() => daemon.runs() === 1);

    write(file, { ...BASE, memory: { enabled: true } });
    await waitFor(() => release !== null);
    await delay(POLL * 5);
    assert.equal(created.length, 1, '这一轮还没说完，不重建');
    busy = false;
    (release as unknown as () => void)();
    await waitFor(() => created.length === 2);
    assert.equal(created[1]?.memory.enabled, true);
    await waitFor(() => daemon.runs() === 2);
    daemon.finish();
    await running;

    // 主线程一直不空：等到 rebuildWaitMs 照样重建
    const again = tempConfig(BASE);
    const stuck: Config[] = [];
    const later = fakeRun();
    const make = async (config: Config): Promise<App> => {
      stuck.push(config);
      return fakeApp(config, { nextWhisper: 1 }, { idle: () => new Promise<void>(() => {}) });
    };
    const paths2 = resolvePaths({ YOYO_HOME: again.home, YOYO_CONFIG: again.file });
    const second = supervise(parseConfig(BASE), paths2, {
      logger: memoryLogger(),
      intervalMs: POLL,
      create: make,
      run: later.run,
      rebuildWaitMs: POLL * 3,
    });
    await waitFor(() => later.runs() === 1);
    write(again.file, { ...BASE, memory: { enabled: true } });
    await waitFor(() => stuck.length === 2);
    await waitFor(() => later.runs() === 2);
    later.finish();
    await second;
  });
});
