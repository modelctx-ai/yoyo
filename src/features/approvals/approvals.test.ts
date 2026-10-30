import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { memoryRepos } from '../../runtime/testing.ts';
import {
  askTask,
  answerTask,
  createAgentTask,
  relayPrompt,
  taskDetail,
  tasksFact,
  announceLine,
} from '../tasks/tasks.ts';
import {
  ApprovalError,
  approvalAnnounceLine,
  approvalAnswer,
  approvalDetail,
  approvalNote,
  approvalQuestion,
  approvalRelayPrompt,
  approvalRow,
  approvalTimedOut,
  clip,
  decideApproval,
  expireApproval,
  inputLines,
  mainReply,
  requestApproval,
  running,
  settled,
  taskReply,
  timeoutNote,
} from './approvals.ts';

const NOW = new Date(2026, 9, 30, 15, 0, 0);
const HOUR = 3_600_000;

function rig() {
  const repos = memoryRepos({ now: () => NOW });
  const first = requestApproval(
    repos,
    {
      tool: 'write',
      summary: '写 notes/周报.md（新建，2 行，11 B）',
      input: { path: 'notes/周报.md', content: '# 周报\nA\n' },
      task: null,
      runId: 'run_1',
    },
    NOW,
  );
  return { repos, first };
}

