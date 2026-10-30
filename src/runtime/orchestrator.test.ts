import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore,
  type ConsolidateReport,
  type Context,
  type LanguageModel,
  type Memory,
  type Note,
  type OrchestratorEvent,
} from '@modelctx-ai/ctx';
import { createMemoryStore as createNoteStore } from '@modelctx-ai/ctx-memory';
import { createScriptedModel, describeOrchestratorContract } from '@modelctx-ai/ctx/testing';
import { MockLanguageModelV4 } from 'ai/test';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { petChatEntries, sessionFor, yoyoProjection } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import type { YoyoMemory } from '../brain/memory.ts';
import type { AgentTask, ScheduleItem } from '../kernel/types.ts';
import type { Clipboard, Repos } from '../ports/index.ts';
import type { Director } from './director.ts';
import { drain, enqueue } from './inbox.ts';
import {
  COMPACT_EVERY_MS,
  CONSOLIDATED_KEY,
  CONSOLIDATE_IDLE_MS,
  MEME_RETRY_MS,
  WHISPER_RETRY_MS,
  WORKBENCH_SOURCE,
  compactDue,
  consolidateDue,
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
    readonly memory?: YoyoMemory;
    /** 编排器建好之前先往库里放东西。 */
    readonly seed?: (repos: Repos) => void;
  } = {},
): OrchestratorRig {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const calls: string[] = [];
  const clock = { now: T0 };
  const logger = memoryLogger();
  const repos = memoryRepos({ now: () => new Date(clock.now) });
  options.seed?.(repos);
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
    ...(options.memory ? { memory: options.memory } : {}),
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
        syncPetChat: async () => {
          calls.push('sync');
          return 0;
        },
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

  test('memes.enabled 关掉时空闲也不去找表情包', async () => {
    const calls: string[] = [];
    const { orchestrator } = orchestratorRig({
      state: { nextWhisper: T0 + 2 * MEME_RETRY_MS },
      config: { memes: { enabled: false } },
      director: {
        syncPetChat: async () => {
          calls.push('sync');
          return 0;
        },
        refreshMemes: async () => {
          calls.push('memes');
          return null;
        },
      },
    });
    await orchestrator.tick();
    assert.deepEqual(calls, ['sync']);
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
          return 0;
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

  test('右键对话：主人这句放进最后一条临时用户消息，经回复的 agent 跑一轮，日志里不写；算作说过话', async () => {
    const model = createScriptedModel([{ type: 'text', text: '带伞了\n记得早点回来' }]);
    const { orchestrator, context, logger, state, clock } = orchestratorRig({ model });
    await context.append(...petChatEntries([{ role: 'user', content: '昨天说过要带伞', ts: T0 - 60_000 }]));
    const before = await context.entries();
    clock.now = T0 + 5_000;
    assert.equal(await orchestrator.chat('今天呢'), '带伞了\n记得早点回来');
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    assert.match(prompt, /昨天说过要带伞[\s\S]*今天呢/);
    assert.deepEqual(await context.entries(), before, '问答由桌宠记，下一拍并进来');
    assert.equal(state.lastTalk, T0 + 5_000);
    assert.ok(logger.lines.includes('右键对话回了 10 字'), logger.lines.join('\n'));
    await orchestrator.close();
  });

  test('工作台聊一句：和右键对话同一个 agent，问答记进日志（来源 workbench），记一笔', async () => {
    const model = createScriptedModel([{ type: 'text', text: '带了' }]);
    const { orchestrator, context, repos, state, clock } = orchestratorRig({ model });
    clock.now = T0 + 5_000;
    assert.equal(await orchestrator.talk('伞带了吗'), '带了');
    const entries = await context.entries();
    assert.deepEqual(
      entries.map((entry) => (entry.type === 'message' ? `${entry.message.role}:${entry.source}:${entry.at}` : '')),
      [`user:${WORKBENCH_SOURCE}:${T0 + 5_000}`, `assistant:${WORKBENCH_SOURCE}:${T0 + 5_001}`],
    );
    assert.equal(state.lastTalk, T0 + 5_000);
    assert.deepEqual(
      repos.activity.list(10).map((event) => event.type),
      ['chat-workbench'],
    );
    await assert.rejects(orchestratorRig().orchestrator.talk('在吗'));
    await orchestrator.close();
  });

  test('子任务结束：叫醒主线程，把 <task-notification> 交给回复的 agent，它的转告由桌宠说出来；取消的不叫醒', async () => {
    const model = createScriptedModel([
      { type: 'text', text: '周报整理好了，三个项目都写进去了。' },
      { type: 'text', text: '资料没查成，得给我那个文档的权限。' },
    ]);
    const { orchestrator, calls, repos } = orchestratorRig({ model, state: { nextWhisper: T0 + 3_600_000 } });
    const finished = (title: string, state: 'done' | 'failed' | 'cancelled', patch: Partial<AgentTask> = {}) => {
      const task = repos.agentTasks.create({ title, goal: '目标', criteria: [], origin: 'main' }, T0);
      repos.agentTasks.update(task.id, { state, finishedAt: T0, ...patch }, T0);
      orchestrator.relayTask(task.id);
      return task.id;
    };
    finished('周报', 'done', { result: 'A 上线\nB 在测' });
    finished('查资料', 'failed', { error: '没有权限' });
    finished('算了', 'cancelled');
    await orchestrator.tick();
    assert.deepEqual(
      calls.filter((call) => call.startsWith('speak:')),
      ['speak:周报整理好了，三个项目都写进去了。', 'speak:资料没查成，得给我那个文档的权限。'],
    );
    const first = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    assert.match(first, /<task-notification>.*<task-id>1<\/task-id>.*<status>completed<\/status>.*<result>.*A 上线/);
    assert.match(first, /用一两句话把结论告诉主人/);
    assert.match(
      JSON.stringify(model.doGenerateCalls[1]?.prompt),
      /<status>failed<\/status>.*<error>没有权限<\/error>/,
    );
    assert.ok(repos.agentTasks.list().every((task) => task.announcedAt !== null));
    await orchestrator.tick();
    assert.equal(calls.filter((call) => call.startsWith('speak:')).length, 2, '转告过的不再说');
    await orchestrator.close();
  });

  test('子任务结束：没配模型就报一声固定的；tasks.notify 关着只记下不说；上次没转告的开始时补上', async () => {
    const seed = (repos: Repos) => {
      const task = repos.agentTasks.create({ title: '周报', goal: '目标', criteria: [], origin: 'main' }, T0);
      repos.agentTasks.update(task.id, { state: 'done', finishedAt: T0 }, T0);
    };
    const plain = orchestratorRig({ seed, state: { nextWhisper: T0 + 3_600_000 } });
    await plain.orchestrator.tick();
    assert.deepEqual(
      plain.calls.filter((call) => call.startsWith('speak:')),
      ['speak:「周报」做好啦，结果放在工作台里。'],
    );

    const quiet = orchestratorRig({
      seed,
      config: { tasks: { notify: false } },
      state: { nextWhisper: T0 + 3_600_000 },
    });
    await quiet.orchestrator.tick();
    assert.deepEqual(
      quiet.calls.filter((call) => call.startsWith('speak:')),
      [],
    );
    assert.notEqual(quiet.repos.agentTasks.get(1)?.announcedAt, null);
  });

  test('右键对话：没配模型就报错；调用方取消就停', async () => {
    await assert.rejects(orchestratorRig().orchestrator.chat('在吗'), { message: '没配 llm，右键对话回不了' });
    const { orchestrator } = orchestratorRig({ model: createScriptedModel([{ type: 'text', text: '在呢' }]) });
    await assert.rejects(orchestrator.chat('在吗', AbortSignal.abort()));
    await orchestrator.close();
  });

  test('桌宠自己的碎碎念交给碎碎念的 agent，日志里不写', async () => {
    const model = createScriptedModel([{ type: 'text', text: '「主人写了好久代码，喝口水吧」' }]);
    const { orchestrator, context } = orchestratorRig({ model });
    assert.equal(await orchestrator.petWhisper(), '主人写了好久代码，喝口水吧');
    assert.deepEqual(await context.entries(), []);
    await orchestrator.close();
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

const REPORT: ConsolidateReport = {
  notes: 2,
  facts: { added: 1, merged: 0, superseded: 1, archived: 0 },
  procedures: { added: 0, confirmed: 0 },
  escalated: 0,
  core: true,
};

interface FakeMemory extends YoyoMemory {
  readonly gates: string[];
  readonly consolidations: number[];
  /** 下一次 gate 卡住，直到 resolve。 */
  hold(): { resolve(): void };
  fail(what: 'gate' | 'consolidate', error: Error): void;
}

/** 只记调用的记忆：笔记存储是真的，gate、consolidate 可以卡住或失败。 */
function fakeMemory(): FakeMemory {
  const store = createNoteStore();
  const gates: string[] = [];
  const consolidations: number[] = [];
  let held: PromiseWithResolvers<void> | null = null;
  const failures: { gate?: Error; consolidate?: Error } = {};
  const memory = {
    name: 'memory',
    async gate(session: string): Promise<Note[]> {
      gates.push(session);
      if (held) await held.promise;
      if (failures.gate) throw failures.gate;
      return [];
    },
    async consolidate(options?: { readonly now?: number }): Promise<ConsolidateReport> {
      consolidations.push(options?.now ?? 0);
      if (failures.consolidate) throw failures.consolidate;
      return REPORT;
    },
  } as unknown as Memory;
  return {
    memory,
    store,
    gates,
    consolidations,
    hold() {
      held = Promise.withResolvers<void>();
      const current = held;
      return {
        resolve: () => {
          held = null;
          current.resolve();
        },
      };
    },
    fail(what, error) {
      failures[what] = error;
    },
  };
}

async function pendingNote(memory: YoyoMemory): Promise<void> {
  await memory.store.notes.add([{ session: 'pet:main', from: 1, upTo: 1, at: T0, salience: 0.9 }]);
}

/** 让后台的门控、整理跑完。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 2026-10-24 的本地时刻。 */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 24, hour, minute);
}

describe('orchestrator 记忆', () => {
  test('整理的条件：到了时间、今天没整理过、主人 30 分钟没说话', () => {
    const quiet = 0;
    assert.equal(consolidateDue('03:00', at(2, 59), quiet, null), false, '没到点');
    assert.equal(consolidateDue('03:00', at(3, 0), quiet, null), true);
    assert.equal(consolidateDue('03:00', at(9, 30), quiet, null), true, '夜里没机会，过了点照样整理');
    assert.equal(consolidateDue('03:00', at(3, 0), quiet, '2026-10-24'), false, '今天整理过');
    assert.equal(consolidateDue('03:00', at(3, 0), quiet, '2026-10-23'), true);
    const now = at(3, 30).getTime();
    assert.equal(consolidateDue('03:00', at(3, 30), now - CONSOLIDATE_IDLE_MS + 1, null), false, '主人刚说过话');
    assert.equal(consolidateDue('03:00', at(3, 30), now - CONSOLIDATE_IDLE_MS, null), true);
    assert.equal(consolidateDue('4:30', at(4, 29), quiet, null), false);
    assert.equal(consolidateDue('坏的', at(4, 29), quiet, null), false);
  });

  test('没写过用户话或回复就不门控；桌宠对话并进新条目才门控，不等它跑完', async () => {
    let fresh = 0;
    const memory = fakeMemory();
    const { orchestrator, clock } = orchestratorRig({
      memory,
      state: { nextWhisper: T0 + 600_000 },
      director: { syncPetChat: async () => fresh },
    });
    await orchestrator.tick();
    assert.deepEqual(memory.gates, [], '这一拍什么都没写');

    fresh = 2;
    const held = memory.hold();
    clock.now += 1000;
    await orchestrator.tick();
    assert.deepEqual(memory.gates, ['pet:main'], '拍子没等门控就走完了');

    clock.now += 1000;
    await orchestrator.tick();
    assert.equal(memory.gates.length, 1, '上一次没完就跳过这次');

    held.resolve();
    await settle();
    fresh = 0;
    clock.now += 1000;
    await orchestrator.tick();
    assert.equal(memory.gates.length, 2, '跳过的那次留到下一拍补上');
    await settle();
    clock.now += 1000;
    await orchestrator.tick();
    assert.equal(memory.gates.length, 2, '补上以后没有新写的就不再跑');
    await orchestrator.close();
  });

  test('听到一句并回复：记下用户话以后门控；出错只记一行，密钥抹掉', async () => {
    const memory = fakeMemory();
    memory.fail('gate', new Error('decide failed: key sk-memory-1\nretry later'));
    const { orchestrator, logger, paths } = orchestratorRig({
      memory,
      config: { llm: { apiKey: 'sk-memory-1' } },
      model: createScriptedModel([{ type: 'text', text: '好的，我记住了' }]),
      state: { nextWhisper: T0 + 600_000 },
    });
    enqueue(paths.inboxFile, 'listen');
    await orchestrator.tick();
    await settle();
    assert.deepEqual(memory.gates, ['pet:main']);
    assert.ok(logger.lines.includes('记忆门控没做成：decide failed: key *** retry later'), logger.lines.join('\n'));
    await orchestrator.close();
  });

  test('记忆模型的密钥也从报错里抹掉，不进记录', async () => {
    const memory = fakeMemory();
    memory.fail('gate', new Error('clef-flash 401: token cf-decide-key rejected'));
    const { orchestrator, logger, repos } = orchestratorRig({
      memory,
      config: {
        memory: {
          decision: { provider: 'cloudflare', model: 'clef-flash', accountId: 'acc', apiKey: 'cf-decide-key' },
        },
      },
      director: { syncPetChat: async () => 1 },
      state: { nextWhisper: T0 + 600_000 },
    });
    await orchestrator.tick();
    await settle();
    assert.ok(logger.lines.includes('记忆门控没做成：clef-flash 401: token *** rejected'), logger.lines.join('\n'));
    assert.ok(!JSON.stringify(repos.activity.list(50)).includes('cf-decide-key'));
    await orchestrator.close();
  });

  test('没开记忆：拍子里不门控也不整理', async () => {
    const { orchestrator, repos } = orchestratorRig({
      director: { syncPetChat: async () => 3 },
      state: { nextWhisper: T0 + 600_000 },
    });
    await orchestrator.tick();
    assert.equal(repos.kv.get(CONSOLIDATED_KEY), null);
  });

  test('到点、主人不在、有待处理的笔记才整理；成功记一件做过的事，今天不再整理', async () => {
    const memory = fakeMemory();
    let fresh = 0;
    const { orchestrator, clock, state, repos, logger } = orchestratorRig({
      memory,
      config: { memory: { consolidateAt: '15:10' } },
      state: { nextWhisper: T0 + 24 * 3600_000 },
      director: { syncPetChat: async () => fresh },
    });
    await orchestrator.tick();
    await settle();
    assert.deepEqual(memory.consolidations, [], '15:00 还没到 15:10');

    clock.now = T0 + 10 * 60_000;
    await orchestrator.tick();
    await settle();
    assert.deepEqual(memory.consolidations, [], '没有待处理的笔记');

    // 门控写下待处理的笔记以后又会去看
    await pendingNote(memory);
    state.lastTalk = clock.now - 60_000;
    const gate = memory.memory.gate.bind(memory.memory);
    memory.memory.gate = async (session) => {
      await gate(session);
      return memory.store.notes.list({ pending: true });
    };
    fresh = 1;
    clock.now += 1000;
    await orchestrator.tick();
    await settle();
    fresh = 0;
    assert.equal(memory.gates.length, 1);
    assert.deepEqual(memory.consolidations, [], '主人一分钟前还在说话');

    clock.now = state.lastTalk + CONSOLIDATE_IDLE_MS;
    await orchestrator.tick();
    await settle();
    assert.deepEqual(memory.consolidations, [clock.now]);
    assert.equal(repos.kv.get(CONSOLIDATED_KEY), '2026-10-24');
    const done = repos.activity.list(5).at(-1);
    assert.equal(done?.type, 'memory-consolidate');
    assert.deepEqual([done?.['notes'], done?.['added'], done?.['superseded'], done?.['core']], [2, 1, 1, true]);
    assert.ok(logger.lines.includes('没配 llm：记忆整理只做衰减归档和画像的缺省渲染，反思和画像重写跳过'));
    assert.ok(logger.lines.includes('记忆整理了 2 条笔记：新增 1 条事实，并入 0，取代 1，归档 0'));

    clock.now += 3600_000;
    await orchestrator.tick();
    await settle();
    assert.equal(memory.consolidations.length, 1, '今天整理过了');

    clock.now = new Date(2026, 9, 25, 15, 30).getTime();
    await orchestrator.tick();
    await settle();
    assert.equal(memory.consolidations.length, 2, '第二天照样整理');
    await orchestrator.close();
  });

  test('整理失败只记一行，今天不再试，第二天再试', async () => {
    const memory = fakeMemory();
    memory.fail('consolidate', new Error('extract failed'));
    await pendingNote(memory);
    const { orchestrator, clock, logger, repos } = orchestratorRig({
      memory,
      model: createScriptedModel([]),
      state: { nextWhisper: T0 + 24 * 3600_000 },
    });
    await orchestrator.tick();
    await settle();
    assert.equal(memory.consolidations.length, 1);
    assert.ok(logger.lines.includes('记忆没整理成：extract failed'));
    assert.ok(!logger.lines.some((line) => line.startsWith('没配 llm')), '有模型就不警告');
    assert.equal(repos.kv.get(CONSOLIDATED_KEY), null);

    clock.now += 60_000;
    await orchestrator.tick();
    await settle();
    assert.equal(memory.consolidations.length, 1, '今天不再试');

    clock.now += 24 * 3600_000;
    await orchestrator.tick();
    await settle();
    assert.equal(memory.consolidations.length, 2);
    await orchestrator.close();
  });
});
