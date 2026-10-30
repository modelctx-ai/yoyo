import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, createOrchestrator, type Context } from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import type { Action, ActionTable } from '../brain/action.ts';
import { createApprovalGate } from '../brain/approvals.ts';
import { createTaskContext, mainProjection, sessionFor } from '../brain/context.ts';
import { addFileTools, createFileAccess } from '../brain/files.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import { addTaskWorkerTools, createYoyoTools } from '../brain/tools.ts';
import { decideApproval, requestApproval } from '../features/approvals/approvals.ts';
import { askTask, answerTask, cancelAgentTask, createAgentTask } from '../features/tasks/tasks.ts';
import type { Approval } from '../kernel/types.ts';
import type { Repos } from '../ports/index.ts';
import { createApprovalRunner } from './approvals.ts';
import { createTaskRunner } from './tasks.ts';
import { memoryLogger, memoryRepos } from './testing.ts';

const T0 = new Date(2026, 9, 30, 15, 0, 0).getTime();
const HOUR = 3_600_000;

/** 假动作：记下收到的参数，回一句固定的话。 */
function fake(runs: unknown[], answer: string | Error = '写好了'): Action {
  return {
    summarize: () => '',
    perform: async (raw) => {
      runs.push(raw);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function rig(options: { readonly timeoutMs?: number; readonly pollMs?: number } = {}) {
  const clock = { at: T0 };
  const repos = memoryRepos({ now: () => new Date(clock.at) });
  const logger = memoryLogger();
  const main = createContext({ store: createMemoryStore(), session: sessionFor('main'), projection: mainProjection });
  const runs: unknown[] = [];
  const actions: ActionTable = new Map([
    ['write', fake(runs)],
    ['bash', fake(runs, '退出码 0\n画好了')],
  ]);
  /** 叫一声的那一刻，结果是不是已经在主会话里。 */
  const decided: Promise<boolean>[] = [];
  const noted = (id: number): Promise<boolean> =>
    main.entries().then((entries) => entries.some((entry) => entry.type === 'event' && entry.meta?.['id'] === id));
  const runner = createApprovalRunner({
    repos,
    logger,
    actions,
    main,
    now: () => clock.at,
    pollMs: options.pollMs ?? 5,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    onDecided: (approval: Approval) => decided.push(noted(approval.id)),
  });
  const ask = (tool = 'write', task: number | null = null) =>
    requestApproval(
      repos,
      { tool, summary: tool === 'write' ? '写 a.md' : '跑命令：python plot.py', input: { n: 1 }, task },
      new Date(clock.at),
    );
  const eventsOf = async (): Promise<string[]> =>
    (await main.entries()).map((entry) => (entry.type === 'event' ? `${entry.kind}:${entry.text ?? ''}` : entry.type));
  return { repos, logger, main, runs, actions, runner, decided, clock, ask, eventsOf };
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
}

describe('批准以后', () => {
  test('主线程要的：批准了照原参数做一次，结果写回主会话、再叫醒转告；做过的不再做', async () => {
    const { repos, runs, runner, decided, ask, eventsOf, logger } = rig();
    const approval = ask('bash');
    await runner.step();
    assert.deepEqual(runs, [], '没批准不做');
    assert.equal(repos.approvals.get(approval.id)?.state, 'pending');

    decideApproval(repos, approval.id, 'approved', new Date(T0), 'web');
    await runner.step();
    assert.deepEqual(runs, [{ n: 1 }], '照原参数做了一次');
    const done = repos.approvals.get(approval.id)!;
    assert.deepEqual([done.state, done.ranAt, done.result, done.announcedAt], ['approved', T0, '退出码 0\n画好了', T0]);
    assert.deepEqual(await eventsOf(), [
      'approval:批准请求 #1「跑命令：python plot.py」：主人在工作台里批准了，已经照做。\n结果：\n退出码 0\n画好了',
    ]);
    assert.deepEqual(await Promise.all(decided), [true], '写回主会话以后才叫醒主线程');
    assert.deepEqual(
      repos.activity.list(10).map((e) => e.type),
      ['approval-ask', 'approval-approve', 'approval-run'],
    );
    assert.ok(logger.lines.some((line) => line.includes('批准请求 #1 照做了：跑命令：python plot.py')));
    await runner.step();
    await runner.step();
    assert.equal(runs.length, 1, '只做一次');
    assert.equal((await eventsOf()).length, 1, '只写回一次');
    assert.equal(decided.length, 1);
  });

  test('拒绝：不做，也写回主会话、叫醒转告；同时批了几个，旧的先做', async () => {
    const { repos, runs, runner, decided, ask, eventsOf } = rig();
    const a = ask('write');
    const b = ask('write');
    const c = ask('bash');
    decideApproval(repos, a.id, 'denied', new Date(T0), 'cli');
    decideApproval(repos, c.id, 'approved', new Date(T0), 'cli');
    decideApproval(repos, b.id, 'approved', new Date(T0), 'cli');
    await runner.step();
    assert.equal(runs.length, 2);
    assert.equal(repos.approvals.get(a.id)?.ranAt, null, '拒绝的没做');
    assert.deepEqual(
      await eventsOf(),
      [
        'approval:批准请求 #1「写 a.md」：主人在工作台里拒绝了，没有做。',
        'approval:批准请求 #2「写 a.md」：主人在工作台里批准了，已经照做。\n结果：\n写好了',
        'approval:批准请求 #3「跑命令：python plot.py」：主人在工作台里批准了，已经照做。\n结果：\n退出码 0\n画好了',
      ],
      '按编号先后写回',
    );
    assert.equal(decided.length, 3);
    assert.deepEqual(
      repos.approvals.list().map((item) => item.announcedAt !== null),
      [true, true, true],
    );
  });

  test('等太久没批：按拒绝算，带原因写回主会话；0 不过期；批过的不过期', async () => {
    const { repos, runs, runner, ask, eventsOf, clock, decided } = rig({ timeoutMs: 2 * HOUR });
    const waiting = ask('write');
    const approved = ask('write');
    decideApproval(repos, approved.id, 'approved', new Date(T0), 'web');
    clock.at += HOUR;
    await runner.step();
    assert.equal(repos.approvals.get(waiting.id)?.state, 'pending', '没到 2 小时还在等');
    clock.at += HOUR;
    await runner.step();
    const expired = repos.approvals.get(waiting.id)!;
    assert.deepEqual([expired.state, expired.note, expired.ranAt], ['expired', '等了 2 小时没批准', null]);
    assert.equal(runs.length, 1, '只有批准了的做了');
    assert.match((await eventsOf())[1] ?? '', /批准请求 #1「写 a.md」：等了 2 小时没批准，没有做。/);
    assert.equal(decided.length, 2);
    assert.equal(repos.activity.list(20).filter((e) => e.type === 'approval-expire').length, 1);

    const forever = rig();
    const old = forever.ask('write');
    forever.clock.at += 1000 * HOUR;
    await forever.runner.step();
    assert.equal(forever.repos.approvals.get(old.id)?.state, 'pending', '不设时限就一直等');
  });

  test('照做出错、没有这个工具：结果写「没做成」，照样交回，不会卡住', async () => {
    const { repos, actions, runner, ask, eventsOf, logger } = rig();
    actions.set('write', fake([], new Error('disk full')));
    const broken = ask('write');
    const ghost = ask('edit');
    decideApproval(repos, broken.id, 'approved', new Date(T0), 'web');
    decideApproval(repos, ghost.id, 'approved', new Date(T0), 'web');
    await runner.step();
    assert.equal(repos.approvals.get(broken.id)?.result, '没做成：disk full');
    assert.equal(repos.approvals.get(ghost.id)?.result, '现在没有 edit 这个工具了，没有做');
    assert.equal((await eventsOf()).length, 2);
    assert.ok(logger.lines.some((line) => line.includes('批准请求 #1 照做出错：disk full')));
  });

  test('进程停在做的中途：下次启动不重做，补一句「做到一半停了」再交回', async () => {
    const { repos, runs, runner, ask, eventsOf } = rig();
    const item = ask('bash');
    decideApproval(repos, item.id, 'approved', new Date(T0), 'web');
    assert.ok(repos.approvals.claim(item.id, T0), '上次领走了，还没回话就停了');
    const controller = new AbortController();
    runner.start(controller.signal);
    await until(() => repos.approvals.get(item.id)?.announcedAt !== null, '交回了');
    assert.deepEqual(runs, [], '没有重做');
    assert.equal(repos.approvals.get(item.id)?.result, '做到一半 yoyo 停了，不知道做成没有，看一眼再说');
    assert.match((await eventsOf())[0] ?? '', /做到一半 yoyo 停了/);
    controller.abort();
    await runner.close();
  });

  test('常驻着：命令行批准的最多等一次轮询，工作台批准的 poke 一下就马上做', async () => {
    const { repos, runs, runner, ask } = rig({ pollMs: 60_000 });
    const item = ask('write');
    const controller = new AbortController();
    runner.start(controller.signal);
    await until(() => repos.activity.list(5).length > 0, '启动了');
    decideApproval(repos, item.id, 'approved', new Date(T0), 'web');
    runner.poke();
    await until(() => runs.length === 1, 'poke 以后马上做');
    controller.abort();
    await runner.close();
    assert.equal(runs.length, 1);
  });
});

function waitingTask(rigged: ReturnType<typeof rig>, tools: readonly string[] = ['write', 'bash']) {
  const { repos, ask } = rigged;
  const task = createAgentTask(repos, { title: '画图', goal: '画图', origin: 'main' }, new Date(T0));
  repos.agentTasks.update(task.id, { state: 'running', startedAt: T0 }, T0);
  const approvals = tools.map((tool) => ask(tool, task.id));
  askTask(repos, task.id, '想做几件事', new Date(T0));
  return { task, approvals };
}

describe('子任务要的', () => {
  test('都有结论了才交回：当作回答，子任务排回队里；没写回主会话，也不叫醒转告', async () => {
    const rigged = rig();
    const { repos, runs, runner, decided, eventsOf } = rigged;
    const { task, approvals } = waitingTask(rigged);
    decideApproval(repos, approvals[0]!.id, 'approved', new Date(T0), 'web');
    await runner.step();
    assert.equal(runs.length, 1);
    assert.equal(repos.agentTasks.get(task.id)?.state, 'waiting', '还有一件没批，接着等');
    assert.equal(repos.approvals.get(approvals[0]!.id)?.announcedAt, null, '先不交，一起交');

    decideApproval(repos, approvals[1]!.id, 'denied', new Date(T0), 'cli');
    await runner.step();
    const queued = repos.agentTasks.get(task.id)!;
    assert.equal(queued.state, 'queued');
    assert.equal(
      queued.answer,
      [
        '批准请求 #1「写 a.md」：主人批准了，已经照做。结果：\n写好了',
        '批准请求 #2「跑命令：python plot.py」：主人没批准，没有做。别再试同一件事：换个办法，做不了就用 task_fail 说明。',
      ].join('\n\n'),
    );
    assert.equal(queued.answeredAt, T0);
    assert.deepEqual(
      repos.approvals.list({ task: task.id }).map((item) => item.announcedAt !== null),
      [true, true],
    );
    assert.deepEqual(await eventsOf(), [], '子任务要的不写回主会话：它自己接着做，做完再交结果');
    assert.deepEqual(decided, []);
  });

  test('等批准时子任务取消了：没批的按过期算，批准了没做的不做', async () => {
    const rigged = rig();
    const { repos, runs, runner } = rigged;
    const { task, approvals } = waitingTask(rigged);
    decideApproval(repos, approvals[0]!.id, 'approved', new Date(T0), 'web');
    cancelAgentTask(repos, task.id, new Date(T0));
    await runner.step();
    assert.deepEqual(runs, [], '子任务没了，批准了也不做');
    const [first, second] = approvals.map((item) => repos.approvals.get(item.id)!);
    assert.equal(first?.ranAt, null);
    assert.equal(first?.note, '子任务 #1 已经不在等了，没有做');
    assert.deepEqual([second?.state, second?.note], ['expired', '子任务 #1 已经不在等了']);
    assert.equal(repos.agentTasks.get(task.id)?.state, 'cancelled');
    await runner.step();
  });

  test('等批准的子任务不收一句话回答；有结论了才收', () => {
    const rigged = rig();
    const { repos } = rigged;
    const { task, approvals } = waitingTask(rigged, ['write']);
    assert.throws(() => answerTask(repos, task.id, '批准', new Date(T0)), /在等你批准 1 件事，不是提问/);
    decideApproval(repos, approvals[0]!.id, 'denied', new Date(T0), 'web');
    assert.equal(answerTask(repos, task.id, '换个办法', new Date(T0)).state, 'queued');
  });
});

describe('从头到尾：子任务调了 ask 的写文件，批准后接着做完', () => {
  type Generated = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const say = (value: string): Generated => ({
    content: [{ type: 'text', text: value }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  });
  const call = (name: string, input: unknown): Generated => ({
    content: [{ type: 'tool-call', toolCallId: `${name}-1`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  });

  test('写文件要批准 → 子任务等回答并写回主线程 → 批准 → 照做 → 下一轮输入带着结果 → 交结果', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yoyo-flow-'));
    const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, '.yoyo', 'config.json') });
    mkdirSync(join(home, '.yoyo'), { recursive: true });
    const config = parseConfig({ files: { write: 'ask' } });
    const access = createFileAccess({ config: config.files, paths, home });
    const repos: Repos = memoryRepos({ now: () => new Date(T0) });
    const main: Context = createContext({
      store: createMemoryStore(),
      session: sessionFor('main'),
      projection: mainProjection,
    });
    const actions: ActionTable = new Map();
    const worker = createYoyoTools({ repos, search: null });
    addFileTools(worker, {
      access,
      repos,
      allow: config.files,
      actions,
      gate: createApprovalGate({ repos, now: () => new Date(T0) }),
    });
    addTaskWorkerTools(worker, { repos, now: () => new Date(T0) });
    const harness = createYoyoHarness(createTaskContext(main, { tools: worker }));
    const prompts: unknown[] = [];
    const steps = [
      call('write', { path: 'notes/周报.md', content: '# 周报\n' }),
      say('等主人批准'),
      call('task_finish', { id: 1, result: '周报写好了', checks: [] }),
      say('交好了'),
    ];
    let index = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return steps[index++] ?? say('还在做');
      },
    });
    const asked: number[] = [];
    const tasks = createTaskRunner({
      repos,
      logger: memoryLogger(),
      runs: createOrchestrator({ harness, store: main.store, owner: 'yoyo-tasks' }),
      model,
      main,
      now: () => T0,
      pollMs: 5,
      onAsked: (task) => void asked.push(task.id),
    });
    const approvals = createApprovalRunner({ repos, logger: memoryLogger(), actions, main, now: () => T0 });
    createAgentTask(repos, { title: '写周报', goal: '写一份周报', origin: 'main' }, new Date(T0));

    const waiting = await tasks.runNext();
    assert.equal(waiting?.state, 'waiting');
    assert.equal(existsSync(join(access.workspace, 'notes', '周报.md')), false, '没批准不写');
    assert.match(waiting?.question ?? '', /要你批准[^]*#1 写 notes\/周报.md（新建，1 行，9 B）/);
    assert.deepEqual(asked, [1], '问题写回主线程、叫醒转告');
    assert.match(
      JSON.stringify((await main.entries()).map((e) => (e.type === 'event' ? e.text : ''))),
      /想问主人：想做下面这件事，要你批准/,
    );

    decideApproval(repos, 1, 'approved', new Date(T0), 'web');
    await approvals.step();
    assert.equal(readFileSync(join(access.workspace, 'notes', '周报.md'), 'utf8'), '# 周报\n', '批准后照原参数写了');
    assert.equal(repos.agentTasks.get(1)?.state, 'queued');

    const done = await tasks.runNext();
    assert.equal(done?.state, 'done');
    const resumed = JSON.stringify(prompts[2]);
    assert.match(resumed, /你问主人：想做下面这件事，要你批准/);
    assert.match(
      resumed,
      /主人回答了：批准请求 #1「写 notes\/周报.md（新建，1 行，9 B）」：主人批准了，已经照做。结果：\\n写好了：notes\/周报.md（1 行，9 B）/,
    );
  });
});
