import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import type { Line, ScheduleItem } from '../kernel/types.ts';
import type { Clipboard } from '../ports/index.ts';
import type { Director, PerformResult } from './director.ts';
import {
  COMPACT_EVERY_MS,
  MEME_RETRY_MS,
  WHISPER_RETRY_MS,
  channelPlan,
  compactDue,
  createTick,
  memeDue,
  memeIdle,
  menuRequest,
  nextAfterSpeak,
  whisperIntervalMs,
  whisperStep,
  type DaemonState,
  type TickApp,
} from './daemon.ts';
import { drain, enqueue } from './inbox.ts';
import { memoryLogger, memoryRepos } from './testing.ts';

const LINE: Line = { text: '我在呢', tone: 'lively', cue: '[happy]', action: '照镜子', kind: 'whisper' };

function fakeDirector(calls: string[], overrides: Partial<Director> = {}): Director {
  return {
    perform: async () => {
      calls.push('perform');
      return { line: LINE, talked: false } satisfies PerformResult;
    },
    listenNow: async () => {
      calls.push('listen');
      return { talked: true };
    },
    remind: async (item) => void calls.push(`remind:${item.title}`),
    bake: async () => void calls.push('bake'),
    choose: async () => LINE,
    claim: (text) => void calls.push(`claim:${text}`),
    playForeign: async (text) => {
      calls.push(`foreign:${text}`);
      return true;
    },
    refreshMemes: async () => {
      calls.push('memes');
      return null;
    },
    syncPetChat: async () => void calls.push('sync'),
    compactIfNeeded: async () => {
      calls.push('compact');
      return false;
    },
    ...overrides,
  };
}

interface TickRig {
  readonly app: TickApp & { readonly logger: ReturnType<typeof memoryLogger> };
  readonly calls: string[];
  readonly state: DaemonState;
  readonly clock: { now: number };
  readonly tick: () => Promise<void>;
}

/** 周六下午三点，没有天气也没有闹钟。 */
const T0 = new Date(2026, 9, 24, 15, 0, 0).getTime();

function tickRig(
  options: {
    readonly config?: Record<string, unknown>;
    readonly director?: Partial<Director>;
    readonly state?: Partial<DaemonState>;
    readonly clipboard?: Clipboard;
  } = {},
): TickRig {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const calls: string[] = [];
  const clock = { now: T0 };
  const app = {
    config: parseConfig({ clipboard: { enabled: false }, ...options.config }),
    paths: resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') }),
    logger: memoryLogger(),
    repos: memoryRepos({ now: () => new Date(clock.now) }),
    clipboard: options.clipboard ?? { read: () => '' },
    director: fakeDirector(calls, options.director),
  };
  const state: DaemonState = { nextWhisper: T0, lastTalk: 0, lastCompact: null, memeFailedAt: null, ...options.state };
  return { app, calls, state, clock, tick: createTick(app, state, () => clock.now) };
}

