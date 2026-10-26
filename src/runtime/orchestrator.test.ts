import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore,
  type Context,
  type LanguageModel,
  type OrchestratorEvent,
} from '@modelctx-ai/ctx';
import { createScriptedModel, describeOrchestratorContract } from '@modelctx-ai/ctx/testing';
import { MockLanguageModelV4 } from 'ai/test';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { sessionFor, yoyoProjection } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import type { ScheduleItem } from '../kernel/types.ts';
import type { Clipboard } from '../ports/index.ts';
import type { Director } from './director.ts';
import { drain, enqueue } from './inbox.ts';
import {
  COMPACT_EVERY_MS,
  MEME_RETRY_MS,
  WHISPER_RETRY_MS,
  compactDue,
  createYoyoOrchestrator,
  memeDue,
  memeIdle,
  nextAfterSpeak,
  whisperIntervalMs,
  whisperStep,
  type ScheduleState,
  type YoyoOrchestrator,
} from './orchestrator.ts';
import { fakeDirector, memoryLogger, memoryRepos, type MemoryLogger } from './testing.ts';

interface OrchestratorRig {
  readonly orchestrator: YoyoOrchestrator;
  readonly context: Context;
  readonly logger: MemoryLogger;
  readonly calls: string[];
  readonly state: ScheduleState;
  readonly clock: { now: number };
  readonly repos: ReturnType<typeof memoryRepos>;
  readonly paths: ReturnType<typeof resolvePaths>;
}

/** 周六下午三点，没有天气也没有闹钟。 */
const T0 = new Date(2026, 9, 24, 15, 0, 0).getTime();

function orchestratorRig(
  options: {
    readonly config?: Record<string, unknown>;
    readonly director?: Partial<Director>;
    readonly state?: Partial<ScheduleState>;
    readonly clipboard?: Clipboard;
    readonly model?: LanguageModel | null;
  } = {},
): OrchestratorRig {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const calls: string[] = [];
  const clock = { now: T0 };
  const logger = memoryLogger();
  const repos = memoryRepos({ now: () => new Date(clock.now) });
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  const context = createContext({
    store: createMemoryStore({ now: () => clock.now }),
    session: sessionFor('main'),
    projection: yoyoProjection,
  });
  const orchestrator = createYoyoOrchestrator({
    config: parseConfig({ clipboard: { enabled: false }, ...options.config }),
    paths,
    logger,
    repos,
    clipboard: options.clipboard ?? { read: () => '' },
    search: null,
    context,
    harness: createYoyoHarness(context),
    director: fakeDirector(calls, options.director),
    model: options.model ?? null,
    clock: () => clock.now,
    state: { nextWhisper: T0, ...options.state },
  });
  return { orchestrator, context, logger, calls, state: orchestrator.state, clock, repos, paths };
}

describeOrchestratorContract(
  'yoyo',
  ({ script }) => {
    const { orchestrator, context } = orchestratorRig();
    return { orchestrator, store: context.store, agent: { model: createScriptedModel(script) } };
  },
  { describe, test },
);

describe('orchestrator 节奏', () => {
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
});

