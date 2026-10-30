import {
  assistantEntry,
  createOrchestrator,
  redact,
  userEntry,
  type Context,
  type Harness,
  type LanguageModel,
  type Orchestrator,
  type OrchestratorEvent,
  type RecoveredRun,
} from '@modelctx-ai/ctx';

import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import type { FactSources } from '../brain/agents.ts';
import { generateChat, generateRelay, generateReply, generateWhisper } from '../brain/compose.ts';
import { OWNER_TOOL_NAMES } from '../brain/files.ts';
import { recordUser } from '../brain/context.ts';
import { memorySecrets, type YoyoMemory } from '../brain/memory.ts';
import { fixedPacer, paceSecrets } from '../brain/pace.ts';
import { dueItems } from '../features/alarms/schedule.ts';
import { notePaste } from '../features/clipboard/clipboard.ts';
import { wantsReply } from '../features/listen/listen.ts';
import { shouldSearch } from '../features/search/question.ts';
import { approvalAnnounceLine, approvalRelayPrompt } from '../features/approvals/approvals.ts';
import { announceLine, needsRelay, pendingApprovals, relayPrompt } from '../features/tasks/tasks.ts';
import type { AgentTask, Approval } from '../kernel/types.ts';
import { nextWhisperAt, type PaceDecision, type PaceInput } from '../kernel/pace.ts';
import { localDateKey, minutesOf } from '../kernel/time.ts';
import { toneForHour } from '../kernel/tone.ts';
import type { ActivityEvent, Line, Tone } from '../kernel/types.ts';
import type { Clipboard, Logger, Repos, WebSearch, WhisperPacer } from '../ports/index.ts';
import type { Director } from './director.ts';
import { drain } from './inbox.ts';

export const TICK_MS = 1000;
/** 离下一句日常碎碎念还有这么久，才趁空去找表情包。 */
export const MEME_LEAD_MS = 20_000;
/** 上下文多久看一次要不要压缩。 */
export const COMPACT_EVERY_MS = 10 * 60 * 1000;
/** 到点的碎碎念没说成（桌宠没开、锁被占着之类），隔这么久再试，不每秒重来。 */
export const WHISPER_RETRY_MS = 60_000;
/** 找表情包失败以后，隔这么久再找。 */
export const MEME_RETRY_MS = 10 * 60 * 1000;

/** 主人这么久没说话，才整理记忆。 */
export const CONSOLIDATE_IDLE_MS = 30 * 60 * 1000;
/** 整理一次记忆最多等这么久。 */
export const CONSOLIDATE_TIMEOUT_MS = 10 * 60 * 1000;
/** kv 里记下最近一次夜里整理成功的本地日期。 */
export const CONSOLIDATED_KEY = 'memory-consolidated';

/** 两句日常碎碎念的间隔：至少一分钟，缺省 5 分钟。 */
export function whisperIntervalMs(intervalSec: number): number {
  return Math.max(60, intervalSec || 300) * 1000;
}

export function memeIdle(now: number, nextWhisper: number): boolean {
  return now + MEME_LEAD_MS < nextWhisper;
}

/** 空闲，而且上次失败已经过了 10 分钟，才去找表情包。 */
export function memeDue(now: number, nextWhisper: number, failedAt: number | null): boolean {
  return memeIdle(now, nextWhisper) && (failedAt === null || now - failedAt >= MEME_RETRY_MS);
}

export type WhisperStep =
  | { readonly kind: 'wait' }
  | { readonly kind: 'delay'; readonly until: number }
  | { readonly kind: 'speak' };

/** 没到点就等；到点了但 30 秒内还有对话就顺延；否则开口。 */
export function whisperStep(nextWhisper: number, lastTalk: number, now: number): WhisperStep {
  if (now < nextWhisper) return { kind: 'wait' };
  const shifted = nextWhisperAt(nextWhisper, lastTalk, now);
  return shifted > now ? { kind: 'delay', until: shifted } : { kind: 'speak' };
}

/** 行为记录里的一条 `pace`：从哪来、隔多少秒，决策的还有挑的档和把握，退回的有原因。 */
export function paceActivity(pace: PaceDecision): ActivityEvent {
  const base = { type: 'pace', source: pace.source, sec: Math.round(pace.ms / 1000) };
  if (pace.source === 'fixed') return base;
  if (pace.source === 'decided') {
    return { ...base, option: pace.option, confidence: Math.round(pace.confidence * 100) / 100 };
  }
  return { ...base, reason: pace.reason };
}