describe('daemon 节奏', () => {
  test('碎碎念间隔：至少一分钟，没写或写错按 5 分钟', () => {
    assert.equal(whisperIntervalMs(300), 300_000);
    assert.equal(whisperIntervalMs(10), 60_000);
    assert.equal(whisperIntervalMs(0), 300_000);
    assert.equal(whisperIntervalMs(Number.NaN), 300_000);
  });

  test('对话一出现，碎碎念就顺延到结束后 30 秒，再说话就再顺延', () => {
    assert.deepEqual(whisperStep(1_000, 900, 999), { kind: 'wait' });
    assert.deepEqual(whisperStep(1_000, 900, 1_000), { kind: 'delay', until: 900 + 30_000 });
    assert.deepEqual(whisperStep(900 + 30_000, 20_000, 30_900), { kind: 'delay', until: 20_000 + 30_000 });
    assert.deepEqual(whisperStep(80_000, 1_000, 80_000), { kind: 'speak' });
    assert.equal(nextAfterSpeak(100_000, 300_000, 0), 400_000);
    assert.equal(nextAfterSpeak(100_000, 10_000, 99_000), 129_000, '刚说完话，下一句等对话停 30 秒');
  });

  test('离下一句还有 20 秒以上才去找表情包；上次没找成就等 10 分钟', () => {
    assert.equal(memeIdle(0, 20_001), true);
    assert.equal(memeIdle(0, 20_000), false);
    const far = 10 * MEME_RETRY_MS;
    assert.equal(memeDue(0, far, null), true);
    assert.equal(memeDue(MEME_RETRY_MS - 1, far, 0), false);
    assert.equal(memeDue(MEME_RETRY_MS, far, 0), true);
    assert.equal(memeDue(MEME_RETRY_MS, MEME_RETRY_MS + 20_000, 0), false, '不空闲也不找');
  });

  test('配了 compactAt 才压缩，10 分钟最多看一次', () => {
    const on = parseConfig({ context: { compactAt: 1000 } });
    assert.equal(compactDue(parseConfig({}), 0, null), false);
    assert.equal(compactDue(on, 0, null), true);
    assert.equal(compactDue(on, COMPACT_EVERY_MS - 1, 0), false);
    assert.equal(compactDue(on, COMPACT_EVERY_MS, 0), true);
  });

  test('右键菜单的两项各对应一种请求', () => {
    assert.equal(menuRequest('碎碎念'), 'whisper');
    assert.equal(menuRequest('听一句'), 'listen');
    assert.equal(menuRequest('别的'), null);
  });

  test('只有桌宠宿主、配了模型、openai-compatible 才开对话渠道', () => {
    const openai = parseConfig({ llm: { provider: 'openai-compatible' } });
    const anthropic = parseConfig({ llm: { provider: 'anthropic' } });
    assert.equal(channelPlan(openai, 'dsh-pet', true), 'open');
    assert.equal(channelPlan(anthropic, 'dsh-pet', true), 'unsupported');
    assert.equal(channelPlan(openai, 'console', true), 'skip');
    assert.equal(channelPlan(openai, 'dsh-pet', false), 'skip');
  });
});

