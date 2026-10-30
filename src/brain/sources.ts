import { defineSource, type ContextSource } from '@modelctx-ai/ctx';

import { latestClip } from '../features/clipboard/clipboard.ts';
import { tasksFact } from '../features/tasks/tasks.ts';
import type { PetHost, Repos } from '../ports/index.ts';

export interface TaskDeps {
  readonly host: Pick<PetHost, 'workStatus'>;
  readonly repos: Pick<Repos, 'tasks'>;
}

/** 桌宠的工作状态（任务优先，没有就用状态），再加本地任务的前 5 条；都没有是空串。 */
export async function currentTask(deps: TaskDeps): Promise<string> {
  let task = '';
  try {
    const status = await deps.host.workStatus();
    if (typeof status?.task === 'string' && status.task.trim()) task = status.task.trim();
    else if (typeof status?.state === 'string' && status.state) task = status.state;
  } catch {
    /* 工作状态读不到就当没有任务 */
  }
  try {
    const extra = deps.repos.tasks.list().slice(0, 5);
    if (extra.length) task = [task, ...extra].filter(Boolean).join('；');
  } catch {
    /* 本地任务是可选的 */
  }
  return task.trim();
}

/** 当前任务，见 `currentTask`。 */
export function taskSource(deps: TaskDeps): ContextSource {
  return defineSource('task', async () => {
    const task = await currentTask(deps);
    return task ? `当前任务：${task}` : null;
  });
}

/** 还在排队、在做和等回答的子任务：主线程每一轮都看得到，主人问起不用再查；等回答的带着问题，等批准的列出要批准什么。 */
export function agentTasksSource(repos: Pick<Repos, 'agentTasks' | 'approvals'>): ContextSource {
  return defineSource('tasks', () =>
    tasksFact(
      repos.agentTasks.list({ states: ['queued', 'running', 'waiting'], limit: 10 }),
      repos.approvals.list({ states: ['pending'], limit: 50 }).toReversed(),
    ),
  );
}

/** 最近一次复制的内容，前 160 字。 */
export function clipboardSource(repos: Pick<Repos, 'clipboard'>): ContextSource {
  return defineSource('clipboard', () => {
    const clip = latestClip(repos).trim();
    return clip ? `粘贴板：${clip.slice(0, 160)}` : null;
  });
}