/** 说完一句以后的下一句：隔一个间隔；刚有人说话，还要等对话停下来。 */
export function nextAfterSpeak(now: number, intervalMs: number, lastTalk: number): number {
  return nextWhisperAt(now + intervalMs, lastTalk, now);
}

/** 配了 `context.compactAt` 才压缩，而且每 10 分钟最多看一次。 */
export function compactDue(config: Pick<Config, 'context'>, now: number, lastCheck: number | null): boolean {
  if (!config.context.compactAt) return false;
  return lastCheck === null || now - lastCheck >= COMPACT_EVERY_MS;
}

/**
 * 记忆该不该整理了：本地时间到了 `consolidateAt`，今天还没整理过（`doneOn` 是整理过的日期），
 * 主人 30 分钟没说话。待处理的笔记有没有由调用方再看。
 */
export function consolidateDue(at: string, now: Date, lastTalk: number, doneOn: string | null): boolean {
  const start = minutesOf(at);
  if (start === null || now.getHours() * 60 + now.getMinutes() < start) return false;
  if (doneOn === localDateKey(now)) return false;
  return now.getTime() - lastTalk >= CONSOLIDATE_IDLE_MS;
}

/** 工作台里聊的那几条的来源，日志里和桌宠对话（`dsh-pet`）、语音分得开。 */
export const WORKBENCH_SOURCE = 'workbench';

export interface ScheduleState {
  /** 下一句日常碎碎念的时间（毫秒）。 */
  nextWhisper: number;
  /** 最近一次对话、听写或提醒结束的时间。 */
  lastTalk: number;
  /** 最近一次看要不要压缩上下文的时间。 */
  lastCompact: number | null;
  /** 最近一次找表情包失败的时间。 */
  memeFailedAt: number | null;
  /** 最近一次说完以后，下一句的间隔是怎么定的；还没说过是 null。 */
  lastPace: PaceDecision | null;
  /** 连着几句日常碎碎念没人回应；主人回应了或有过对话就清零。 */
  unanswered: number;
}

export interface PerformResult {
  readonly line: Line;
  /** 用户这次有没有开口（取消发送也算）。 */
  readonly talked: boolean;
}

export interface YoyoOrchestratorDeps {
  readonly config: Config;
  readonly paths: Paths;
  readonly logger: Logger;
  readonly repos: Repos;
  readonly clipboard: Clipboard;
  readonly search: WebSearch | null;
  /** 跑在它的会话上；事实和视图也从它取。 */
  readonly context: Context;
  readonly harness: Harness;
  readonly director: Director;
  readonly model: LanguageModel | null;
  /** 两个 agent 各收哪些来源；不给就都收全部来源。 */
  readonly factSources?: FactSources;
  /** `memory.enabled` 打开时才有：拍子末尾门控，夜里整理。 */
  readonly memory?: YoyoMemory | null;
  /** 回复那份注册表里现在有哪些工具；转告那一轮按它去掉读写文件的。不给就全给。 */
  readonly toolNames?: () => readonly string[];
  /** 说完一句以后决定隔多久说下一句；不给就是固定的 `intervalSec`。挑哪种由组装根按 `pace` 配置定。 */
  readonly pacer?: WhisperPacer;
  /** 毫秒时钟，缺省 `Date.now`。 */
  readonly clock?: () => number;
  /** 一开始的排期，缺省马上说第一句。 */
  readonly state?: Partial<ScheduleState>;
}

/**
 * yoyo 的编排器：ctx 的 `Orchestrator`，再加上 yoyo 什么时候开口的策略。
 * 协议的几样（`submit`、`status`、`cancel`、`events`、`recover`、`close`）交给 ctx 的进程内队列：同一会话串行，一个 harness。
 */
