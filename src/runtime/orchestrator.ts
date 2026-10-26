import {
  createOrchestrator,
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
import { generateReply, generateWhisper } from '../brain/compose.ts';
import { recordUser } from '../brain/context.ts';
import { dueItems } from '../features/alarms/schedule.ts';
import { notePaste } from '../features/clipboard/clipboard.ts';
import { wantsReply } from '../features/listen/listen.ts';
import { shouldSearch } from '../features/search/question.ts';
import { nextWhisperAt } from '../kernel/pace.ts';
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
  /** 一拍：粘贴板、桌宠对话、收件箱、到点提醒、空闲找图、碎碎念让路、上下文压缩。上一拍没走完就跳过。 */
  tick(): Promise<void>;
  /** 每秒一拍，直到 `signal` 中止或 `close`。中止时正在跑的模型也一起取消。 */
  start(signal?: AbortSignal): void;
  readonly state: ScheduleState;
}

export function createYoyoOrchestrator(deps: YoyoOrchestratorDeps): YoyoOrchestrator {
  const { config, paths, logger, repos, clipboard, search, context, harness, director, model } = deps;
  const clock = deps.clock ?? Date.now;
  const runs = createOrchestrator({ harness, store: context.store, logger });
  const secrets = [config.llm.apiKey].filter(Boolean);
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
  /** 每一轮一个派生的 signal：ctx 的队列会在 `request.signal` 上挂监听，不能都挂在这个常驻的上面。 */
  const runSignal = (): AbortSignal => AbortSignal.any([stopping.signal]);
  let busy = false;
  let started = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  /** 预制台词都说过了：有模型就按最近的对话和任务写一句。 */
  async function written(now: Date): Promise<Line | null> {
    if (!model) return null;
    logger.info('预制台词用完了，按最近的对话和任务写一句');
    const tone = toneForHour(now.getHours());
    return generateWhisper(context, orchestrator, { tone, model, secrets, signal: runSignal() });
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
    const line = await generateReply(context, orchestrator, {
      tone,
      model: llm,
      secrets,
      tools: config.llm.tools,
      signal: runSignal(),
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
      await director.syncPetChat();
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
