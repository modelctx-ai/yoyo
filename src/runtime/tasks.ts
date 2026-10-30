/**
 * 子任务怎么跑：常驻进程里同时做几件（`tasks.concurrency`），多的排队，按编号先后。各自的会话、各自的取消，
 * 一件出错、取消、超时不碍着别的。子 agent 在自己的会话（`task:<编号>`）上跑，
 * 输入、工具调用和结果都记进那个会话的日志，工作台里能看着它做。规则（拆 todo、标状态、验收）在
 * `features/tasks` 和子 agent 的工具里，这里只管轮次：一轮停下了但还没交结果，就带着 todo 的现状催它接着做，
 * 最多 `MAX_ROUNDS` 轮。做完、没做成、取消，都把结果写回主线程（主会话的 `task` 事件），主线程下一轮就看得到。
 */
import { setTimeout as delay } from 'node:timers/promises';

import { eventEntry, type AgentSpec, type Context, type LanguageModel, type Orchestrator } from '@modelctx-ai/ctx';

import { errorText } from '../app/log.ts';
import { taskAgent } from '../brain/agents.ts';
import { run } from '../brain/compose.ts';
import { TASK_EVENT, taskSession } from '../brain/context.ts';
import { agentTools, mergeAgents, type AgentProfile } from '../features/tasks/agents.ts';
import { continuePrompt, failTask, resultNote, taskBrief } from '../features/tasks/tasks.ts';
import type { AgentTask } from '../kernel/types.ts';
import type { Logger, Repos } from '../ports/index.ts';

/** 一个子任务最多跑几轮。每轮里子 agent 最多走 `TASK_AGENT.maxSteps` 步。 */
export const MAX_ROUNDS = 6;
/** 没事做时多久看一次有没有排队的；在做时多久看一次被取消了没有。 */
export const TASK_POLL_MS = 2000;

export interface TaskRunnerDeps {
  readonly repos: Pick<Repos, 'agentTasks' | 'activity' | 'artifacts'>;
  readonly logger: Logger;
  /** 子任务专用的编排器：`record: true`，配了自己的 `owner`，开始前先 `recover`。 */
  readonly runs: Pick<Orchestrator, 'submit' | 'recover'>;
  readonly model: LanguageModel | null;
  /** 主线程的上下文：结果写回这里。 */
  readonly main: Pick<Context, 'append'>;
  /** 结果写回主会话以后叫一声：编排器据此叫醒主线程转告主人。 */
  readonly onFinished?: (task: AgentTask) => void;
  /** 子 agent 收哪些事实来源；不给就全部。 */
  readonly sources?: readonly string[];
  /** 有哪些子 agent 类型；不给就只有内置的。 */
  readonly agents?: readonly AgentProfile[];
  /** 子 agent 那份注册表里有哪些工具，按类型的清单挑。 */
  readonly toolNames?: () => readonly string[];
  /** 类型写了 `model` 时用的模型（服务商和密钥照 `llm`）；不给就都用 `model`。 */
  readonly modelFor?: (id: string) => LanguageModel | null;
  /** 报错里要抹掉的密钥。 */
  readonly secrets?: readonly string[];
  /** 同时做几件；不给是 1。 */
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export interface TaskRunner {
  /** 开始做，同时最多 `concurrency` 件，直到 `signal` 中止或 `close`。 */
  start(signal: AbortSignal): void;
  /** 有排队的就做最早的那个，做完返回它；没有返回 null。 */
  runNext(signal?: AbortSignal): Promise<AgentTask | null>;
  /** 正在做的子任务编号。 */
  active(): number[];
  /** 停下：正在做的都取消这一轮，放回排队，下次启动接着做。 */
  close(): Promise<void>;
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { repos, logger, runs, model, main } = deps;
  const profiles = deps.agents ?? mergeAgents([]);
  const clock = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? TASK_POLL_MS;
  const limit = Math.max(1, Math.floor(deps.concurrency ?? 1));
  const stopping = new AbortController();
  /** 正在做的：编号到它那件事。 */
  const working = new Map<number, Promise<unknown>>();
  let loop: Promise<void> | null = null;
  let warned = false;

  /** 排队的里编号最小、还没在做的。 */
  function oldestQueued(): AgentTask | null {
    const queued = repos.agentTasks.list({ states: ['queued'], limit: 500 }).filter((task) => !working.has(task.id));
    return queued.at(-1) ?? null;
  }

  /** 空着几个位置就从排队的里补几个。 */
  function fill(signal: AbortSignal): void {
    while (working.size < limit) {
      const next = oldestQueued();
      if (!next) return;
      const job = work(next, signal)
        .catch((error: unknown) => logger.error(`子任务 #${next.id} 出错：${errorText(error)}`))
        .finally(() => working.delete(next.id));
      working.set(next.id, job);
    }
  }

  /** 上次没做完就停了（常驻进程退出、崩溃）：放回排队，接着做。 */
  function requeueStale(): void {
    for (const task of repos.agentTasks.list({ states: ['running'] })) {
      repos.agentTasks.update(task.id, { state: 'queued' }, clock());
      logger.info(`子任务 #${task.id} 上次没做完，放回排队`);
    }
  }

  async function work(task: AgentTask, outer: AbortSignal | undefined): Promise<AgentTask> {
    if (!model) throw new Error('没配 llm，子任务做不了');
    const resumed = task.startedAt !== null;
    repos.agentTasks.update(task.id, { state: 'running', ...(resumed ? {} : { startedAt: clock() }) }, clock());
    logger.info(`子任务 #${task.id} ${resumed ? '接着做' : '开始'}：${task.title}`);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    outer?.addEventListener('abort', stop, { once: true });
    stopping.signal.addEventListener('abort', stop, { once: true });
    // 命令行、工作台在别的地方取消：看到就停下这一轮
    const watch = setInterval(() => {
      if (repos.agentTasks.get(task.id)?.state === 'cancelled') controller.abort();
    }, pollMs);
    watch.unref();
    try {
      const agent = agentFor(task, model);
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        const current = repos.agentTasks.get(task.id);
        if (!current || current.state !== 'running') break;
        const input = round === 1 && !resumed ? taskBrief(current) : continuePrompt(current);
        await run(
          runs,
          { session: taskSession(task.id), agent, input, record: true, signal: controller.signal },
          deps.secrets,
        );
      }
      if (repos.agentTasks.get(task.id)?.state === 'running') {
        failTask(repos, task.id, `跑了 ${MAX_ROUNDS} 轮还没交结果`, new Date(clock()));
      }
    } catch (error) {
      const state = repos.agentTasks.get(task.id)?.state;
      if (state === 'running' && controller.signal.aborted && !isCancelled(task.id)) {
        // 常驻进程要停：放回排队，下次接着做
        repos.agentTasks.update(task.id, { state: 'queued' }, clock());
        logger.info(`子任务 #${task.id} 先停下，下次接着做`);
        return repos.agentTasks.get(task.id) ?? task;
      }
      if (state === 'running') failTask(repos, task.id, errorText(error), new Date(clock()));
    } finally {
      clearInterval(watch);
      outer?.removeEventListener('abort', stop);
      stopping.signal.removeEventListener('abort', stop);
    }
    const final = repos.agentTasks.get(task.id) ?? task;
    // 结果写回主线程：主线程下一轮看得到，工作台的主聊天里也有
    const artifacts = repos.artifacts.list({ task: final.id });
    await main.append(
      eventEntry(TASK_EVENT, { text: resultNote(final, artifacts), meta: { id: final.id, state: final.state } }),
    );
    deps.onFinished?.(final);
    logger.info(`子任务 #${final.id} ${final.state === 'done' ? '做完了' : `停在「${final.state}」`}`);
    return final;
  }