describe('批准请求', () => {
  test('建：摘要压成一行记下来，参数存成 JSON，记一笔；等批准', () => {
    const repos = memoryRepos({ now: () => NOW });
    const made = requestApproval(
      repos,
      { tool: 'bash', summary: '跑命令：\n  python   plot.py ', input: { command: 'python plot.py' }, task: 2 },
      NOW,
    );
    assert.deepEqual(
      [made.id, made.state, made.summary, made.input, made.task, made.runId, made.createdAt],
      [1, 'pending', '跑命令： python plot.py', '{"command":"python plot.py"}', 2, null, NOW.getTime()],
    );
    const trail = repos.activity.list(1)[0];
    assert.deepEqual(
      [trail?.type, trail?.id, trail?.tool, trail?.text, trail?.['task']],
      ['approval-ask', 1, 'bash', '跑命令： python plot.py', 2],
    );
    assert.equal(
      requestApproval(repos, { tool: 'bash', summary: 'x'.repeat(500), input: {}, task: null }, NOW).summary.length,
      200,
    );
  });

  test('批准、拒绝：只对等批准的有效，记下是在哪点的；没有的、已经批过的报一句话', () => {
    const { repos, first } = rig();
    assert.equal(decideApproval(repos, first.id, 'approved', NOW, 'web').state, 'approved');
    assert.deepEqual(
      repos.activity.list(1).map((e) => [e.type, e.id, e.tool, e['via']]),
      [['approval-approve', 1, 'write', 'web']],
    );
    assert.throws(() => decideApproval(repos, first.id, 'denied', NOW, 'cli'), /批准请求 #1 已经「批准了」，不能再改/);
    assert.throws(() => decideApproval(repos, 9, 'approved', NOW, 'cli'), ApprovalError);
    assert.throws(() => decideApproval(repos, 9, 'approved', NOW, 'cli'), /没有批准请求 #9/);
    const second = requestApproval(repos, { tool: 'edit', summary: '改 a', input: {}, task: null }, NOW);
    assert.equal(decideApproval(repos, second.id, 'denied', NOW, 'cli').state, 'denied');
    assert.equal(repos.activity.list(1)[0]?.type, 'approval-deny');
  });

  test('过期：等太久算过期，0 不过期；过期的记一笔、带原因；批过的不再过期', () => {
    const { repos, first } = rig();
    const at = NOW.getTime();
    assert.equal(approvalTimedOut(first, at + 24 * HOUR - 1, 24 * HOUR), false);
    assert.equal(approvalTimedOut(first, at + 24 * HOUR, 24 * HOUR), true);
    assert.equal(approvalTimedOut(first, at + 1000 * HOUR, 0), false);
    assert.equal(timeoutNote(24 * HOUR), '等了 24 小时没批准');
    assert.equal(timeoutNote(1.5 * HOUR), '等了 1.5 小时没批准');
    const expired = expireApproval(repos, first.id, '等了 24 小时没批准', new Date(at + 24 * HOUR));
    assert.deepEqual(
      [expired?.state, expired?.note, expired?.decidedAt],
      ['expired', '等了 24 小时没批准', at + 24 * HOUR],
    );
    assert.equal(repos.activity.list(1)[0]?.type, 'approval-expire');
    assert.equal(expireApproval(repos, first.id, '再来', NOW), null, '已经过期的不再改');
    assert.equal(approvalTimedOut(expired!, at + 1000 * HOUR, HOUR), false);
  });

  test('有没有结论：拒绝、过期、批准了做完的有；批准了还没做完的没有', () => {
    const base = { result: null };
    assert.equal(settled({ ...base, state: 'pending' }), false);
    assert.equal(settled({ ...base, state: 'approved' }), false);
    assert.equal(running({ ...base, state: 'approved' }), true);
    assert.equal(settled({ result: '写好了', state: 'approved' }), true);
    assert.equal(settled({ ...base, state: 'denied' }), true);
    assert.equal(settled({ ...base, state: 'expired' }), true);
  });

  test('给人看的：一行、详情（参数摊开，多行的另起一段）、太长的留头尾', () => {
    const { repos, first } = rig();
    assert.equal(approvalRow(first), '#1\t等批准\twrite\t主线程\t写 notes/周报.md（新建，2 行，11 B）');
    assert.deepEqual(inputLines(first), ['path：notes/周报.md', 'content：', '# 周报\nA\n']);
    assert.deepEqual(inputLines({ input: '{"all":true,"n":3}' }), ['all：true', 'n：3']);
    assert.deepEqual(inputLines({ input: 'not json' }), ['not json']);
    const done = repos.approvals.update(first.id, { result: '写好了：notes/周报.md' })!;
    assert.equal(
      approvalDetail(done),
      '#1 写 notes/周报.md（新建，2 行，11 B）（等批准，write，主线程）\n\n参数：\npath：notes/周报.md\ncontent：\n# 周报\nA\n\n\n结果：\n写好了：notes/周报.md',
    );
    assert.equal(clip('abc', 10), 'abc');
    const long = clip('a'.repeat(100) + 'z'.repeat(100), 90);
    assert.match(long, /^a{30}\n……中间省略了 110 字……\nz{60}$/);
  });

  test('给模型的话：主线程那一轮说清楚还没做、告诉主人去哪批；子任务那一轮说进入等回答', () => {
    const { first } = rig();
    const reply = mainReply(first);
    assert.match(
      reply,
      /要主人在工作台里批准才会做：「写 notes\/周报.md（新建，2 行，11 B）」（批准请求 #1）。已经记下，现在还没做。/,
    );
    assert.match(reply, /告诉主人去工作台批准[^]*别说成已经做了/);
    const inTask = taskReply({ ...first, task: 7 });
    assert.match(inTask, /子任务 #7 进入等回答，主人批准或拒绝以后接着做/);
    assert.match(inTask, /这一轮到此为止：别再调别的工具/);
    assert.equal(
      approvalQuestion([
        { id: 1, summary: '写 a.md' },
        { id: 2, summary: '跑命令：ls' },
      ]),
      '想做下面这几件事，要你批准（在工作台的「待批准」里点批准或拒绝）：\n#1 写 a.md\n#2 跑命令：ls',
    );
    assert.match(approvalQuestion([{ id: 1, summary: '写 a.md' }]), /^想做下面这件事，要你批准/);
    assert.ok(
      approvalQuestion([
        { id: 1, summary: 'x'.repeat(200) },
        { id: 2, summary: 'y'.repeat(200) },
        { id: 3, summary: 'z'.repeat(200) },
      ]).length <= 600,
    );
  });

  test('结果写回主会话、转告的通知和说法、转告没成时桌宠说的那句', () => {
    const { repos, first } = rig();
    const approved = repos.approvals.update(first.id, { result: '写好了：notes/周报.md（2 行，11 B）' });
    assert.ok(approved);
    const ok = { ...approved, state: 'approved' as const };
    assert.equal(
      approvalNote(ok),
      '批准请求 #1「写 notes/周报.md（新建，2 行，11 B）」：主人在工作台里批准了，已经照做。\n结果：\n写好了：notes/周报.md（2 行，11 B）',
    );
    assert.equal(
      approvalNote({ ...first, state: 'denied' }),
      '批准请求 #1「写 notes/周报.md（新建，2 行，11 B）」：主人在工作台里拒绝了，没有做。',
    );
    assert.equal(
      approvalNote({ ...first, state: 'expired', note: '等了 24 小时没批准' }),
      '批准请求 #1「写 notes/周报.md（新建，2 行，11 B）」：等了 24 小时没批准，没有做。',
    );
    assert.equal(
      approvalRelayPrompt(ok),
      [
        '<approval-notification>',
        '<id>1</id>',
        '<status>approved</status>',
        '<tool>write</tool>',
        '<summary>写 notes/周报.md（新建，2 行，11 B）</summary>',
        '<result>',
        '写好了：notes/周报.md（2 行，11 B）',
        '</result>',
        '</approval-notification>',
        '',
        '你之前想做的这件事，主人在工作台里批准了，已经照做。用一两句话把结果告诉主人，挑最要紧的说；细节在结果里，不用全念。',
      ].join('\n'),
    );
    assert.match(
      approvalRelayPrompt({ ...first, state: 'denied' }),
      /<status>denied<\/status>[^]*拒绝了，没有做[^]*别自己再试一遍/,
    );
    assert.match(
      approvalRelayPrompt({ ...first, state: 'expired', note: '等了 24 小时没批准' }),
      /<note>等了 24 小时没批准<\/note>[^]*已经过期/,
    );
    assert.equal(
      approvalAnnounceLine(ok, NOW).text,
      '「写 notes/周报.md（新建，2 行，11 B）」照你批准的做好了，结果在工作台里。',
    );
    assert.equal(
      approvalAnnounceLine({ ...first, state: 'denied' }, NOW).text,
      '「写 notes/周报.md（新建，2 行，11 B）」你没批准，我就没做。',
    );
    assert.equal(approvalAnnounceLine({ ...first, state: 'expired' }, NOW).kind, 'reminder');
  });

  test('回给子任务的话：每一件做了没有；拒绝的要它换个办法；结果长了每件按份额留头尾', () => {
    const { first } = rig();
    const approved = { ...first, state: 'approved' as const, result: '写好了' };
    const denied = { ...first, id: 2, summary: '跑命令：ls', state: 'denied' as const };
    const expired = { ...first, id: 3, summary: '读 a.md', state: 'expired' as const, note: '子任务 #1 已经不在等了' };
    const text = approvalAnswer([approved, denied, expired]);
    assert.match(text, /批准请求 #1「写 notes\/周报.md（新建，2 行，11 B）」：主人批准了，已经照做。结果：\n写好了/);
    assert.match(
      text,
      /批准请求 #2「跑命令：ls」：主人没批准，没有做。别再试同一件事：换个办法，做不了就用 task_fail 说明。/,
    );
    assert.match(text, /批准请求 #3「读 a.md」：子任务 #1 已经不在等了，没有做。/);
    const big = approvalAnswer([{ ...approved, result: 'x'.repeat(50_000) }]);
    assert.ok(big.length < 12_500, String(big.length));
  });
});

function waitingTask() {
  const repos = memoryRepos({ now: () => NOW });
  const task = createAgentTask(repos, { title: '画图', goal: '画图', origin: 'main' }, NOW);
  repos.agentTasks.update(task.id, { state: 'running' }, NOW.getTime());
  const approval = requestApproval(
    repos,
    { tool: 'bash', summary: '跑命令：python plot.py', input: { command: 'python plot.py' }, task: task.id },
    NOW,
  );
  const waiting = askTask(repos, task.id, approvalQuestion([approval]), NOW);
  return { repos, task, approval, waiting };
}

describe('和子任务接起来', () => {
  test('在等批准的子任务不收回答：批不批要在工作台里点', () => {
    const { repos, task, approval } = waitingTask();
    assert.throws(
      () => answerTask(repos, task.id, '批准', NOW),
      /子任务 #1 在等你批准 1 件事，不是提问：在工作台的「待批准」里点批准或拒绝/,
    );
    assert.equal(repos.agentTasks.get(task.id)?.state, 'waiting');
    decideApproval(repos, approval.id, 'denied', NOW, 'web');
    assert.equal(answerTask(repos, task.id, '用别的办法', NOW).state, 'queued', '没有等批准的了就收');
  });

  test('转告和事实：等批准的不叫提问，不让模型用 task_answer 代答；详情里列出要批准的事', () => {
    const { repos, task, approval, waiting } = waitingTask();
    const pending = repos.approvals.list({ task: task.id, states: ['pending'] });
    const prompt = relayPrompt(waiting, [], true, pending);
    assert.match(prompt, /想做的事要主人批准（不是提问）：「跑命令：python plot.py」/);
    assert.match(prompt, /不要用 task_answer 代答，也别替主人批准/);
    assert.doesNotMatch(prompt, /现在先别调 task_answer/);
    assert.equal(announceLine(waiting, NOW, true).text, '「画图」有件事要你批准，在工作台的「待批准」里。');
    assert.equal(
      tasksFact([waiting], pending),
      [
        '子任务：',
        '#1\t等回答\t-\t画图',
        '',
        '在等主人批准的事（要主人在工作台里点批准或拒绝；不能用 task_answer 代答，也别替主人批准）：',
        '#1「画图」想：跑命令：python plot.py',
      ].join('\n'),
    );
    assert.match(taskDetail(waiting, [], [approval]), /要批准的事：\n#1 等批准 bash：跑命令：python plot.py/);
  });
});
