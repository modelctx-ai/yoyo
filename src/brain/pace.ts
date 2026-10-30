/**
 * 碎碎念的间隔：说完一句以后隔多久说下一句。没配决策模型就固定按 `intervalSec`；配了就把这一刻的情况交给
 * 决策模型（System One，例如 TypeSafe 的 Jev），问一道从短到长的量表题，挑一档。没判成这一次按 `intervalSec`。
 */
import {
  redact,
  textOf,
  type DecisionModel,
  type DecisionQuestion,
  type Entry,
  type JsonValue,
  type SessionStore,
} from '@modelctx-ai/ctx';
import { createDecisionModel } from '@modelctx-ai/ctx-models';

import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import {
  paceLabel,
  pickPace,
  whisperIntervalMs,
  type PaceDecision,
  type PaceFallback,
  type PaceInput,
  type PaceOptions,
} from '../kernel/pace.ts';
import type { WorkStatus } from '../kernel/types.ts';
import type { Logger, WhisperPacer } from '../ports/index.ts';
import { systemOneSpec } from './model.ts';

/** 决策模型最多等这么久；拍子在等它，不能一直卡着。 */
export const PACE_TIMEOUT_MS = 10_000;
/** 问题名，也是回答的键。 */
export const PACE_QUESTION = 'next_whisper';

/** 没配决策模型：总是 `intervalSec`。 */
export function fixedPacer(ms: number): WhisperPacer {
  return { name: 'fixed', next: async () => ({ source: 'fixed', ms }) };
}

/** 交给决策模型的最近一句：主人说的、yoyo 说的（碎碎念也算 yoyo 说的）。 */
export interface RecentLine {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

function recentLine(entry: Entry): RecentLine | null {
  if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) {
    const text = textOf(entry.message).trim();
    return text ? { role: entry.message.role, text } : null;
  }
  if (entry.type === 'event' && entry.kind === 'whisper' && entry.text) return { role: 'assistant', text: entry.text };
  return null;
}

/** 会话里最后 `limit` 句话，按先后。工具调用、摘要、别的事件不算。 */
export async function recentLines(store: SessionStore, session: string, limit: number): Promise<RecentLine[]> {
  if (limit <= 0) return [];
  const entries = await store.list(session, { last: limit * 4 });
  return entries
    .map(recentLine)
    .filter((line): line is RecentLine => line !== null)
    .slice(-limit);
}