  /** 按子任务的类型配子 agent：指令、工具清单、模型。没有这种类型就报错，记成没做成。 */
  function agentFor(task: AgentTask, fallback: LanguageModel): AgentSpec {
    const profile = profiles.find((item) => item.name === task.agent);
    if (!profile) throw new Error(`没有「${task.agent}」这种子 agent，有：${profiles.map((p) => p.name).join('、')}`);
    const chosen = profile.model ? deps.modelFor?.(profile.model) : null;
    if (profile.model && !chosen)
      logger.warn(`子 agent ${profile.name} 的模型 ${profile.model} 建不起来，先用 llm.model`);
    return taskAgent(chosen ?? fallback, profile, {
      tools: agentTools(profile, deps.toolNames?.() ?? []),
      ...(deps.sources ? { sources: deps.sources } : {}),
    });
  }

  function isCancelled(id: number): boolean {
    return repos.agentTasks.get(id)?.state === 'cancelled';
  }

  async function runNext(signal?: AbortSignal): Promise<AgentTask | null> {
    const next = oldestQueued();
    if (!next) return null;
    return work(next, signal);
  }

  return {
    runNext,
    active: () => [...working.keys()].toSorted((a, b) => a - b),
    start(signal) {
      if (loop) return;
      loop = (async () => {
        await runs.recover?.();
        requeueStale();
        const stop = AbortSignal.any([signal, stopping.signal]);
        while (!stop.aborted) {
          if (!model) {
            if (!warned && oldestQueued()) logger.warn('有子任务在排队，但没配 llm，做不了');
            warned = true;
          } else {
            fill(signal);
          }
          // 有一件做完就马上补位，不然隔一会儿看一次有没有新排队的
          const tick = delay(pollMs, undefined, { signal: stop }).catch(() => {});
          await Promise.race([tick, ...working.values()]);
        }
        await Promise.allSettled(working.values());
      })().catch((error: unknown) => logger.error(`子任务停了：${errorText(error)}`));
    },
    async close() {
      stopping.abort();
      await loop;
      await Promise.allSettled(working.values());
    },
  };
}
