/**
 * 子任务：主线程派给子 agent 的一件事。这里是不碰模型的那部分：开、取消、拆 todo、改 todo、交结果、交不了，
 * 每一步先查状态对不对；还有给人看（命令行、工作台）和给模型看（任务说明、催它接着做）的文字。
 * 子 agent 的工具、命令行和工作台都走这里，规则只有一份。
 */
import { TONE_CUES, toneForHour } from '../../kernel/tone.ts';
import type { AgentTask, AgentTaskState, CriterionCheck, Line, Todo, TodoState } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';

export const TITLE_MAX = 60;
export const GOAL_MAX = 4000;
export const CRITERIA_MAX = 8;
export const TODOS_MAX = 20;
export const RESULT_MAX = 8000;
const LINE_MAX = 300;

/** 规则不让做的事：一句话说清楚。工具把它原样交回模型，命令行打出来。 */
export class TaskError extends Error {}

export const STATE_LABELS: Readonly<Record<AgentTaskState, string>> = {
  queued: '排队',
  running: '在做',
  done: '做完',
  failed: '没做成',
  cancelled: '取消了',
};

export const TODO_MARKS: Readonly<Record<TodoState, string>> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  skipped: '[-]',
};

/** 还在排队或在做。 */
export function isOpen(task: Pick<AgentTask, 'state'>): boolean {
  return task.state === 'queued' || task.state === 'running';
}

type TaskRepos = Pick<Repos, 'agentTasks' | 'activity'>;

function clean(text: unknown, what: string, max: number): string {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw new TaskError(`${what}不能空着`);
  if (value.length > max) throw new TaskError(`${what}太长了，最多 ${max} 字`);
  return value;
}

function lines(items: unknown, what: string, max: number): string[] {
  const list = Array.isArray(items) ? items : [];
  const texts = list.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  if (texts.length > max) throw new TaskError(`${what}最多 ${max} 条`);
  for (const text of texts) if (text.length > LINE_MAX) throw new TaskError(`${what}每条最多 ${LINE_MAX} 字`);
  return texts;
}

export interface NewTask {
  readonly title?: unknown;
  readonly goal?: unknown;
  readonly criteria?: unknown;
  readonly origin: string;
}

/** 开一个子任务，排队等常驻进程来做。验收标准可以没有，但最好有。 */
export function createAgentTask(repos: TaskRepos, input: NewTask, now: Date): AgentTask {
  const title = clean(input.title, '标题', TITLE_MAX);
  const goal = clean(input.goal, '目标', GOAL_MAX);
  const criteria = lines(input.criteria, '验收标准', CRITERIA_MAX);
  const task = repos.agentTasks.create({ title, goal, criteria, origin: input.origin }, now.getTime());
  repos.activity.record({ type: 'task-add', id: task.id, title, origin: input.origin });
  return task;
}

function found(repos: TaskRepos, id: number): AgentTask {
  const task = Number.isInteger(id) ? repos.agentTasks.get(id) : null;
  if (!task) throw new TaskError(`没有子任务 #${id}`);
  return task;
}

/** 子 agent 的工具只对在做的任务有效。 */
export function runningTask(repos: TaskRepos, id: number): AgentTask {
  const task = found(repos, id);
  if (task.state !== 'running') throw new TaskError(`子任务 #${id} 现在是「${STATE_LABELS[task.state]}」，不能再改`);
  return task;
}

function saved(repos: TaskRepos, id: number, patch: Parameters<Repos['agentTasks']['update']>[1], now: Date) {
  const task = repos.agentTasks.update(id, patch, now.getTime());
  if (!task) throw new TaskError(`没有子任务 #${id}`);
  return task;
}

/** 取消：排队的不做了，在做的由常驻进程看到后停下。 */
export function cancelAgentTask(repos: TaskRepos, id: number, now: Date): AgentTask {
  const task = found(repos, id);
  if (!isOpen(task)) throw new TaskError(`子任务 #${id} 已经「${STATE_LABELS[task.state]}」`);
  repos.activity.record({ type: 'task-cancel', id, title: task.title });
  return saved(repos, id, { state: 'cancelled', finishedAt: now.getTime() }, now);
}

/**
 * 拆 todo（或者重新拆）：给一整份清单。和原来一字不差的项保留原来的状态，做完的不会被冲掉；
 * 新的项都是待做。
 */
export function planTodos(repos: TaskRepos, id: number, texts: unknown, now: Date): AgentTask {
  const task = runningTask(repos, id);
  const list = lines(texts, 'todo', TODOS_MAX);
  if (list.length === 0) throw new TaskError('todo 清单是空的');
  const before = new Map(task.todos.map((todo) => [todo.text, todo]));
  const todos: Todo[] = list.map((text) => before.get(text) ?? { text, state: 'pending' });
  return saved(repos, id, { todos }, now);
}

