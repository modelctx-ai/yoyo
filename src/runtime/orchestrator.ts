import {
  createOrchestrator,
  redact,
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
import { generateReply, generateWhisper } from '../brain/compose.ts';
import { recordUser } from '../brain/context.ts';
import { memorySecrets, type YoyoMemory } from '../brain/memory.ts';
import { dueItems } from '../features/alarms/schedule.ts';
import { notePaste } from '../features/clipboard/clipboard.ts';
import { wantsReply } from '../features/listen/listen.ts';
import { shouldSearch } from '../features/search/question.ts';
import { nextWhisperAt } from '../kernel/pace.ts';
import { localDateKey, minutesOf } from '../kernel/time.ts';
import { toneForHour } from '../kernel/tone.ts';
import type { Line, Tone } from '../kernel/types.ts';
import type { Clipboard, Logger, Repos, WebSearch } from '../ports/index.ts';
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

export interface ScheduleState {
  /** 下一句日常碎碎念的时间（毫秒）。 */
  nextWhisper: number;
  /** 最近一次对话、听写或提醒结束的时间。 */
  lastTalk: number;
  /** 最近一次看要不要压缩上下文的时间。 */
  lastCompact: number | null;
  /** 最近一次找表情包失败的时间。 */
  memeFailedAt: number | null;
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
   * 一拍：粘贴板、桌宠对话、收件箱、到点提醒、空闲找图、碎碎念让路、上下文压缩，打开记忆时再加门控和夜里的整理。
   * 上一拍没走完就跳过。门控和整理在后台跑，不等。
   */
  tick(): Promise<void>;
  /** 每秒一拍，直到 `signal` 中止或 `close`。中止时正在跑的模型也一起取消。 */
  start(signal?: AbortSignal): void;
  readonly state: ScheduleState;
}

export function createYoyoOrchestrator(deps: YoyoOrchestratorDeps): YoyoOrchestrator {
  const { config, paths, logger, repos, clipboard, search, context, harness, director, model, factSources } = deps;
  const memory = deps.memory ?? null;
  const clock = deps.clock ?? Date.now;
  const runs = createOrchestrator({ harness, store: context.store, logger });
  // 报错里抹掉的密钥：模型的，加上记忆的决策、提取模型的
  const secrets = [config.llm.apiKey, ...memorySecrets(config.memory)].filter(Boolean);
  const intervalMs = whisperIntervalMs(config.intervalSec);
  const state: ScheduleState = {
    nextWhisper: clock(),
    lastTalk: 0,
    lastCompact: null,
    memeFailedAt: null,
    ...deps.state,
  };
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

  /** 预制台词都说过了：有模型就按最近的对话和任务写一句。 */
  async function written(now: Date): Promise<Line | null> {
    if (!model) return null;
    logger.info('预制台词用完了，按最近的对话和任务写一句');
    const tone = toneForHour(now.getHours());
    return generateWhisper(context, orchestrator, {
      tone,
      model,
      secrets,
      signal: stopping.signal,
      ...(factSources ? { sources: factSources.whisper } : {}),
    });
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
      if (memeDue(clock(), state.nextWhisper, state.memeFailedAt)) {
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
        state.nextWhisper = nextAfterSpeak(clock(), intervalMs, state.lastTalk);
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
    tick,
    start,
    state,
  };
  return orchestrator;
}