describe('orchestrator 一拍', () => {
  test('到点又安静：说一句，下一句隔一个间隔', async () => {
    const { orchestrator, calls, state } = orchestratorRig();
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync', 'speak:我在呢']);
    assert.equal(state.nextWhisper, T0 + 300_000);
  });

  test('收件箱里的请求交给导演；刚说过话，到点的碎碎念先让一下', async () => {
    const { orchestrator, calls, state, logger, repos, paths } = orchestratorRig();
    enqueue(paths.inboxFile, 'listen');
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync', 'hear']);
    assert.equal(state.lastTalk, T0);
    assert.equal(state.nextWhisper, T0 + 30_000);
    assert.ok(logger.lines.includes('碎碎念先让一下，等对话停 30 秒'));
    const delay = repos.activity.list(10).at(-1);
    assert.equal(delay?.type, 'delay');
    assert.equal(delay?.['until'], new Date(T0 + 30_000).toISOString());
    assert.deepEqual(drain(paths.inboxFile), [], '收件箱已经取空');
  });

  test('收件箱里的 whisper 直接说；说完听到回应也会顺延下一句', async () => {
    const { orchestrator, calls, state, paths, clock } = orchestratorRig({
      state: { nextWhisper: T0 + 100_000 },
      config: { listen: { enabled: true } },
      // 有模型才听；主人在确认页取消也算说过话，这一轮模型用不到
      model: createScriptedModel([]),
      director: {
        hear: async () => {
          calls.push('hear');
          return '';
        },
      },
    });
    enqueue(paths.inboxFile, 'whisper');
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync', 'speak:我在呢', 'hear', 'memes']);
    assert.equal(state.lastTalk, T0);

    clock.now = T0 + 100_000;
    await orchestrator.tick();
    assert.equal(calls.at(-1), 'hear');
    assert.equal(state.lastTalk, T0 + 100_000);
    assert.equal(state.nextWhisper, T0 + 100_000 + 300_000);
  });

  test('到点的提醒说完也算说过话', async () => {
    const { orchestrator, calls, state, repos } = orchestratorRig({ state: { nextWhisper: T0 + 10_000 } });
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
    repos.schedule.insert(item);
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync', 'remind:喝水']);
    assert.equal(state.lastTalk, T0);
  });

  test('离下一句还早就去找表情包；出错只记日志，10 分钟内不再找', async () => {
    let failing = true;
    const calls: string[] = [];
    const { orchestrator, logger, clock, state } = orchestratorRig({
      state: { nextWhisper: T0 + 2 * MEME_RETRY_MS },
      director: {
        syncPetChat: async () => void calls.push('sync'),
        refreshMemes: async () => {
          calls.push('memes');
          if (failing) throw new Error('anysearch 退出 1');
          return null;
        },
      },
    });
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync', 'memes']);
    assert.ok(logger.lines.includes('anysearch 退出 1'));
    assert.equal(state.memeFailedAt, T0);

    clock.now = T0 + 1000;
    await orchestrator.tick();
    clock.now = T0 + MEME_RETRY_MS - 1;
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 1, '10 分钟内不再找');

    failing = false;
    clock.now = T0 + MEME_RETRY_MS;
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 2);
    assert.equal(state.memeFailedAt, null, '找成了就清掉失败时间');
    clock.now += 1000;
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call === 'memes').length, 3, '之后照常每拍看一眼');
  });

  test('到点的碎碎念没说成：记日志，一分钟后再试，不每秒重来', async () => {
    let failing = true;
    const spoken: string[] = [];
    const { orchestrator, logger, clock, state } = orchestratorRig({
      director: {
        speak: async (line) => {
          spoken.push(line.text);
          if (failing) throw new Error('拿不到桌宠占用锁');
        },
      },
    });
    await orchestrator.tick();
    assert.ok(logger.lines.includes('拿不到桌宠占用锁'));
    assert.equal(state.nextWhisper, T0 + WHISPER_RETRY_MS);

    clock.now = T0 + 1000;
    await orchestrator.tick();
    assert.equal(spoken.length, 1, '下一拍不再试');

    failing = false;
    clock.now = T0 + WHISPER_RETRY_MS;
    await orchestrator.tick();
    assert.equal(spoken.length, 2);
    assert.equal(state.nextWhisper, T0 + WHISPER_RETRY_MS + 300_000);
  });

  test('收件箱里的请求出错照旧：只记日志，不动下一句碎碎念的时间', async () => {
    const { orchestrator, logger, state, paths } = orchestratorRig({
      state: { nextWhisper: T0 + 100_000 },
      director: {
        speak: async () => {
          throw new Error('拿不到桌宠占用锁');
        },
      },
    });
    enqueue(paths.inboxFile, 'whisper');
    await orchestrator.tick();
    assert.ok(logger.lines.includes('拿不到桌宠占用锁'));
    assert.equal(state.nextWhisper, T0 + 100_000);
  });

  test('粘贴板打开时每拍记一下变化', async () => {
    const { orchestrator, repos } = orchestratorRig({
      config: { clipboard: { enabled: true } },
      clipboard: { read: () => '复制的一段话' },
      state: { nextWhisper: T0 + 10_000 },
    });
    await orchestrator.tick();
    await orchestrator.tick();
    assert.deepEqual(
      repos.clipboard.list().map((entry) => entry.text),
      ['复制的一段话'],
    );
  });

  test('配了 compactAt 才看要不要压缩，10 分钟内只看一次', async () => {
    const { orchestrator, calls, clock } = orchestratorRig({
      config: { context: { compactAt: 1000 } },
      state: { nextWhisper: T0 + 10_000 },
    });
    await orchestrator.tick();
    clock.now += 1000;
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call === 'compact').length, 1);
    clock.now = T0 + COMPACT_EVERY_MS;
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call === 'compact').length, 2);

    const off = orchestratorRig({ state: { nextWhisper: T0 + 10_000 } });
    await off.orchestrator.tick();
    assert.equal(off.calls.includes('compact'), false);
  });

  test('一拍出错只记日志，下一拍照常；上一拍没走完就跳过', async () => {
    const gate = Promise.withResolvers<void>();
    let slow = false;
    const calls: string[] = [];
    const { orchestrator, logger } = orchestratorRig({
      state: { nextWhisper: T0 + 10_000 },
      director: {
        syncPetChat: async () => {
          calls.push('sync');
          if (slow) await gate.promise;
          else throw new Error('数据库锁住了');
        },
      },
    });
    await orchestrator.tick();
    assert.ok(logger.lines.includes('数据库锁住了'));
    slow = true;
    const first = orchestrator.tick();
    await orchestrator.tick();
    gate.resolve();
    await first;
    assert.equal(calls.filter((call) => call === 'sync').length, 2);
  });
});