/** 改一项 todo 的状态。`index` 从 1 数，和给模型看的编号一样。 */
export function updateTodo(
  repos: TaskRepos,
  id: number,
  index: number,
  state: TodoState,
  note: string | undefined,
  now: Date,
): AgentTask {
  const task = runningTask(repos, id);
  const at = index - 1;
  const todo = task.todos[at];
  if (!Number.isInteger(index) || !todo)
    throw new TaskError(`没有第 ${index} 项 todo，现在一共 ${task.todos.length} 项`);
  if (state === 'skipped' && !note?.trim()) throw new TaskError('跳过要写一句为什么');
  // 和 Claude Code 的 TodoWrite 一样：同一时间只有一项在做，做完一项再开始下一项
  const busy = task.todos.findIndex((item, i) => i !== at && item.state === 'in_progress');
  if (state === 'in_progress' && busy >= 0) {
    throw new TaskError(`第 ${busy + 1} 项还在做，先标做完或跳过，再开始第 ${index} 项`);
  }
  const trimmed = note?.trim().slice(0, LINE_MAX);
  const next: Todo = { text: todo.text, state, ...(trimmed ? { note: trimmed } : {}) };
  const todos = task.todos.map((item, i) => (i === at ? next : item));
  return saved(repos, id, { todos }, now);
}

/**
 * 交结果。先对一遍：todo 都要做完或跳过，验收标准每一条都要有对上的检查、都满足；
 * 不满足就把差什么说清楚交回去，让它接着做或者交不了时用 `failTask`。
 */
export function finishTask(
  repos: TaskRepos,
  id: number,
  result: unknown,
  checks: readonly CriterionCheck[],
  now: Date,
): AgentTask {
  const task = runningTask(repos, id);
  const text = clean(result, '结果', RESULT_MAX);
  const open = task.todos.map((todo, i) => ({ todo, n: i + 1 })).filter(({ todo }) => !settled(todo.state));
  if (open.length > 0) {
    throw new TaskError(
      `还有 todo 没做完：${open.map(({ n, todo }) => `${n}. ${todo.text}`).join('；')}。做完或跳过再交`,
    );
  }
  const missing = task.criteria.filter((criterion) => !checks.some((check) => check.criterion.trim() === criterion));
  if (missing.length > 0)
    throw new TaskError(`这几条验收标准还没对：${missing.join('；')}。逐条给出 criterion、met、evidence`);
  const unmet = checks.filter((check) => task.criteria.includes(check.criterion.trim()) && !check.met);
  if (unmet.length > 0) {
    throw new TaskError(
      `这几条没满足：${unmet.map((check) => check.criterion).join('；')}。接着做，确实做不到就交不了`,
    );
  }
  repos.activity.record({ type: 'task-done', id, title: task.title });
  return saved(
    repos,
    id,
    {
      state: 'done',
      result: text,
      checks: checks.map((check) => ({
        criterion: check.criterion.trim(),
        met: check.met,
        evidence: check.evidence.trim().slice(0, LINE_MAX),
      })),
      finishedAt: now.getTime(),
    },
    now,
  );
}

/** 交不了：说清楚卡在哪。 */
export function failTask(repos: TaskRepos, id: number, reason: unknown, now: Date): AgentTask {
  const task = found(repos, id);
  if (!isOpen(task)) throw new TaskError(`子任务 #${id} 已经「${STATE_LABELS[task.state]}」`);
  const text = clean(reason, '原因', LINE_MAX * 2);
  repos.activity.record({ type: 'task-fail', id, title: task.title, text });
  return saved(repos, id, { state: 'failed', error: text, finishedAt: now.getTime() }, now);
}

function settled(state: TodoState): boolean {
  return state === 'done' || state === 'skipped';
}

export function progress(task: Pick<AgentTask, 'todos'>): { readonly done: number; readonly total: number } {
  return { done: task.todos.filter((todo) => settled(todo.state)).length, total: task.todos.length };
}

/** 列表里的一行：编号、状态、进度、标题。 */
export function taskRow(task: AgentTask): string {
  const { done, total } = progress(task);
  return `#${task.id}\t${STATE_LABELS[task.state]}\t${total ? `${done}/${total}` : '-'}\t${task.title}`;
}

function todoLines(todos: readonly Todo[]): string[] {
  return todos.map(
    (todo, i) => `${TODO_MARKS[todo.state]} ${i + 1}. ${todo.text}${todo.note ? `（${todo.note}）` : ''}`,
  );
}

