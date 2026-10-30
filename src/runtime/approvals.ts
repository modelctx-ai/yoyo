/**
 * 批准以后的事：常驻进程每隔一会儿看一遍批准请求（主人在工作台、命令行里批准或拒绝，都只改库里的状态）：
 * 1. 过期：等太久（`files.askTimeout`）没批的，和等批准的子任务已经没了的，按拒绝算，不做。
 * 2. 照做：批准了的，照原参数做一次（`brain/action.ts` 的动作，做之前范围规则再查一遍）。先记下开始做的时间再做，
 *    进程停在中途也不会做第二遍；下次启动把没回话的补一句「中途停了，不知道做成没有」。
 * 3. 交回：有结论的（做完、拒绝、过期）交回去。主线程那一轮要的：写回主会话（`approval` 事件），叫醒主线程转告；
 *    子任务要的：它的请求都有了结论，就把结果当作回答交回去，子任务排回队里接着做。
 * 每一步都记进轨迹。
 */
import { setTimeout as delay } from 'node:timers/promises';

import { eventEntry, type Context } from '@modelctx-ai/ctx';

import { errorText } from '../app/log.ts';
import type { ActionTable } from '../brain/action.ts';
import { APPROVAL_EVENT } from '../brain/context.ts';
import {
  approvalAnswer,
  approvalNote,
  approvalTimedOut,
  expireApproval,
  running,
  settled,
  timeoutNote,
} from '../features/approvals/approvals.ts';
import { TaskError, resumeTask } from '../features/tasks/tasks.ts';
import type { Approval } from '../kernel/types.ts';
import type { Logger, Repos } from '../ports/index.ts';

/** 多久看一遍。点了批准以后常驻进程能马上看（`poke`），命令行点的最多等这么久。 */
export const APPROVAL_POLL_MS = 1000;

