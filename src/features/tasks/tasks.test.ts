import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { memoryRepos } from '../../runtime/testing.ts';
import {
  TaskError,
  announceLine,
  cancelAgentTask,
  continuePrompt,
  createAgentTask,
  failTask,
  finishTask,
  planTodos,
  progress,
  resultNote,
  runningTask,
  taskBrief,
  taskDetail,
  taskRow,
  tasksFact,
  updateTodo,
} from './tasks.ts';

const NOW = new Date(2026, 9, 30, 15, 0, 0);

function rig() {
  const repos = memoryRepos({ now: () => NOW });
  const task = createAgentTask(
    repos,
    {
      title: '整理周报',
      goal: '把本周三个项目的进展整理成周报',
      criteria: ['三个项目都有', '每项不超过三行'],
      origin: 'main',
    },
    NOW,
  );
  const running = repos.agentTasks.update(task.id, { state: 'running', startedAt: NOW.getTime() }, NOW.getTime())!;
  return { repos, task: running };
}

const CHECKS = [
  { criterion: '三个项目都有', met: true, evidence: 'A、B、C 各一段' },
  { criterion: '每项不超过三行', met: true, evidence: '最长两行' },
];

describe('子任务', () => {
  test('开：标题、目标不能空，验收标准去掉空行；排队等着做，记一笔', () => {
    const repos = memoryRepos({ now: () => NOW });
    const task = createAgentTask(
      repos,
      { title: ' 查天气 ', goal: '明天要不要带伞', criteria: ['给出结论', ' '], origin: 'cli' },
      NOW,
    );
    assert.equal(task.id, 1);
    assert.equal(task.title, '查天气');
    assert.deepEqual(task.criteria, ['给出结论']);
    assert.equal(task.state, 'queued');
    assert.deepEqual(task.todos, []);
    assert.deepEqual(
      repos.activity.list().map((event) => event.type),
      ['task-add'],
    );
    assert.throws(() => createAgentTask(repos, { title: '', goal: 'x', origin: 'cli' }, NOW), /标题不能空着/);
    assert.throws(
      () => createAgentTask(repos, { title: 'x', goal: 'y', criteria: Array(9).fill('一条'), origin: 'cli' }, NOW),
      /最多 8 条/,
    );
  });

  test('拆 todo：重新拆时一字不差的项保留状态；只对在做的任务有效', () => {
    const { repos, task } = rig();
    planTodos(repos, task.id, ['收集进展', '写成周报'], NOW);
    updateTodo(repos, task.id, 1, 'done', '三个项目都问到了', NOW);
    const replanned = planTodos(repos, task.id, ['收集进展', '写成周报', '发给主人看'], NOW);
    assert.deepEqual(
      replanned.todos.map((todo) => `${todo.state}:${todo.text}`),
      ['done:收集进展', 'pending:写成周报', 'pending:发给主人看'],
    );
    assert.equal(replanned.todos[0]?.note, '三个项目都问到了');
    assert.throws(() => planTodos(repos, task.id, [], NOW), /空的/);
    repos.agentTasks.update(task.id, { state: 'done' }, NOW.getTime());
    assert.throws(() => planTodos(repos, task.id, ['再来'], NOW), /现在是「做完」/);
    assert.throws(() => runningTask(repos, 99), /没有子任务 #99/);
  });

  test('改 todo：编号从 1 数，跳过要写原因', () => {
    const { repos, task } = rig();
    planTodos(repos, task.id, ['一', '二'], NOW);
    assert.equal(updateTodo(repos, task.id, 2, 'in_progress', undefined, NOW).todos[1]?.state, 'in_progress');
    assert.throws(() => updateTodo(repos, task.id, 3, 'done', undefined, NOW), /没有第 3 项 todo，现在一共 2 项/);
    assert.throws(() => updateTodo(repos, task.id, 1, 'skipped', ' ', NOW), /跳过要写一句为什么/);
    assert.equal(updateTodo(repos, task.id, 1, 'skipped', '不用了', NOW).todos[0]?.note, '不用了');
    assert.deepEqual(progress(repos.agentTasks.get(task.id)!), { done: 1, total: 2 });
  });

  test('交结果：todo 没做完、验收标准没对齐或没满足都交不了，说清楚差什么', () => {
    const { repos, task } = rig();
    planTodos(repos, task.id, ['收集进展', '写成周报'], NOW);
    updateTodo(repos, task.id, 1, 'done', undefined, NOW);
    assert.throws(() => finishTask(repos, task.id, '周报', CHECKS, NOW), /还有 todo 没做完：2\. 写成周报/);
    updateTodo(repos, task.id, 2, 'done', undefined, NOW);
    assert.throws(() => finishTask(repos, task.id, '周报', CHECKS.slice(0, 1), NOW), /还没对：每项不超过三行/);
    const unmet = [CHECKS[0]!, { ...CHECKS[1]!, met: false }];
    assert.throws(() => finishTask(repos, task.id, '周报', unmet, NOW), /没满足：每项不超过三行/);
    assert.throws(() => finishTask(repos, task.id, ' ', CHECKS, NOW), /结果不能空着/);
    const done = finishTask(repos, task.id, 'A：上线了\nB：在测\nC：排期中', CHECKS, NOW);
    assert.equal(done.state, 'done');
    assert.equal(done.finishedAt, NOW.getTime());
    assert.deepEqual(done.checks, CHECKS);
    assert.ok(repos.activity.list().some((event) => event.type === 'task-done'));
  });

  test('交不了、取消：只对还没结束的；结束了再动报错', () => {
    const { repos, task } = rig();
    const failed = failTask(repos, task.id, '拿不到 B 项目的数据', NOW);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, '拿不到 B 项目的数据');
    assert.throws(() => cancelAgentTask(repos, task.id, NOW), /已经「没做成」/);
    const queued = createAgentTask(repos, { title: '另一件', goal: '目标', origin: 'web' }, NOW);
    assert.equal(cancelAgentTask(repos, queued.id, NOW).state, 'cancelled');
    assert.throws(() => failTask(repos, queued.id, '晚了', NOW), TaskError);
  });

  test('给人和模型看的文字', () => {
    const { repos, task } = rig();
    planTodos(repos, task.id, ['收集进展', '写成周报'], NOW);
    const current = updateTodo(repos, task.id, 1, 'done', '问到了', NOW);
    assert.equal(taskRow(current), '#1\t在做\t1/2\t整理周报');
    assert.equal(
      taskDetail(current),
      [
        '#1 整理周报（在做）',
        '',
        '目标：把本周三个项目的进展整理成周报',
        '',
        '验收标准：',
        '1. 三个项目都有',
        '2. 每项不超过三行',
        '',
        'todo（1/2）：',
        '[x] 1. 收集进展（问到了）',
        '[ ] 2. 写成周报',
      ].join('\n'),
    );
    assert.match(
      taskBrief(current),
      /^子任务 #1：整理周报\n\n目标：.*\n\n验收标准（交结果时逐条对）：\n1\. 三个项目都有/,
    );
    assert.match(
      continuePrompt(current),
      /还没交结果。\n\n现在的 todo：\n\[x\] 1\. 收集进展（问到了）\n\[ \] 2\. 写成周报/,
    );
    assert.equal(tasksFact([current]), '子任务：\n#1\t在做\t1/2\t整理周报');
    assert.equal(tasksFact([]), null);
  });
});

describe('子任务做完以后', () => {
  test('写回主线程的话、桌宠报的那一声', () => {
    const { repos, task } = rig();
    planTodos(repos, task.id, ['写'], NOW);
    updateTodo(repos, task.id, 1, 'done', undefined, NOW);
    const done = finishTask(repos, task.id, '周报：\nA 上线', CHECKS, NOW);
    assert.equal(resultNote(done), '子任务 #1「整理周报」做完了。\n结果：\n周报：\nA 上线');
    assert.equal(announceLine(done, NOW).text, '「整理周报」做好啦，结果放在工作台里。');
    assert.equal(announceLine(done, NOW).kind, 'reminder');
    const other = createAgentTask(repos, { title: '查东西', goal: '查', origin: 'main' }, NOW);
    repos.agentTasks.update(other.id, { state: 'running' }, NOW.getTime());
    const failed = failTask(repos, other.id, '没有权限', NOW);
    assert.equal(resultNote(failed), '子任务 #2「查东西」没做成：没有权限');
    assert.equal(announceLine(failed, NOW).text, '「查东西」没做成，原因写在工作台里。');
  });
});