/** 一个子任务的全部：命令行的 `task show` 和主线程的 `task_show` 工具都用它。 */
export function taskDetail(task: AgentTask): string {
  const parts = [`#${task.id} ${task.title}（${STATE_LABELS[task.state]}）`, '', `目标：${task.goal}`];
  if (task.criteria.length > 0) parts.push('', '验收标准：', ...task.criteria.map((c, i) => `${i + 1}. ${c}`));
  if (task.todos.length > 0) {
    const { done, total } = progress(task);
    parts.push('', `todo（${done}/${total}）：`, ...todoLines(task.todos));
  }
  if (task.checks.length > 0) {
    parts.push('', '验收：', ...task.checks.map((c) => `${c.met ? '✓' : '✗'} ${c.criterion}：${c.evidence}`));
  }
  if (task.result) parts.push('', '结果：', task.result);
  if (task.error) parts.push('', `没做成：${task.error}`);
  return parts.join('\n');
}

/** 交给子 agent 的第一句：任务本身。做法写在它的指令里。 */
export function taskBrief(task: AgentTask): string {
  const parts = [`子任务 #${task.id}：${task.title}`, '', `目标：${task.goal}`];
  parts.push(
    '',
    task.criteria.length > 0
      ? ['验收标准（交结果时逐条对）：', ...task.criteria.map((c, i) => `${i + 1}. ${c}`)].join('\n')
      : '没有给验收标准：交结果前自己想清楚怎样算做完。',
  );
  return parts.join('\n');
}

/** 上一轮停下了、任务还没交：带上 todo 的现状催它接着做。 */
export function continuePrompt(task: AgentTask): string {
  const todos = task.todos.length > 0 ? ['现在的 todo：', ...todoLines(task.todos)].join('\n') : '还没拆 todo。';
  return [
    `子任务 #${task.id} 还没交结果。`,
    todos,
    '接着做：做完一项就用 task_todo 标上；都做完、验收标准都对上了就用 task_finish 交结果；确实做不了就用 task_fail 说明原因。',
  ].join('\n\n');
}

/** 做完以后写回主线程的那段：主线程据此告诉主人。 */
export function resultNote(task: AgentTask): string {
  if (task.state === 'done') return `子任务 #${task.id}「${task.title}」做完了。\n结果：\n${task.result ?? ''}`;
  if (task.state === 'failed') return `子任务 #${task.id}「${task.title}」没做成：${task.error ?? ''}`;
  return `子任务 #${task.id}「${task.title}」${STATE_LABELS[task.state]}。`;
}

const STATUS: Readonly<Record<AgentTaskState, string>> = {
  queued: 'queued',
  running: 'running',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * 子任务结束时交给主线程的通知，照 Claude Code 后台任务的 `<task-notification>`：编号、状态、标题，
 * 做完带结果和逐条验收，没做成带原因。主线程据此用自己的话告诉主人。
 */
export function taskNotification(task: AgentTask): string {
  const parts = [
    '<task-notification>',
    `<task-id>${task.id}</task-id>`,
    `<status>${STATUS[task.state]}</status>`,
    `<title>${task.title}</title>`,
  ];
  if (task.result) parts.push(`<result>\n${task.result}\n</result>`);
  if (task.checks.length > 0) {
    parts.push(
      `<checks>\n${task.checks.map((c) => `${c.met ? '✓' : '✗'} ${c.criterion}：${c.evidence}`).join('\n')}\n</checks>`,
    );
  }
  if (task.error) parts.push(`<error>${task.error}</error>`);
  parts.push('</task-notification>');
  return parts.join('\n');
}

/** 主线程被子任务的通知叫醒时收到的话：通知本身，加上该怎么转告。 */
export function relayPrompt(task: AgentTask): string {
  const how =
    task.state === 'done'
      ? '你派出去的子任务做完了。用一两句话把结论告诉主人，挑最要紧的说；细节在工作台里，不用全念。'
      : '你派出去的子任务没做成。用一两句话告诉主人卡在哪、要主人做什么。';
  return `${taskNotification(task)}\n\n${how}`;
}

/** 转告没成（模型出错）时桌宠说的那句：只报一声，结果在主线程和工作台里。 */
export function announceLine(task: AgentTask, now: Date): Line {
  const tone = toneForHour(now.getHours());
  return {
    text:
      task.state === 'done'
        ? `「${task.title}」做好啦，结果放在工作台里。`
        : `「${task.title}」没做成，原因写在工作台里。`,
    tone,
    cue: TONE_CUES[tone],
    action: '碎碎念-对屏碎碎念',
    kind: 'reminder',
  };
}

/** 主线程每一轮都能看到的：在做和刚结束的子任务。 */
export function tasksFact(tasks: readonly AgentTask[]): string | null {
  if (tasks.length === 0) return null;
  return ['子任务：', ...tasks.map(taskRow)].join('\n');
}
