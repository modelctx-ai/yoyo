import { defineSource, type ContextSource } from '@modelctx-ai/ctx';

import { latestClip } from '../features/clipboard/clipboard.ts';
import type { PetHost, Repos } from '../ports/index.ts';

/** 桌宠的工作状态（任务优先，没有就用状态），再加本地任务的前 5 条。 */
export function taskSource(deps: {
  readonly host: Pick<PetHost, 'workStatus'>;
  readonly repos: Pick<Repos, 'tasks'>;
}): ContextSource {
  return defineSource('task', async () => {
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
    return task.trim() ? `当前任务：${task.trim()}` : null;
  });
}

/** 最近一次复制的内容，前 160 字。 */
export function clipboardSource(repos: Pick<Repos, 'clipboard'>): ContextSource {
  return defineSource('clipboard', () => {
    const clip = latestClip(repos).trim();
    return clip ? `粘贴板：${clip.slice(0, 160)}` : null;
  });
}