/** 从短到长的量表：最短一档偏「想有人陪」，最长一档偏「别打扰」。 */
export function paceQuestion(options: PaceOptions): DecisionQuestion {
  const last = options.length - 1;
  return {
    type: 'score',
    instructions:
      '桌宠刚对主人说完一句碎碎念。看这一刻的时间、主人在做什么、有没有回应、最近聊了什么，判断隔多久再说下一句合适：' +
      '主人刚回过话、在闲聊、看起来无聊，就隔短一点；主人在专心做事、连着几句没理、夜深了，就隔长一点。',
    criteria: options.map((option, index) => {
      const label = `${paceLabel(option)}后再说一句`;
      if (index === 0) return `${label}：主人想有人陪着说话`;
      if (index === last) return `${label}：主人在忙或者不想被打扰`;
      return label;
    }),
  };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(at: number): string {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 交给决策模型的情况。只放判断间隔要用的，没有密钥。 */
export function paceState(
  input: PaceInput,
  around: { readonly work: WorkStatus | null; readonly recent: readonly RecentLine[] },
): JsonValue {
  return {
    now: clock(input.now),
    tone: input.tone,
    said: { text: input.line.text, kind: input.line.kind },
    replied: input.talked,
    unanswered: input.unanswered,
    minutesSinceTalk: input.sinceTalkMs === null ? null : Math.round(input.sinceTalkMs / 60_000),
    work: around.work ? { state: around.work.state, task: around.work.task } : null,
    recent: around.recent.map((line) => ({ role: line.role, text: line.text })),
  };
}

export interface DecisionPacerOptions {
  readonly model: DecisionModel;
  readonly options: PaceOptions;
  /** 没判成时的间隔：`intervalSec`。 */
  readonly fallbackMs: number;
  /** 挑中那档的概率低于它就算没判成。 */
  readonly minConfidence: number;
  readonly logger: Logger;
  /** 主人在做什么（桌宠的工作状态）。取不到当没有。 */
  readonly work?: () => Promise<WorkStatus | null>;
  /** 最近几句对话。不给就不交原文。 */
  readonly recent?: () => Promise<readonly RecentLine[]>;
  /** 报错里抹掉的密钥。 */
  readonly secrets?: readonly string[];
  readonly timeoutMs?: number;
}

/** 问决策模型挑一档。出错、超时、把握不够都退回 `fallbackMs`；同一个问题只记一次。 */
export function decisionPacer(options: DecisionPacerOptions): WhisperPacer {
  const { model, logger, fallbackMs, minConfidence } = options;
  const question = paceQuestion(options.options);
  let problem = '';

  function fallback(reason: PaceFallback): PaceDecision {
    return { source: 'fallback', ms: fallbackMs, reason };
  }

  return {
    name: model.name,
    async next(input, signal) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? PACE_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const [work, recent] = await Promise.all([
          options.work?.().catch(() => null) ?? null,
          options.recent?.() ?? [],
        ]);
        combined.throwIfAborted();
        const answers = await model.decide({
          state: paceState(input, { work, recent }),
          questions: { [PACE_QUESTION]: question },
          signal: combined,
        });
        const answer = answers[PACE_QUESTION];
        if (answer?.type !== 'score') throw new Error(`回的不是量表：${answer?.type ?? '没有回答'}`);
        if (answer.probabilities.length !== options.options.length) {
          throw new Error(`回了 ${answer.probabilities.length} 档，问的是 ${options.options.length} 档`);
        }
        problem = '';
        const picked = pickPace(options.options, answer.probabilities, minConfidence);
        if (!picked) return fallback('unsure');
        return { source: 'decided', ms: picked.option.ms, option: picked.option.id, confidence: picked.confidence };
      } catch (error) {
        // 停下了就不记：不是模型的问题
        if (signal?.aborted) return fallback('error');
        const timedOut = timeout.aborted;
        const text = timedOut
          ? `${Math.round((options.timeoutMs ?? PACE_TIMEOUT_MS) / 1000)} 秒没回`
          : redact(errorText(error), options.secrets ?? [])
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 180);
        if (text !== problem) logger.warn(`下一句碎碎念的间隔没判成，先按 intervalSec：${text}`);
        problem = text;
        return fallback(timedOut ? 'timeout' : 'error');
      }
    },
  };
}

export interface WhisperPacerDeps {
  readonly logger: Logger;
  readonly work?: () => Promise<WorkStatus | null>;
  /** 最后几句对话。`pace.recent` 是 0 时不调。 */
  readonly recent?: (limit: number) => Promise<readonly RecentLine[]>;
  /** 报错里另外要抹掉的密钥（例如 `llm.apiKey`）。 */
  readonly secrets?: readonly string[];
}

/**
 * 按配置挑：`pace.decision` 配了就问决策模型，没配按 `intervalSec`。写得不对（没有 provider、model，cloudflare 没有
 * accountId，认不得的服务商）记一行，也按 `intervalSec`。
 */
export function createWhisperPacer(config: Pick<Config, 'intervalSec' | 'pace'>, deps: WhisperPacerDeps): WhisperPacer {
  const fallbackMs = whisperIntervalMs(config.intervalSec);
  const { decision: section, recent: limit } = config.pace;
  if (!section) return fixedPacer(fallbackMs);
  const secrets = [section.apiKey, ...(deps.secrets ?? [])].filter(Boolean);
  let model: DecisionModel;
  try {
    model = createDecisionModel(systemOneSpec(section));
  } catch (error) {
    deps.logger.warn(`config.json 的 pace.decision 不对：${redact(errorText(error), secrets)}，碎碎念按 intervalSec`);
    return fixedPacer(fallbackMs);
  }
  const { recent } = deps;
  return decisionPacer({
    model,
    options: config.pace.options,
    fallbackMs,
    minConfidence: config.pace.minConfidence,
    logger: deps.logger,
    secrets,
    ...(deps.work ? { work: deps.work } : {}),
    ...(recent && limit > 0 ? { recent: () => recent(limit) } : {}),
  });
}

/** 报错里要抹掉的决策模型密钥。 */
export function paceSecrets(config: Pick<Config, 'pace'>): string[] {
  return [config.pace.decision?.apiKey].filter((key): key is string => Boolean(key));
}