describe('orchestrator 跑模型', () => {
  test('预制台词说完了：碎碎念这一轮经 submit 交给 harness，events 看得到，日志里一条都不写', async () => {
    const model = createScriptedModel([{ type: 'text', text: '主人写了好久代码，喝口水吧' }]);
    const { orchestrator, calls, context, logger } = orchestratorRig({ model, director: { choose: async () => null } });
    const controller = new AbortController();
    const seen: OrchestratorEvent[] = [];
    const reading = (async () => {
      for await (const event of orchestrator.events({ signal: controller.signal })) {
        seen.push(event);
        if (event.type === 'run.completed') controller.abort();
      }
    })();
    const result = await orchestrator.whisper();
    await reading;
    assert.equal(result?.line.text, '主人写了好久代码，喝口水吧');
    assert.deepEqual(calls, ['speak:主人写了好久代码，喝口水吧']);
    assert.ok(logger.lines.includes('预制台词用完了，按最近的对话和任务写一句'));
    assert.deepEqual(
      seen.map((event) => [event.type, event.session]),
      [
        ['run.queued', 'pet:main'],
        ['run.running', 'pet:main'],
        ['run.completed', 'pet:main'],
      ],
    );
    assert.equal(await orchestrator.status(seen[0]!.runId), 'completed');
    assert.deepEqual(await context.entries(), [], 'record: false；说出口以后由导演记');
    await orchestrator.close();
  });

  test('没有模型、预制台词也说完了：这次先停，不跑模型', async () => {
    const { orchestrator, calls, repos, logger } = orchestratorRig({ director: { choose: async () => null } });
    assert.equal(await orchestrator.whisper(), null);
    assert.deepEqual(calls, []);
    assert.ok(logger.lines.includes('这 3 小时里的碎碎念都说过了，这次先停'));
    assert.deepEqual(
      repos.activity.list(10).map((event) => event.type),
      ['whisper-skip'],
    );
  });

  test('start 每秒一拍；停下时正在跑的模型一起取消，close 不用等它跑完', async () => {
    const called = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        called.resolve();
        return new Promise((_, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
        });
      },
    });
    const { orchestrator, logger, state } = orchestratorRig({ model, director: { choose: async () => null } });
    const controller = new AbortController();
    orchestrator.start(controller.signal);
    await called.promise;
    controller.abort();
    await orchestrator.close();
    // 停下以后这一拍收尾：记一行，一分钟后再试
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(logger.lines.some((line) => line.startsWith('模型没回：')));
    assert.equal(state.nextWhisper, T0 + WHISPER_RETRY_MS);
    await assert.rejects(
      orchestrator.submit({ session: 'pet:main', agent: { model }, input: '在吗' }),
      /closed/,
      'close 以后不收',
    );
  });
});