export interface YoyoOrchestrator extends Orchestrator {
  recover(): Promise<RecoveredRun[]>;
  events(options?: { readonly signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  /** 说一句碎碎念：天气或预制台词，都说过了再让模型写一句；念完要回应就听，听到就回复。 */
  whisper(now?: Date): Promise<PerformResult | null>;
  /** 马上听一句，听到就回复。 */
  listen(now?: Date): Promise<{ readonly talked: boolean }>;
  /**
   * 桌宠右键对话的一句：和回复同一个 agent（记忆、工具、搜索），返回整段回复。不写日志，
   * 这一问一答由桌宠记进它的对话记忆，下一拍并进来。算作说过话，碎碎念照样让路。
   */
  chat(text: string, signal?: AbortSignal): Promise<string>;
  /**
   * 工作台里打的一句：和右键对话同一个 agent，问答记进日志（来源 `workbench`），桌宠那边不念、不冒泡。
   * 算作说过话，碎碎念照样让路。
   */
  talk(text: string, signal?: AbortSignal): Promise<string>;
  /**
   * 子任务结束了或提了问题（结果、问题已经写回主会话）：排进来，下一拍叫醒主线程转告主人。照 Claude Code 后台任务的
   * `<task-notification>`：通知进主线程，主线程用自己的话告诉主人。
   */
  relayTask(id: number): void;
  /**
   * 主线程要的一件事（开关是 `ask` 的工具）有了结论，结果已经写回主会话：排进来，下一拍叫醒主线程转告主人，
   * 批准了讲结果，拒绝或过期了也说一句。进程在转告前停了就不补：结果已经在主会话里，主线程下一轮看得到。
   */
  relayApproval(id: number): void;
  /** 桌宠自己的「碎碎念」（右键里没藏起来时）：交给碎碎念的 agent 写一句，返回正文。不写日志。 */
  petWhisper(signal?: AbortSignal): Promise<string>;
  /**
   * 一拍：粘贴板、桌宠对话、收件箱、到点提醒、空闲找图、碎碎念让路、上下文压缩，打开记忆时再加门控和夜里的整理。
   * 上一拍没走完就跳过。门控和整理在后台跑，不等。
   */
  tick(): Promise<void>;
  /** 每秒一拍，直到 `signal` 中止或 `close`。中止时正在跑的模型也一起取消。 */
  start(signal?: AbortSignal): void;
  readonly state: ScheduleState;
}

/**
 * 转告那一轮给哪些工具：这一轮是 yoyo 自己发起的，没有主人看着，工具照给，读写文件和跑命令的不给。
 * 不知道注册表里有哪些（`names` 没给）就全给，那时也没有这些。
 */
export function relayTools(enabled: boolean, names: readonly string[] | undefined): boolean | readonly string[] {
  if (!enabled) return false;
  return names ? names.filter((name) => !OWNER_TOOL_NAMES.includes(name)) : true;
}

export function createYoyoOrchestrator(deps: YoyoOrchestratorDeps): YoyoOrchestrator {
  const { config, paths, logger, repos, clipboard, search, context, harness, director, model, factSources } = deps;
  const memory = deps.memory ?? null;
  const clock = deps.clock ?? Date.now;
  const runs = createOrchestrator({ harness, store: context.store, logger });
  // 报错里抹掉的密钥：模型的，加上记忆的决策、提取模型的，和碎碎念间隔的决策模型的
  const secrets = [config.llm.apiKey, ...memorySecrets(config.memory), ...paceSecrets(config.pace)].filter(Boolean);
  const intervalMs = whisperIntervalMs(config.intervalSec);
  const pacer = deps.pacer ?? fixedPacer(intervalMs);
  const state: ScheduleState = {
    nextWhisper: clock(),
    lastTalk: 0,
    lastCompact: null,
    memeFailedAt: null,
    lastPace: null,
    unanswered: 0,
    ...deps.state,
  };
  /** 上一句日常碎碎念开口的时间：这以后主人说过话，就算回应了。 */
  let lastSpokeAt = 0;
  /** 常驻时随拍子一起停：停下以后，正在跑的模型不再等。 */
  const stopping = new AbortController();
  let busy = false;
  let started = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  /** 记忆的后台活：停下或关闭时取消。 */
  const memoryWork = new AbortController();
  /** 写过用户话或回复、还没门控过。门控跳过时留着，下一拍再跑。 */
  let wrote = false;
  /**
   * 等着转告的子任务：结束了的，和提了问题、在等主人回答的。子任务的跑法在结果（问题）写回主会话以后才交过来，
   * 所以转告时主线程已经看得到。结束的和提问的排在同一条队列里，一个一个说。
   * 上次没转告完就停了的，开始时补上。
   */
  const relayQueue = new Set<number>(
    config.tasks.enabled
      ? repos.agentTasks
          .list({ states: ['waiting', 'done', 'failed', 'cancelled'], limit: 20 })
          .filter(needsRelay)
          .map((task) => task.id)
      : [],
  );
  /** 等着转告的批准请求编号。 */
  const approvalQueue = new Set<number>();
  let gating: Promise<void> | null = null;
  let consolidating: Promise<void> | null = null;
  /** 可能有待处理的笔记：启动时不知道，门控写下待处理的笔记以后又有了。 */
  let mayHaveNotes = true;
  /** 这个进程里整理失败过的日期：当天不再试。 */
  let failedOn: string | null = null;

  /** 记忆出错只记一行：抹掉密钥，压成一行，截短。 */
  function memoryError(what: string, error: unknown): void {
    const text = redact(errorText(error), secrets).replace(/\s+/g, ' ').trim().slice(0, 180);
    logger.warn(`${what}：${text}`);
  }

  /** 这一拍写过用户话或回复就门控一次，不等它；上一次还没完就跳过这次。 */
  function gateMemory(): void {
    if (!memory || !wrote || gating || memoryWork.signal.aborted) return;
    wrote = false;
    gating = (async () => {
      const notes = await memory.memory.gate(context.session, { signal: memoryWork.signal });
      if (notes.some((note) => note.settledAt === undefined)) mayHaveNotes = true;
    })()
      .catch((error: unknown) => memoryError('记忆门控没做成', error))
      .finally(() => {
        gating = null;
      });
  }

  /** 到了整理的时间、主人不在、有待处理的笔记，就在后台整理一次，最多 10 分钟。 */
  function consolidateMemory(): void {
    if (!memory || consolidating || !mayHaveNotes || memoryWork.signal.aborted) return;
    const now = new Date(clock());
    const day = localDateKey(now);
    const doneOn = failedOn === day ? day : repos.kv.get(CONSOLIDATED_KEY);
    if (!consolidateDue(config.memory.consolidateAt, now, state.lastTalk, doneOn)) return;
    consolidating = (async () => {
      const pending = await memory.store.notes.list({ pending: true, limit: 1 });
      if (pending.length === 0) {
        mayHaveNotes = false;
        return;
      }
      if (!model) logger.warn('没配 llm：记忆整理只做衰减归档和画像的缺省渲染，反思和画像重写跳过');
      const signal = AbortSignal.any([memoryWork.signal, AbortSignal.timeout(CONSOLIDATE_TIMEOUT_MS)]);
      try {
        const report = await memory.memory.consolidate({ now: clock(), signal });
        repos.kv.set(CONSOLIDATED_KEY, day);
        const { facts, procedures } = report;
        repos.activity.record({
          type: 'memory-consolidate',
          notes: report.notes,
          added: facts.added,
          merged: facts.merged,
          superseded: facts.superseded,
          archived: facts.archived,
          rules: procedures.added,
          confirmed: procedures.confirmed,
          core: report.core,
        });
        logger.info(
          `记忆整理了 ${report.notes} 条笔记：新增 ${facts.added} 条事实，并入 ${facts.merged}，取代 ${facts.superseded}，归档 ${facts.archived}`,
        );
      } catch (error) {
        failedOn = day;
        throw error;
      }
    })()
      .catch((error: unknown) => memoryError('记忆没整理成', error))
      .finally(() => {
        consolidating = null;
      });
  }

  /** 停下常驻循环时取消；调用方另给的（比如桌宠断开）也算。 */
  function runSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([stopping.signal, signal]) : stopping.signal;
  }

  /** 按最近的对话和任务写一句碎碎念。 */
  function writeWhisper(now: Date, llm: LanguageModel, signal?: AbortSignal): Promise<Line> {
    return generateWhisper(context, orchestrator, {
      tone: toneForHour(now.getHours()),
      model: llm,
      secrets,
      signal: runSignal(signal),
      ...(factSources ? { sources: factSources.whisper } : {}),
    });
  }

  /** 预制台词都说过了：有模型就按最近的对话和任务写一句。 */
  async function written(now: Date): Promise<Line | null> {
    if (!model) return null;
    logger.info('预制台词用完了，按最近的对话和任务写一句');
    return writeWhisper(now, model);
  }

  /** 像提问就先搜一下。打开工具时由模型自己决定搜不搜，不再先按问句搜一遍。 */
  async function lookUp(heard: string): Promise<string> {
    if (!search || config.llm.tools || !shouldSearch(heard)) return '';
    try {
      const found = await search.search(heard);
      if (found) repos.activity.record({ type: 'search', query: heard });
      return found;
    } catch (error) {
      logger.warn(`搜索没做成：${errorText(error)}`);
      return '';
    }
  }

  /** 先记下主人这句，再跑回复这一轮，说出来。 */
  async function reply(heard: string, tone: Tone, now: Date, llm: LanguageModel): Promise<void> {
    const searchText = await lookUp(heard);
    await recordUser(context, heard, now.getTime());
    wrote = true;
    const line = await generateReply(context, orchestrator, {
      tone,
      model: llm,
      secrets,
      tools: config.llm.tools,
      signal: stopping.signal,
      ...(factSources ? { sources: factSources.reply } : {}),
      ...(searchText ? { searchText } : {}),
    });
    await director.speak(line, now);
  }

  async function whisper(now = new Date(clock())): Promise<PerformResult | null> {
    const chosen = (await director.choose(now)) ?? (await written(now));
    if (!chosen) {
      logger.info('这 3 小时里的碎碎念都说过了，这次先停');
      repos.activity.record({ type: 'whisper-skip' });
      return null;
    }
    const line = director.dress(chosen);
    await director.speak(line, now);
    if (!model) return { line, talked: false };
    try {
      if (!wantsReply(chosen, config.listen)) return { line, talked: false };
      const accepted = await director.hear();
      if (accepted === null) return { line, talked: false };
      if (accepted) await reply(accepted, chosen.tone, now, model);
      return { line, talked: true };
    } catch (error) {
      logger.warn(`没听成：${errorText(error)}`);
    }
    return { line, talked: false };
  }

  async function listen(now = new Date(clock())): Promise<{ readonly talked: boolean }> {
    repos.activity.record({ type: 'listen-request' });
    const accepted = await director.hear();
    if (accepted === null) {
      logger.info('没听到');
      return { talked: false };
    }
    if (accepted && model) await reply(accepted, toneForHour(now.getHours()), now, model);
    return { talked: true };
  }

  async function chat(text: string, signal?: AbortSignal): Promise<string> {
    if (!model) throw new Error('没配 llm，右键对话回不了');
    state.lastTalk = clock();
    try {
      const searchText = await lookUp(text);
      const answer = await generateChat(context, orchestrator, {
        text,
        tone: toneForHour(new Date(clock()).getHours()),
        model,
        secrets,
        tools: config.llm.tools,
        signal: runSignal(signal),
        ...(factSources ? { sources: factSources.reply } : {}),
        ...(searchText ? { searchText } : {}),
      });
      logger.info(`右键对话回了 ${answer.length} 字`);
      return answer;
    } finally {
      state.lastTalk = clock();
    }
  }

  async function talk(text: string, signal?: AbortSignal): Promise<string> {
    const at = clock();
    const answer = await chat(text, signal);
    // 回上来了才记：没回成的那句不留在日志里，工作台上提示一声就好
    await context.append(
      userEntry(text, { at, source: WORKBENCH_SOURCE }),
      assistantEntry(answer, { at: Math.max(clock(), at + 1), source: WORKBENCH_SOURCE }),
    );
    repos.activity.record({ type: 'chat-workbench', text });
    return answer;
  }

  /**
   * 子任务结束或提问后排进来的通知，按先后处理：做完、没做成和在等回答的叫醒主线程跑一轮，把通知交给它，
   * 它用一两句话转告、桌宠说出来（`tasks.notify` 关着就不叫醒，结果和问题照样在主会话里）；取消的不叫醒。
   * 转告没成（模型出错）就说一句固定的。处理过的记下来，不再说：结束的记 `announcedAt`，
   * 问题记 `questionAnnouncedAt`（答了又问的新问题会清掉它，能再转告）。
   * 排队时已经不用说的（问题已经被回答了、转告过了）跳过。
   */
  async function relayTasks(now: Date): Promise<void> {
    const ids = [...relayQueue].toSorted((a, b) => a - b);
    relayQueue.clear();
    for (const id of ids) {
      const task = repos.agentTasks.get(id);
      if (!task || !needsRelay(task)) continue;
      const asking = task.state === 'waiting';
      if (config.tasks.notify && (asking || task.state === 'done' || task.state === 'failed')) {
        await director.speak(await relayLine(task, now), now);
        state.lastTalk = clock();
        wrote = true;
      }
      repos.agentTasks.update(id, asking ? { questionAnnouncedAt: clock() } : { announcedAt: clock() }, clock());
    }
  }

  /**
   * 批准请求有了结论（做完、拒绝、过期）后排进来的通知：叫醒主线程跑一轮转告，和子任务一样受 `tasks.notify` 管。
   * 转告没成（模型出错）就说一句固定的。
   */
  async function relayApprovals(now: Date): Promise<void> {
    const ids = [...approvalQueue].toSorted((a, b) => a - b);
    approvalQueue.clear();
    if (!config.tasks.notify) return;
    for (const id of ids) {
      const approval = repos.approvals.get(id);
      if (!approval) continue;
      await director.speak(await approvalLine(approval, now), now);
      state.lastTalk = clock();
      wrote = true;
    }
  }

  async function approvalLine(approval: Approval, now: Date): Promise<Line> {
    if (!model) return approvalAnnounceLine(approval, now);
    try {
      return await generateRelay(context, orchestrator, {
        notice: approvalRelayPrompt(approval),
        tone: toneForHour(now.getHours()),
        model,
        secrets,
        tools: relayTools(config.llm.tools, deps.toolNames?.()),
        signal: stopping.signal,
        ...(factSources ? { sources: factSources.reply } : {}),
      });
    } catch (error) {
      logger.warn(`批准请求 #${approval.id} 的结果没转告成，先报一声：${errorText(error)}`);
      return approvalAnnounceLine(approval, now);
    }
  }

  async function relayLine(task: AgentTask, now: Date): Promise<Line> {
    const approving = task.state === 'waiting' ? pendingApprovals(repos, task.id) : [];
    if (!model) return announceLine(task, now, approving.length > 0);
    try {
      return await generateRelay(context, orchestrator, {
        notice: relayPrompt(task, repos.artifacts.list({ task: task.id }), config.llm.tools, approving),
        tone: toneForHour(now.getHours()),
        model,
        secrets,
        tools: relayTools(config.llm.tools, deps.toolNames?.()),
        signal: stopping.signal,
        ...(factSources ? { sources: factSources.reply } : {}),
      });
    } catch (error) {
      logger.warn(`子任务 #${task.id} 的结果没转告成，先报一声：${errorText(error)}`);
      return announceLine(task, now, approving.length > 0);
    }
  }

  async function petWhisper(signal?: AbortSignal): Promise<string> {
    if (!model) throw new Error('没配 llm，写不了碎碎念');
    return (await writeWhisper(new Date(clock()), model, signal)).text;
  }

  /**
   * 说完一句以后，下一句隔多久。说成了才问 `pacer`；3 小时内都说过了（`spoken` 是 null）没开口，不问，按 `intervalSec`。
   * `pacer` 不该抛错，万一抛了也退回 `intervalSec`：这里不能出错，不然 `nextWhisper` 不动，下一拍又开口。
   */
  async function paceAfter(spoken: PerformResult | null, spokeAt: number): Promise<PaceDecision> {
    if (!spoken) return { source: 'fixed', ms: intervalMs };
    // 这句有回应就清零；上一句以后主人说过话，前面没人理的不算了，从这句重新数
    state.unanswered = spoken.talked ? 0 : state.lastTalk > lastSpokeAt ? 1 : state.unanswered + 1;
    lastSpokeAt = spokeAt;
    const input: PaceInput = {
      now: spokeAt,
      tone: spoken.line.tone,
      line: { text: spoken.line.text, kind: spoken.line.kind },
      talked: spoken.talked,
      unanswered: state.unanswered,
      sinceTalkMs: state.lastTalk > 0 ? Math.max(0, spokeAt - state.lastTalk) : null,
    };
    try {
      return await pacer.next(input, stopping.signal);
    } catch (error) {
      logger.warn(`碎碎念的间隔没挑成，这句按固定间隔：${redact(errorText(error), secrets)}`);
      return { source: 'fallback', ms: intervalMs, reason: 'error' };
    }
  }

  async function tick(): Promise<void> {
    if (busy || closed) return;
    busy = true;
    try {
      if (config.clipboard.enabled) notePaste(repos, clipboard.read());
      if ((await director.syncPetChat()) > 0) wrote = true;
      for (const message of drain(paths.inboxFile)) {
        if (message.type === 'listen') await listen();
        else await whisper();
        state.lastTalk = clock();
      }
      const now = new Date(clock());
      for (const item of dueItems(repos.schedule.list(), now)) {
        await director.remind(item, now);
        state.lastTalk = clock();
      }
      if (config.tasks.enabled && relayQueue.size > 0) await relayTasks(now);
      if (approvalQueue.size > 0) await relayApprovals(now);
      if (config.memes.enabled && memeDue(clock(), state.nextWhisper, state.memeFailedAt)) {
        try {
          await director.refreshMemes(now);
          state.memeFailedAt = null;
        } catch (error) {
          state.memeFailedAt = clock();
          logger.error(errorText(error));
        }
      }
      const step = whisperStep(state.nextWhisper, state.lastTalk, clock());
      if (step.kind === 'delay') {
        state.nextWhisper = step.until;
        logger.info('碎碎念先让一下，等对话停 30 秒');
        repos.activity.record({ type: 'delay', until: new Date(step.until).toISOString() });
      } else if (step.kind === 'speak') {
        let spoken: PerformResult | null;
        try {
          spoken = await whisper();
        } catch (error) {
          // 一分钟后再试；日志照旧由下面统一记
          state.nextWhisper = clock() + WHISPER_RETRY_MS;
          throw error;
        }
        if (spoken?.talked) state.lastTalk = clock();
        const spokeAt = clock();
        const pace = await paceAfter(spoken, spokeAt);
        state.nextWhisper = nextAfterSpeak(spokeAt, pace.ms, state.lastTalk);
        state.lastPace = pace;
        // 没配决策模型时和以前一样，不多记一条
        if (pace.source !== 'fixed') repos.activity.record(paceActivity(pace));
      }
      if (compactDue(config, clock(), state.lastCompact)) {
        state.lastCompact = clock();
        try {
          await director.compactIfNeeded();
        } catch (error) {
          logger.error(`上下文没压缩成：${errorText(error)}`);
        }
      }
      gateMemory();
      consolidateMemory();
    } catch (error) {
      logger.error(errorText(error));
    } finally {
      busy = false;
    }
  }

  function start(signal?: AbortSignal): void {
    if (started || closed || signal?.aborted) return;
    started = true;
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        stopping.abort(new Error('yoyo 停下了'));
        memoryWork.abort(new Error('yoyo 停下了'));
      },
      { once: true },
    );
    const beat = async (): Promise<void> => {
      if (closed || stopping.signal.aborted) return;
      await tick();
      if (!closed && !stopping.signal.aborted) timer = setTimeout(beat, TICK_MS);
    };
    void beat();
  }

  const orchestrator: YoyoOrchestrator = {
    submit: (request) => runs.submit(request),
    status: (runId) => runs.status(runId),
    cancel: (runId) => runs.cancel(runId),
    recover: async () => (await runs.recover?.()) ?? [],
    events: (options) => runs.events(options),
    async close() {
      closed = true;
      clearTimeout(timer);
      // 门控和整理在后台：取消，等它们收尾（出错已经记过）
      memoryWork.abort(new Error('yoyo 关闭了'));
      await Promise.all([gating, consolidating]);
      await runs.close();
    },
    whisper,
    listen,
    chat,
    talk,
    relayTask(id) {
      relayQueue.add(id);
    },
    relayApproval(id) {
      approvalQueue.add(id);
    },
    petWhisper,
    tick,
    start,
    state,
  };
  return orchestrator;
}