describe('daemon 一拍', () => {
  test('到点又安静：说一句，下一句隔一个间隔', async () => {
    const { tick, calls, state } = tickRig();
    await tick();
    assert.deepEqual(calls, ['sync', 'perform']);
    assert.equal(state.nextWhisper, T0 + 300_000);
  });

  test('收件箱里的请求交给导演；刚说过话，到点的碎碎念先让一下', async () => {
    const { tick, calls, state, app } = tickRig();
    enqueue(app.paths.inboxFile, 'listen');
    await tick();
    assert.deepEqual(calls, ['sync', 'listen']);
    assert.equal(state.lastTalk, T0);
    assert.equal(state.nextWhisper, T0 + 30_000);
    assert.ok(app.logger.lines.includes('碎碎念先让一下，等对话停 30 秒'));
    const delay = app.repos.activity.list(10).at(-1);
    assert.equal(delay?.type, 'delay');
    assert.equal(delay?.['until'], new Date(T0 + 30_000).toISOString());
    assert.deepEqual(drain(app.paths.inboxFile), [], '收件箱已经取空');
  });

  test('收件箱里的 whisper 直接说；说完听到回应也会顺延下一句', async () => {
    const { tick, calls, state, app, clock } = tickRig({
      state: { nextWhisper: T0 + 100_000 },
      director: {
        perform: async () => {
          calls.push('perform');
          return { line: LINE, talked: true };
        },
      },
    });
    enqueue(app.paths.inboxFile, 'whisper');
    await tick();
    assert.deepEqual(calls, ['sync', 'perform', 'memes']);
    assert.equal(state.lastTalk, T0);

    clock.now = T0 + 100_000;
    await tick();
    assert.equal(calls.at(-1), 'perform');
    assert.equal(state.lastTalk, T0 + 100_000);
    assert.equal(state.nextWhisper, T0 + 100_000 + 300_000);
  });

  test('到点的提醒说完也算说过话', async () => {
    const { tick, calls, state, app } = tickRig({ state: { nextWhisper: T0 + 10_000 } });
    const item: ScheduleItem = {
      id: 's_1',
      title: '喝水',
      kind: 'alarm',
      time: '15:00',
      date: null,
      repeat: 'daily',
      weekday: null,
      enabled: true,
      lastFired: null,
    };
    app.repos.schedule.insert(item);
    await tick();
    assert.deepEqual(calls, ['sync', 'remind:喝水']);
    assert.equal(state.lastTalk, T0);
  });

  test('离下一句还早就去找表情包；出错只记日志，10 分钟内不再找', async () => {
    let failing = true;
    const { tick, calls, app, clock, state } = tickRig({
      state: { nextWhisper: T0 + 2 * MEME_RETRY_MS },
      director: {
        refreshMemes: async () => {
          calls.push('memes');
          if (failing) throw new Error('anysearch 退出 1');
          return null;
        },
      },
    });
    await tick();
    assert.deepEqual(calls, ['sync', 'memes']);
    assert.ok(app.logger.lines.includes('anysearch 退出 1'));
    assert.equal(state.memeFailedAt, T0);

    clock.now = T0 + 1000;
    await tick();
    clock.now = T0 + MEME_RETRY_MS - 1;
    await tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 1, '10 分钟内不再找');

    failing = false;
    clock.now = T0 + MEME_RETRY_MS;
    await tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 2);
    assert.equal(state.memeFailedAt, null, '找成了就清掉失败时间');
    clock.now += 1000;
    await tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 3, '之后照常每拍看一眼');
  });

  test('到点的碎碎念没说成：记日志，一分钟后再试，不每秒重来', async () => {
    let failing = true;
    const { tick, calls, app, clock, state } = tickRig({
      director: {
        perform: async () => {
          calls.push('perform');
          if (failing) throw new Error('拿不到桌宠占用锁');
          return { line: LINE, talked: false };
        },
      },
    });
    await tick();
    assert.ok(app.logger.lines.includes('拿不到桌宠占用锁'));
    assert.equal(state.nextWhisper, T0 + WHISPER_RETRY_MS);

    clock.now = T0 + 1000;
    await tick();
    assert.equal(calls.filter((call) => call === 'perform').length, 1, '下一拍不再试');

    failing = false;
    clock.now = T0 + WHISPER_RETRY_MS;
    await tick();
    assert.equal(calls.filter((call) => call === 'perform').length, 2);
    assert.equal(state.nextWhisper, T0 + WHISPER_RETRY_MS + 300_000);
  });

  test('收件箱里的请求出错照旧：只记日志，不动下一句碎碎念的时间', async () => {
    const { tick, app, state } = tickRig({
      state: { nextWhisper: T0 + 100_000 },
      director: {
        perform: async () => {
          throw new Error('拿不到桌宠占用锁');
        },
      },
    });
    enqueue(app.paths.inboxFile, 'whisper');
    await tick();
    assert.ok(app.logger.lines.includes('拿不到桌宠占用锁'));
    assert.equal(state.nextWhisper, T0 + 100_000);
  });

  test('粘贴板打开时每拍记一下变化', async () => {
    const { tick, app } = tickRig({
      config: { clipboard: { enabled: true } },
      clipboard: { read: () => '复制的一段话' },
      state: { nextWhisper: T0 + 10_000 },
    });
    await tick();
    await tick();
    assert.deepEqual(
      app.repos.clipboard.list().map((entry) => entry.text),
      ['复制的一段话'],
    );
  });

  test('配了 compactAt 才看要不要压缩，10 分钟内只看一次', async () => {
    const { tick, calls, clock } = tickRig({
      config: { context: { compactAt: 1000 } },
      state: { nextWhisper: T0 + 10_000 },
    });
    await tick();
    clock.now += 1000;
    await tick();
    assert.equal(calls.filter((call) => call === 'compact').length, 1);
    clock.now = T0 + COMPACT_EVERY_MS;
    await tick();
    assert.equal(calls.filter((call) => call === 'compact').length, 2);

    const off = tickRig({ state: { nextWhisper: T0 + 10_000 } });
    await off.tick();
    assert.equal(off.calls.includes('compact'), false);
  });

  test('一拍出错只记日志，下一拍照常；上一拍没走完就跳过', async () => {
    let release: () => void = () => {};
    let slow = false;
    const { tick, calls, app } = tickRig({
      state: { nextWhisper: T0 + 10_000 },
      director: {
        syncPetChat: async () => {
          calls.push('sync');
          if (slow) await new Promise<void>((resolve) => (release = resolve));
          else throw new Error('数据库锁住了');
        },
      },
    });
    await tick();
    assert.ok(app.logger.lines.includes('数据库锁住了'));
    slow = true;
    const first = tick();
    await tick();
    release();
    await first;
    assert.equal(calls.filter((call) => call === 'sync').length, 2);
  });
});
