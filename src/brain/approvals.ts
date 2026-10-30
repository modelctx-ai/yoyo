/**
 * 先问的记录那一头：模型调了开关是 `ask` 的工具，这里建一条批准请求（`features/approvals`），
 * 按这一轮是谁的决定怎么回模型：
 * 主线程那一轮（回复、右键对话、工作台聊天）：不当场等，一轮有时限、桌宠在等回话；工具立刻回「要主人批准、还没做」，
 *   模型据此告诉主人。批准以后常驻进程照做，结果写回主会话并叫醒主线程转告。
 * 子任务：复用「中途问主人」的等回答：子任务进入「等回答」，问题就是这条请求的摘要，这一轮到此为止；
 *   主人批准或拒绝以后，常驻进程把结果当作回答交回去，子任务排回队里接着做。
 * 同一个子任务一步里调了几个要批准的工具，都记下来，一起等。
 */
import { taskOfSession } from './context.ts';
import type { ApprovalGate } from './action.ts';
import { approvalQuestion, mainReply, requestApproval, taskReply } from '../features/approvals/approvals.ts';
import { STATE_LABELS, TaskError, askTask, pendingApprovals } from '../features/tasks/tasks.ts';
import type { Repos } from '../ports/index.ts';

export interface ApprovalGateDeps {
  readonly repos: Pick<Repos, 'approvals' | 'agentTasks' | 'activity'>;
  readonly now?: () => Date;
}

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const { repos } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    request(call) {
      const id = taskOfSession(call.session);
      const common = { tool: call.tool, summary: call.summary, input: call.input, runId: call.runId };
      if (id === null) return mainReply(requestApproval(repos, { ...common, task: null }, now()));
      const task = repos.agentTasks.get(id);
      if (!task || (task.state !== 'running' && task.state !== 'waiting')) {
        const state = task ? `现在是「${STATE_LABELS[task.state]}」` : '不在了';
        throw new TaskError(`子任务 #${id} ${state}，不能再要批准`);
      }
      const approval = requestApproval(repos, { ...common, task: id }, now());
      const question = approvalQuestion(pendingApprovals(repos, id));
      if (task.state === 'running') askTask(repos, id, question, now());
      // 同一步里又来一个：已经在等了，只更新要问的话
      else repos.agentTasks.update(id, { question }, now().getTime());
      return taskReply(approval);
    },
  };
}
