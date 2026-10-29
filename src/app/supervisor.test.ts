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
      created.push(config.intervalSec);
      if (config.intervalSec === 600) throw new Error('MCP 连不上');
      return {
        orchestrator: { state: { nextWhisper: 1, lastTalk: 0, lastCompact: null, memeFailedAt: null } },
        openWeb: async () => null,
      } as unknown as App;
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

    write(file, { ...BASE, intervalSec: 600 });
    await waitFor(() => runs === 2);
    assert.deepEqual(created, [300, 600, 300]);
    assert.ok(logger.lines.includes('按新的 config.json 组装不起来，先接着用原来的：MCP 连不上'));
    await delay(POLL * 5);
    assert.equal(created.length, 3, '同一份不反复试');

    write(file, { ...BASE, intervalSec: 900 });
    await waitFor(() => runs === 3);
    assert.deepEqual(created, [300, 600, 300, 900]);
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
      return {
        orchestrator: { state: { nextWhisper: 1000 * generation, lastTalk: 7, lastCompact: null, memeFailedAt: null } },
        openWeb: async () => ({ origin: 'http://127.0.0.1:4570', url: 'u', token: `token-${generation}` }),
      } as unknown as App;
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

    write(file, { ...BASE, intervalSec: 600 });
    await waitFor(() => created.length === 2);
    assert.equal(created[1]?.config.intervalSec, 600);
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
});