export interface ApprovalRunnerDeps {
  readonly repos: Pick<Repos, 'approvals' | 'agentTasks' | 'activity'>;
  readonly logger: Logger;
  /** 批准以后照做：工具名到动作。 */
  readonly actions: ActionTable;
  /** 主线程的上下文：主线程要的那条，结果写回这里。 */
  readonly main: Pick<Context, 'append'>;
  /** 主线程要的那条，结果写回主会话以后叫一声：编排器据此叫醒主线程转告主人。 */
  readonly onDecided?: (approval: Approval) => void;
  /** 等多久没批算过期（毫秒）；不给或 0 不过期。 */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export interface ApprovalRunner {
  /** 看一遍：过期、照做、交回。一遍没做完（上一遍还在跑）就排在后面。 */
  step(): Promise<void>;
  /** 有人刚批准了：不等下一次轮到，马上看一遍。 */
  poke(): void;
  /** 开始，直到 `signal` 中止或 `close`。 */
  start(signal: AbortSignal): void;
  /** 停下：正在做的命令取消，没交回的下次启动再交。 */
  close(): Promise<void>;
}

export function createApprovalRunner(deps: ApprovalRunnerDeps): ApprovalRunner {
  const { repos, logger, actions, main } = deps;
  const clock = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? APPROVAL_POLL_MS;
  const timeoutMs = Math.max(0, deps.timeoutMs ?? 0);
  const stopping = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;
  /** 上一遍进行中有人催：做完马上再看一遍。 */
  let poked = false;
  let loop: Promise<void> | null = null;

  /** 等批准的：子任务已经没在等了（取消、没做成），或者等太久。 */
  function expire(): void {
    for (const approval of repos.approvals.list({ states: ['pending'], limit: 200 })) {
      const at = new Date(clock());
      if (approval.task !== null) {
        const task = repos.agentTasks.get(approval.task);
        if (!task || task.state !== 'waiting') {
          expireApproval(repos, approval.id, `子任务 #${approval.task} 已经不在等了`, at);
          continue;
        }
      }
      if (approvalTimedOut(approval, clock(), timeoutMs)) {
        expireApproval(repos, approval.id, timeoutNote(timeoutMs), at);
        logger.info(`批准请求 #${approval.id} 等太久没批，按拒绝算`);
      }
    }
  }

  /** 批准了的照做；旧的先做。 */
  async function perform(): Promise<void> {
    const approved = repos.approvals.list({ states: ['approved'], limit: 200 }).filter((item) => item.ranAt === null);
    for (const item of approved.toReversed()) {
      if (stopping.signal.aborted) return;
      if (item.task !== null && repos.agentTasks.get(item.task)?.state !== 'waiting') {
        // 批准了，可是子任务已经没了：没处交，不做
        const note = `子任务 #${item.task} 已经不在等了，没有做`;
        repos.approvals.update(item.id, { note, result: note, announcedAt: clock() });
        continue;
      }
      const claimed = repos.approvals.claim(item.id, clock());
      if (!claimed) continue;
      let result: string;
      try {
        const action = actions.get(claimed.tool);
        result = action
          ? await action.perform(JSON.parse(claimed.input) as unknown, stopping.signal)
          : `现在没有 ${claimed.tool} 这个工具了，没有做`;
      } catch (error) {
        logger.warn(`批准请求 #${claimed.id} 照做出错：${errorText(error)}`);
        result = `没做成：${errorText(error)}`;
      }
      repos.approvals.update(claimed.id, { result: result || '（没有输出）' });
      repos.activity.record({ type: 'approval-run', id: claimed.id, tool: claimed.tool, text: claimed.summary });
      logger.info(`批准请求 #${claimed.id} 照做了：${claimed.summary}`);
    }
  }

  /** 主线程要的：写回主会话，叫醒转告。 */
  async function deliverMain(approval: Approval): Promise<void> {
    await main.append(
      eventEntry(APPROVAL_EVENT, { text: approvalNote(approval), meta: { id: approval.id, state: approval.state } }),
    );
    const announced = repos.approvals.update(approval.id, { announcedAt: clock() });
    deps.onDecided?.(announced ?? approval);
  }

  /** 子任务要的：都有了结论就当作回答交回去，没有就接着等。 */
  function deliverTask(id: number, items: readonly Approval[]): void {
    const task = repos.agentTasks.get(id);
    const unfinished = repos.approvals.list({ task: id }).some((item) => item.announcedAt === null && !settled(item));
    if (task?.state === 'waiting' && unfinished) return;
    if (task?.state === 'waiting') {
      try {
        resumeTask(repos, id, approvalAnswer(items.toReversed()), new Date(clock()));
        logger.info(`子任务 #${id} 要批准的事都有结论了，接着做`);
      } catch (error) {
        if (!(error instanceof TaskError)) throw error;
        logger.warn(error.message);
      }
    }
    for (const item of items) repos.approvals.update(item.id, { announcedAt: clock() });
  }

  async function deliver(): Promise<void> {
    const ready = repos.approvals.list({ limit: 200 }).filter((item) => item.announcedAt === null && settled(item));
    const byTask = new Map<number, Approval[]>();
    for (const item of ready.toReversed()) {
      if (item.task === null) await deliverMain(item);
      else byTask.set(item.task, [...(byTask.get(item.task) ?? []), item]);
    }
    for (const [id, items] of byTask) deliverTask(id, items.toReversed());
  }

  async function once(): Promise<void> {
    expire();
    await perform();
    await deliver();
  }

  function step(): Promise<void> {
    const next = chain.then(once);
    chain = next.catch((error: unknown) => logger.error(`批准请求出错：${errorText(error)}`));
    return next;
  }

  /** 上次停在中途的：开始做了、没回话。不重做，补一句。 */
  function recover(): void {
    for (const item of repos.approvals.list({ states: ['approved'], limit: 200 })) {
      if (item.ranAt !== null && running(item)) {
        repos.approvals.update(item.id, { result: '做到一半 yoyo 停了，不知道做成没有，看一眼再说' });
        logger.info(`批准请求 #${item.id} 上次做到一半停了，没有重做`);
      }
    }
  }

  return {
    step,
    poke() {
      poked = true;
      wake?.();
    },
    start(signal) {
      if (loop) return;
      const stop = AbortSignal.any([signal, stopping.signal]);
      loop = (async () => {
        recover();
        while (!stop.aborted) {
          poked = false;
          await step().catch(() => {});
          if (poked) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
            delay(pollMs, undefined, { signal: stop }).then(resolve, resolve);
          });
          wake = null;
        }
      })().catch((error: unknown) => logger.error(`批准请求停了：${errorText(error)}`));
    },
    async close() {
      stopping.abort();
      wake?.();
      await loop;
      await chain;
    },
  };
}
