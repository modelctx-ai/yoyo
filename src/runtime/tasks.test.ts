import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, createOrchestrator, type Context } from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { createTaskContext, mainProjection, sessionFor, taskSession } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import { addTaskWorkerTools, createYoyoTools } from '../brain/tools.ts';
import { mergeAgents, parseAgentFile } from '../features/tasks/agents.ts';
import { cancelAgentTask, createAgentTask } from '../features/tasks/tasks.ts';
import type { Repos } from '../ports/index.ts';
import { MAX_ROUNDS, createTaskRunner } from './tasks.ts';
import { createArtifactFiles } from '../storage/artifacts.ts';
import { memoryLogger, memoryRepos } from './testing.ts';

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const T0 = new Date(2026, 9, 30, 15, 0, 0).getTime();

function text(value: string): DoGenerateResult {
  return {
    content: [{ type: 'text', text: value }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

function call(name: string, input: unknown): DoGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: `${name}-${JSON.stringify(input).length}`,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

/** 按顺序回这些；用完了就一直说「还在做」。 */
function scripted(steps: readonly DoGenerateResult[], prompts: unknown[] = []): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const step = steps[index] ?? text('还在做');
      index += 1;
      return step;
    },
  });
}

interface Rig {
  readonly repos: Repos;
  readonly main: Context;
  readonly runner: ReturnType<typeof createTaskRunner>;
  readonly logger: ReturnType<typeof memoryLogger>;
  /** 每次叫一声时，结果是不是已经在主会话里。 */
  readonly finished: Promise<boolean>[];
}

function rig(model: MockLanguageModelV4 | null, concurrency?: number): Rig {
  const repos = memoryRepos({ now: () => new Date(T0) });
  const logger = memoryLogger();
  const main = createContext({ store: createMemoryStore(), session: sessionFor('main'), projection: mainProjection });
  const worker = createYoyoTools({ repos, search: null });
  const files = createArtifactFiles(join(mkdtempSync(join(tmpdir(), 'yoyo-tasks-')), 'artifacts'));
  addTaskWorkerTools(worker, { repos, now: () => new Date(T0), files });
  const harness = createYoyoHarness(createTaskContext(main, { tools: worker }));
  const runs = createOrchestrator({ harness, store: main.store, owner: 'yoyo-tasks' });
  const finished: Promise<boolean>[] = [];
  const runner = createTaskRunner({
    repos,
    logger,
    runs,
    model,
    main,
    now: () => T0,
    pollMs: 5,
    ...(concurrency ? { concurrency } : {}),
    // 叫一声的那一刻，结果已经在主会话里了
    onFinished: (task) => {
      finished.push(
        main
          .entries()
          .then((entries) => entries.some((entry) => entry.type === 'event' && entry.meta?.['id'] === task.id)),
      );
    },
  });
  return { repos, main, runner, logger, finished };
}

function brief(repos: Repos) {
  return createAgentTask(
    repos,
    { title: '整理周报', goal: '把本周进展整理成周报', criteria: ['三个项目都有'], origin: 'main' },
    new Date(T0),
  );
}

const CHECKS = [{ criterion: '三个项目都有', met: true, evidence: 'A、B、C 各一段' }];

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
}

/**
 * 几个子任务一起跑时用的模型：认出是哪个子任务，等放行了才交结果；`broken` 里的一开始就出错。
 * 交了以后（会话里有工具结果了）说一句就停。
 */
function gated(broken: readonly number[] = []) {
  const started: number[] = [];
  const gates = new Map<number, () => void>();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const id = Number(/子任务 #(\d+)/.exec(JSON.stringify(options.prompt))?.[1]);
      if (options.prompt.some((message) => message.role === 'tool')) return text('交好了');
      started.push(id);
      if (broken.includes(id)) throw new Error('connect ECONNREFUSED');
      await new Promise<void>((resolve, reject) => {
        gates.set(id, resolve);
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      });
      return call('task_finish', { id, result: `#${id} 做好了`, checks: CHECKS });
    },
  });
  const release = (id: number): void => gates.get(id)?.();
  return { model, started, release, waiting: (id: number) => gates.has(id) };
}

