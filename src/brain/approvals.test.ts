import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createToolRegistry, type LocalToolRegistry, type ToolOutput } from '@modelctx-ai/ctx';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { createAgentTask } from '../features/tasks/tasks.ts';
import { memoryRepos } from '../runtime/testing.ts';
import { ASK_NOTE, type ActionTable } from './action.ts';
import { createApprovalGate } from './approvals.ts';
import { addFileTools, createFileAccess } from './files.ts';

const NOW = new Date(2026, 9, 30, 15, 0, 0);

function rig(files: Record<string, unknown> = {}, options: { readonly gate?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-ask-'));
  const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, '.yoyo', 'config.json') });
  mkdirSync(join(home, '.yoyo'), { recursive: true });
  writeFileSync(join(home, '.yoyo', 'config.json'), '{"llm":{"apiKey":"secret"}}');
  mkdirSync(join(home, 'Documents'));
  writeFileSync(join(home, 'Documents', 'plan.md'), '计划');
  const config = parseConfig({
    files: { readable: ['~/Documents'], read: 'ask', write: 'ask', edit: 'ask', ...files },
  });
  const access = createFileAccess({ config: config.files, paths, home });
  const repos = memoryRepos({ now: () => NOW });
  const registry = createToolRegistry();
  const actions: ActionTable = new Map();
  const gate = options.gate === false ? {} : { gate: createApprovalGate({ repos, now: () => NOW }) };
  addFileTools(registry, { access, repos, allow: config.files, actions, ...gate });
  return { home, access, repos, registry, actions, workspace: access.workspace };
}

/** 像一轮里模型调工具那样调：经 `toolSet`，会话和运行编号跟着走。 */
async function call(registry: LocalToolRegistry, session: string, name: string, input: unknown): Promise<string> {
  const picked = registry.toolSet([name], { session, runId: 'run_9' })[name];
  assert.ok(picked?.execute, `没有工具 ${name}`);
  const output = (await picked.execute(input, { toolCallId: 'c1', messages: [], context: {} })) as ToolOutput;
  assert.equal(output.type, 'text', JSON.stringify(output));
  return output.type === 'text' ? output.text : '';
}

const MAIN = 'pet:main';