describe('子任务的跑法', () => {
  test('拆 todo、边做边标、对完验收交结果；记在自己的会话里，结果写回主线程', async () => {
    const prompts: unknown[] = [];
    const model = scripted(
      [
        call('task_plan', { id: 1, todos: ['收集进展', '写成周报'] }),
        call('task_todo', { id: 1, index: 1, state: 'done', note: '问到了' }),
        call('task_deliver', { id: 1, name: '周报.md', content: '# 周报' }),
        call('task_todo', { id: 1, index: 2, state: 'done' }),
        call('task_finish', { id: 1, result: 'A 上线\nB 在测\nC 排期', checks: CHECKS }),
        text('交好了'),
      ],
      prompts,
    );
    const { repos, main, runner, finished } = rig(model);
    brief(repos);
    const done = await runner.runNext();
    assert.equal(done?.state, 'done');
    assert.deepEqual(await Promise.all(finished), [true], '写回主会话以后才叫醒主线程');
    assert.equal(done?.result, 'A 上线\nB 在测\nC 排期');
    assert.deepEqual(
      done?.todos.map((todo) => todo.state),
      ['done', 'done'],
    );
    assert.equal(done?.startedAt, T0);
    assert.match(JSON.stringify(prompts[0]), /子任务 #1：整理周报/);
    assert.match(JSON.stringify(prompts[0]), /先用 task_plan 把任务拆成 todo/);

    const steps = await main.store.list(taskSession(1));
    assert.ok(
      steps.some((entry) => entry.type === 'message' && entry.message.role === 'user'),
      '任务说明记进自己的会话',
    );
    assert.ok(steps.filter((entry) => entry.type === 'message' && entry.message.role === 'tool').length >= 4);

    const back = await main.entries();
    assert.equal(back.length, 1);
    const event = back[0]!;
    assert.equal(event.type, 'event');
    assert.match(event.type === 'event' ? (event.text ?? '') : '', /子任务 #1「整理周报」做完了。\n结果：\nA 上线/);
    assert.match(event.type === 'event' ? (event.text ?? '') : '', /\n交付物（在工作台里）：周报\.md（8 B）$/);
    const { messages } = await main.view();
    assert.match(JSON.stringify(messages), /系统消息：子任务 #1/);
    assert.equal(await runner.runNext(), null, '没有排队的了');
  });

  test('按子任务的类型配子 agent：指令接在协议后面，只给清单里的工具加任务工具，类型写了 model 就换模型', async () => {
    const prompts: unknown[] = [];
    const offered: string[][] = [];
    const spy = (name: string) =>
      new MockLanguageModelV4({
        modelId: name,
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          offered.push((options.tools ?? []).map((item) => item.name));
          return text('交不了');
        },
      });
    const repos = memoryRepos({ now: () => new Date(T0) });
    const main = createContext({ store: createMemoryStore(), session: sessionFor('main'), projection: mainProjection });
    const worker = createYoyoTools({ repos, search: null });
    addTaskWorkerTools(worker, { repos, now: () => new Date(T0) });
    const harness = createYoyoHarness(createTaskContext(main, { tools: worker }));
    const runs = createOrchestrator({ harness, store: main.store, owner: 'yoyo-tasks' });
    const asked: string[] = [];
    const agents = mergeAgents([
      parseAgentFile(
        '---\nname: scheduler\ndescription: 排日程\ntools: list_alarms, add_*\nmodel: small\n---\n只管日程。',
        'scheduler',
        's.md',
      ),
    ]);
    const runner = createTaskRunner({
      repos,
      logger: memoryLogger(),
      runs,
      model: spy('default'),
      main,
      now: () => T0,
      pollMs: 5,
      agents,
      toolNames: () => worker.list().map((definition) => definition.name),
      modelFor: (id) => {
        asked.push(id);
        return spy(id);
      },
    });
    createAgentTask(repos, { title: '排周会', goal: '每周一 10 点', agent: 'scheduler', origin: 'main' }, new Date(T0));
    await runner.runNext();
    assert.deepEqual(asked, ['small']);
    assert.match(JSON.stringify(prompts[0]), /先用 task_plan.*你是「scheduler」子 agent。\\n只管日程。/);
    assert.deepEqual(offered[0]?.toSorted(), [
      'add_alarm',
      'list_alarms',
      'task_fail',
      'task_finish',
      'task_plan',
      'task_todo',
    ]);

    createAgentTask(repos, { title: '写', goal: '写', agent: 'ghost', origin: 'cli' }, new Date(T0));
    const failed = await runner.runNext();
    assert.equal(failed?.state, 'failed');
    assert.match(failed?.error ?? '', /没有「ghost」这种子 agent，有：general、research、scheduler、writer/);
  });

  test('一轮停下了还没交：带着 todo 的现状催它接着做', async () => {
    const prompts: unknown[] = [];
    const model = scripted(
      [
        call('task_plan', { id: 1, todos: ['写'] }),
        text('先到这'),
        call('task_todo', { id: 1, index: 1, state: 'done' }),
        call('task_finish', { id: 1, result: '写好了', checks: CHECKS }),
        text('好了'),
      ],
      prompts,
    );
    const { repos, runner } = rig(model);
    brief(repos);
    assert.equal((await runner.runNext())?.state, 'done');
    assert.match(JSON.stringify(prompts[2]), /子任务 #1 还没交结果。.*\[ \] 1\. 写/);
  });

  test(`跑了 ${MAX_ROUNDS} 轮还没交就算没做成；模型出错也算，原因写回主线程`, async () => {
    const { repos, main, runner } = rig(scripted([]));
    brief(repos);
    const failed = await runner.runNext();
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.error, `跑了 ${MAX_ROUNDS} 轮还没交结果`);
    assert.match(JSON.stringify(await main.entries()), /没做成：跑了/);

    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const other = rig(broken);
    brief(other.repos);
    const error = await other.runner.runNext();
    assert.equal(error?.state, 'failed');
    assert.match(error?.error ?? '', /模型没回/);
  });

  test('别处取消了：停下这一轮，主线程知道它取消了', async () => {
    // 模型开始跑这一轮时，主人在别处取消
    let cancel: (() => void) | null = null;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        cancel?.();
        await new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
          setTimeout(resolve, 2000);
        });
        return text('做着呢');
      },
    });
    const { repos, main, runner } = rig(model);
    const task = brief(repos);
    cancel = () => cancelAgentTask(repos, task.id, new Date(T0));
    const result = await runner.runNext();
    assert.equal(result?.state, 'cancelled');
    assert.match(JSON.stringify(await main.entries()), /取消了/);
  });

  test('常驻进程要停：正在做的放回排队，下次启动接着做', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        await new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
          setTimeout(resolve, 2000);
        });
        return text('做着呢');
      },
    });
    const { repos, main, runner } = rig(model);
    brief(repos);
    const controller = new AbortController();
    runner.start(controller.signal);
    for (let i = 0; i < 100 && repos.agentTasks.get(1)?.state !== 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(repos.agentTasks.get(1)?.state, 'running');
    await runner.close();
    assert.equal(repos.agentTasks.get(1)?.state, 'queued');
    assert.deepEqual(await main.entries(), [], '没结束就不写回主线程');
  });

  test('同时跑到上限，多的排队按编号先后；做完一件马上补位', async () => {
    const { model, started, release, waiting } = gated();
    const { repos, runner } = rig(model, 2);
    for (let i = 0; i < 3; i += 1) brief(repos);
    const controller = new AbortController();
    runner.start(controller.signal);
    await until(() => waiting(1) && waiting(2), '前两个一起开始');
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(runner.active(), [1, 2]);
    assert.equal(repos.agentTasks.get(3)?.state, 'queued', '第三个排队');

    release(2);
    await until(() => waiting(3), '第二个做完，第三个补上');
    assert.equal(repos.agentTasks.get(2)?.state, 'done');
    assert.equal(repos.agentTasks.get(1)?.state, 'running');
    assert.deepEqual(runner.active(), [1, 3]);

    release(1);
    release(3);
    await until(() => runner.active().length === 0, '都做完');
    assert.deepEqual(
      repos.agentTasks.list().map((task) => [task.id, task.state, task.result]),
      [
        [3, 'done', '#3 做好了'],
        [2, 'done', '#2 做好了'],
        [1, 'done', '#1 做好了'],
      ],
    );
    controller.abort();
    await runner.close();
  });

  test('一个取消、一个出错，不碍着一起跑的那个', async () => {
    const { model, release, waiting } = gated([2]);
    const { repos, main, runner } = rig(model, 3);
    for (let i = 0; i < 3; i += 1) brief(repos);
    const controller = new AbortController();
    runner.start(controller.signal);
    await until(() => waiting(1) && waiting(3) && repos.agentTasks.get(2)?.state === 'failed', '都开始了，#2 出错');
    cancelAgentTask(repos, 1, new Date(T0));
    await until(() => !runner.active().includes(1), '#1 停下');
    assert.equal(repos.agentTasks.get(3)?.state, 'running', '#3 还在做');
    release(3);
    await until(() => runner.active().length === 0, '#3 做完');
    assert.deepEqual(
      [1, 2, 3].map((id) => repos.agentTasks.get(id)?.state),
      ['cancelled', 'failed', 'done'],
    );
    const notes = (await main.entries()).map((entry) => Number(entry.type === 'event' ? entry.meta?.['id'] : 0));
    assert.deepEqual(
      notes.toSorted((a, b) => a - b),
      [1, 2, 3],
      '三个都写回主线程',
    );
    controller.abort();
    await runner.close();
  });

  test('常驻进程要停：在做的都放回排队', async () => {
    const { model, waiting } = gated();
    const { repos, main, runner } = rig(model, 2);
    for (let i = 0; i < 3; i += 1) brief(repos);
    runner.start(new AbortController().signal);
    await until(() => waiting(1) && waiting(2), '前两个在做');
    await runner.close();
    assert.deepEqual(
      [1, 2, 3].map((id) => repos.agentTasks.get(id)?.state),
      ['queued', 'queued', 'queued'],
    );
    assert.deepEqual(runner.active(), []);
    assert.deepEqual(await main.entries(), []);
  });

  test('没配模型：排队的不做，记一行', async () => {
    const { repos, runner, logger } = rig(null);
    brief(repos);
    const controller = new AbortController();
    runner.start(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await runner.close();
    assert.equal(repos.agentTasks.get(1)?.state, 'queued');
    assert.ok(
      logger.lines.some((line) => line.includes('没配 llm')),
      logger.lines.join('\n'),
    );
  });
});