describe('先问：ask 的工具', () => {
  test('三个工具照样注册，说明里多一句要批准；deny 的才没有', () => {
    const { registry } = rig({ edit: 'deny' });
    assert.deepEqual(
      registry.list().map((definition) => definition.name),
      ['read', 'write'],
    );
    for (const definition of registry.list()) assert.match(definition.description ?? '', new RegExp(ASK_NOTE));
    const allow = rig({ read: 'allow', write: 'allow', edit: 'allow' });
    for (const definition of allow.registry.list()) assert.doesNotMatch(definition.description ?? '', /批准/);
  });

  test('主线程那一轮：不当场做，记一条批准请求，工具立刻回「要批准、还没做」', async () => {
    const { registry, repos, workspace } = rig();
    const reply = await call(registry, MAIN, 'write', { path: 'notes/周报.md', content: '# 周报\nA\n' });
    assert.match(
      reply,
      /要主人在工作台里批准才会做：「写 notes\/周报.md（新建，2 行，11 B）」（批准请求 #1）。已经记下，现在还没做。/,
    );
    assert.equal(existsSync(join(workspace, 'notes', '周报.md')), false, '没批准不做');
    assert.deepEqual(
      repos.approvals.list().map((a) => [a.id, a.tool, a.state, a.task, a.runId, a.summary, JSON.parse(a.input)]),
      [
        [
          1,
          'write',
          'pending',
          null,
          'run_9',
          '写 notes/周报.md（新建，2 行，11 B）',
          { path: 'notes/周报.md', content: '# 周报\nA\n' },
        ],
      ],
    );
    assert.equal(repos.activity.list(1)[0]?.type, 'approval-ask');
    assert.equal(
      repos.activity.list(5).some((e) => e.type === 'file-write'),
      false,
    );
  });

  test('批准以后照原参数做：动作在表里，做之前范围再查一遍；写和改都认', async () => {
    const { registry, actions, workspace, repos } = rig();
    await call(registry, MAIN, 'write', { path: 'a.md', content: 'A 上线\nB 在测' });
    const [write] = repos.approvals.list();
    assert.equal(await actions.get('write')!.perform(JSON.parse(write!.input)), '写好了：a.md（2 行，17 B）');
    assert.equal(readFileSync(join(workspace, 'a.md'), 'utf8'), 'A 上线\nB 在测');
    const reply = await call(registry, MAIN, 'edit', { path: 'a.md', old: 'B 在测', new: 'B 提测' });
    assert.match(reply, /「改 a.md（换 1 处）」（批准请求 #2）/);
    assert.equal(readFileSync(join(workspace, 'a.md'), 'utf8'), 'A 上线\nB 在测', '请求时不改');
    assert.equal(
      await actions.get('edit')!.perform(JSON.parse(repos.approvals.get(2)!.input)),
      '改好了：a.md，换了 1 处',
    );
    assert.equal(readFileSync(join(workspace, 'a.md'), 'utf8'), 'A 上线\nB 提测');
    // 批准前文件变了：照做时再查，原文没了就不改
    writeFileSync(join(workspace, 'a.md'), '全变了');
    assert.match(await actions.get('edit')!.perform(JSON.parse(repos.approvals.get(2)!.input)), /没找到要换的原文/);
    // 批准不能扩大范围：规则照旧查
    assert.match(
      await actions.get('write')!.perform({ path: '../escape.md', content: 'x' }),
      /不给读写|只能写在工作区里/,
    );
  });

  test('范围先查：不在范围里的、改不了的不会变成批准请求，直接说清楚', async () => {
    const { registry, repos, workspace, home } = rig();
    writeFileSync(join(workspace, 'a.md'), 'x\nx');
    assert.match(await call(registry, MAIN, 'write', { path: '../x.md', content: 'x' }), /只能写在工作区里|不给读写/);
    assert.match(
      await call(registry, MAIN, 'write', { path: '~/Documents/plan.md', content: 'x' }),
      /只能写在工作区里/,
    );
    assert.match(await call(registry, MAIN, 'read', { path: '~/.yoyo/config.json' }), /不给读写/);
    assert.match(await call(registry, MAIN, 'read', { path: '/etc/hosts' }), /读不到工作区和 files\.readable 以外/);
    assert.equal(await call(registry, MAIN, 'read', { path: 'nope.md' }), '没有这个文件或目录');
    assert.match(await call(registry, MAIN, 'edit', { path: 'a.md', old: 'x', new: 'y' }), /出现了 2 次/);
    assert.match(await call(registry, MAIN, 'edit', { path: 'a.md', old: '没有', new: 'y' }), /没找到要换的原文/);
    assert.match(await call(registry, MAIN, 'edit', { path: 'b.md', old: 'a', new: 'b' }), /没有这个文件或目录/);
    assert.match(await call(registry, MAIN, 'write', { path: '', content: 'x' }), /要给路径/);
    assert.deepEqual(repos.approvals.list(), [], '一条请求也没有');
    assert.equal(readFileSync(join(home, 'Documents', 'plan.md'), 'utf8'), '计划');
    // 读：只读目录里的能问
    assert.match(
      await call(registry, MAIN, 'read', { path: '~/Documents/plan.md' }),
      /「读 ~\/Documents\/plan.md」（批准请求 #1）/,
    );
    assert.match(await call(registry, MAIN, 'read', { path: '.' }), /「列目录 \.」（批准请求 #2）/);
  });

  test('参数不对：像平时一样报，不建请求', async () => {
    const { registry, repos } = rig();
    const reply = await call(registry, MAIN, 'write', { path: 'a.md' });
    assert.match(reply, /Invalid input|参数不对/);
    assert.deepEqual(repos.approvals.list(), []);
  });

  test('没接上批准的地方（没给 gate）：ask 的工具只会拒绝，绝不放行', async () => {
    const { registry, workspace, repos } = rig({}, { gate: false });
    assert.equal(
      await call(registry, MAIN, 'write', { path: 'a.md', content: 'x' }),
      '这个工具要主人批准，这里没法批准，没有做。',
    );
    assert.equal(existsSync(join(workspace, 'a.md')), false);
    assert.deepEqual(repos.approvals.list(), []);
  });

  test('子任务里：子任务进入等回答，问题是请求的摘要，这一轮到此为止；同一步里又调的一起等', async () => {
    const { registry, repos, workspace } = rig();
    const task = createAgentTask(repos, { title: '写周报', goal: '写', origin: 'main' }, NOW);
    repos.agentTasks.update(task.id, { state: 'running' }, NOW.getTime());
    const session = `task:${task.id}`;
    const reply = await call(registry, session, 'write', { path: 'a.md', content: 'A\n' });
    assert.match(reply, /「写 a.md（新建，1 行，2 B）」（批准请求 #1）[^]*子任务 #1 进入等回答[^]*这一轮到此为止/);
    const waiting = repos.agentTasks.get(task.id)!;
    assert.equal(waiting.state, 'waiting');
    assert.equal(
      waiting.question,
      '想做下面这件事，要你批准（在工作台的「待批准」里点批准或拒绝）：\n#1 写 a.md（新建，1 行，2 B）',
    );
    assert.equal(repos.approvals.get(1)?.task, task.id);
    // 同一步里又调了一个：任务已经在等了，请求照记，要问的话跟着更新
    writeFileSync(join(workspace, 'a.md'), 'A\n');
    const second = await call(registry, session, 'edit', { path: 'a.md', old: 'A', new: 'B' });
    assert.match(second, /批准请求 #2/);
    assert.equal(repos.agentTasks.get(task.id)?.state, 'waiting');
    assert.match(repos.agentTasks.get(task.id)?.question ?? '', /想做下面这几件事[^]*#1 写 a\.md[^]*#2 改 a\.md/);
    assert.equal(repos.approvals.list({ task: task.id, states: ['pending'] }).length, 2);
  });

  test('子任务已经不在做了（取消、做完）：不记请求，告诉模型', async () => {
    const { registry, repos } = rig();
    const task = createAgentTask(repos, { title: '写周报', goal: '写', origin: 'main' }, NOW);
    repos.agentTasks.update(task.id, { state: 'cancelled' }, NOW.getTime());
    assert.equal(
      await call(registry, `task:${task.id}`, 'write', { path: 'a.md', content: 'x' }),
      '子任务 #1 现在是「取消了」，不能再要批准',
    );
    assert.equal(
      await call(registry, 'task:99', 'write', { path: 'a.md', content: 'x' }),
      '子任务 #99 不在了，不能再要批准',
    );
    assert.deepEqual(repos.approvals.list(), []);
  });

  test('allow 的照旧直接做，不建请求', async () => {
    const { registry, repos, workspace } = rig({ write: 'allow' });
    assert.equal(await call(registry, MAIN, 'write', { path: 'a.md', content: 'x' }), '写好了：a.md（1 行，1 B）');
    assert.equal(readFileSync(join(workspace, 'a.md'), 'utf8'), 'x');
    assert.deepEqual(repos.approvals.list(), []);
  });
});
