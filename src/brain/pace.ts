import {
  redact,
  textOf,
  type Context,
  type DecisionModel,
  type DecisionQuestion,
  type JsonValue,
} from '@modelctx-ai/ctx';
import { createDecisionModel } from '@modelctx-ai/ctx-models';

import type { PaceConfig } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import {
  clampPaceMs,
  paceLabel,
  pickPace,
  type PaceDecision,
  type PaceInput,
  type PaceOptions,
} from '../kernel/pace.ts';
import type { WorkStatus } from '../kernel/types.ts';
import type { Logger, WhisperPacer } from '../ports/index.ts';
import { createSystemOne } from './system-one.ts';

/** 发给决策模型的问题名。 */
export const PACE_QUESTION = 'interval';
/** 一次决策最多等这么久：拍子最多被卡这么久，超时就按固定间隔。 */
export const PACE_TIMEOUT_MS = 5_000;
/** 发给决策模型的每条最近对话最多留这么多字。 */
const RECENT_CHARS = 200;

const FREE = '主人有空、刚回过话、聊得热';
const BUSY = '主人在专心忙、连着几句没理 yoyo、夜深了';

/** 永远是同一个间隔，就是没配决策模型时的行为。 */
export function fixedPacer(ms: number): WhisperPacer {
  return { name: 'fixed', next: async () => ({ source: 'fixed', ms }) };
}

/** 档位从短到长，最短一档对应「主人有空」，最长一档对应「主人在忙」，中间的是两者之间。 */
export function paceQuestion(options: PaceOptions): DecisionQuestion {
  const last = options.length - 1;
  return {
    type: 'score',
    instructions:
      '桌宠刚说完一句碎碎念，下一句隔多久再说合适？主人有空、肯理它就勤一点，在专心做事、一直没理它、夜深了就隔久一点。',
    criteria: options.map(
      (option, index) =>
        `${paceLabel(option.ms)}后再说一句：${index === 0 ? FREE : index === last ? BUSY : '介于两者之间'}`,
    ),
  };
}

export interface DecisionPacerOptions {
  readonly model: DecisionModel;
  readonly options: PaceOptions;
  /** 没判成时的间隔，毫秒。 */
  readonly fallbackMs: number;
  /** 最大的那档概率低于它就算没把握。 */
  readonly minConfidence: number;
  readonly timeoutMs?: number;
  /** 发给决策模型的最近对话原文条数，0 不发原文。 */
  readonly recent: number;
  /** 读最近的对话；`recent` 是 0 时不用。 */
  readonly context?: Pick<Context, 'entries'>;
  /** 桌宠现在的工作状态；读不到当没有。 */
  readonly work?: () => Promise<WorkStatus | null>;
  /** 报错里要抹掉的密钥。 */
  readonly secrets?: readonly string[];
  readonly logger?: Logger;
}

/** 等 `work`，`signal` 中止就不等了（`work` 自己的结果丢掉）。 */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 最近几条对话原文：只要主人和 yoyo 说的话，每条截短。 */
async function recentTurns(
  context: Pick<Context, 'entries'> | undefined,
  count: number,
): Promise<{ role: string; text: string }[]> {
  if (!context || count <= 0) return [];
  const entries = await context.entries({ types: ['message'], last: count });
  const turns: { role: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) continue;
    const text = textOf(entry.message).trim();
    if (text) turns.push({ role: entry.message.role, text: text.slice(0, RECENT_CHARS) });
  }
  return turns;
}

/** 交给决策模型的 `state`：判断间隔要用的信号，加上（`recent` 不是 0 时）最近几条对话原文。 */
async function paceState(input: PaceInput, deps: DecisionPacerOptions): Promise<JsonValue> {
  const at = new Date(input.now);
  const work = deps.work ? await deps.work().catch(() => null) : null;
  const turns = await recentTurns(deps.context, deps.recent).catch(() => []);
  return {
    time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
    weekday: `周${WEEKDAYS[at.getDay()]}`,
    tone: input.tone,
    line: { text: input.line.text, kind: input.line.kind },
    talked: input.talked,
    unanswered: input.unanswered,
    minutesSinceTalk: input.sinceTalkMs === null ? null : Math.round(input.sinceTalkMs / 60_000),
    work: work ? { state: work.state, task: work.task } : null,
    ...(deps.recent > 0 ? { recent: turns } : {}),
  };
}

/**
 * 问决策模型一个 `score` 问题（档位有序），取概率最大的一档。出错、超时、回的不是 `score`、没把握都退回 `fallbackMs`，
 * 记一行（抹掉密钥），不抛错。
 */
export function decisionPacer(deps: DecisionPacerOptions): WhisperPacer {
  const { model, options, minConfidence } = deps;
  const fallbackMs = clampPaceMs(deps.fallbackMs);
  const longest = options.at(-1)!.ms;
  const secrets = deps.secrets ?? [];
  const question = paceQuestion(options);

  function fallback(reason: 'error' | 'timeout' | 'unsure', detail?: string): PaceDecision {
    const what = reason === 'timeout' ? '超时了' : reason === 'unsure' ? '没把握' : `出错了：${detail ?? ''}`;
    deps.logger?.warn(`碎碎念的间隔没挑成（${what}），这句按固定间隔`);
    return { source: 'fallback', ms: fallbackMs, reason };
  }

  return {
    name: model.name,
    async next(input, signal) {
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? PACE_TIMEOUT_MS);
      const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const answers = await until(
          paceState(input, deps).then((state) =>
            model.decide({ state, questions: { [PACE_QUESTION]: question }, signal: stop }),
          ),
          stop,
        );
        const answer = answers[PACE_QUESTION];
        if (answer?.type !== 'score') throw new Error('决策模型回的不是 score');
        const picked = pickPace(options, answer.probabilities, minConfidence);
        if (picked === 'invalid') throw new Error('决策模型回的概率和档位对不上');
        if (picked === 'unsure') return fallback('unsure');
        return {
          source: 'decided',
          ms: clampPaceMs(picked.option.ms, longest),
          option: picked.option.id,
          confidence: picked.confidence,
        };
      } catch (error) {
        if (timeout.aborted) return fallback('timeout');
        const text = redact(errorText(error), secrets).replace(/\s+/g, ' ').trim().slice(0, 180);
        return fallback('error', text);
      }
    },
  };
}

/** 报错里要抹掉的间隔模型密钥。 */
export function paceSecrets(config: PaceConfig): string[] {
  return config.decision?.apiKey ? [config.decision.apiKey] : [];
}

export interface WhisperPacerDeps {
  readonly config: PaceConfig;
  /** 没配和没判成时的间隔，毫秒（`intervalSec`）。 */
  readonly fallbackMs: number;
  readonly logger: Logger;
  readonly context: Pick<Context, 'entries'>;
  readonly work?: () => Promise<WorkStatus | null>;
  /** 报错里要抹掉的密钥，缺省只有 `pace.decision` 自己的。 */
  readonly secrets?: readonly string[];
}

/**
 * 按 `pace` 挑一个：没配 `pace.decision`、或配得不对（记一行）就是 `fixedPacer`，配了就是 `decisionPacer`。
 * 不借 `memory.decision`。
 */
export function createWhisperPacer(deps: WhisperPacerDeps): WhisperPacer {
  const { config } = deps;
  const secrets = deps.secrets ?? paceSecrets(config);
  const model = createSystemOne(
    config.decision,
    'pace.decision',
    '碎碎念按固定间隔',
    createDecisionModel,
    deps.logger,
    secrets,
  );
  if (!model) return fixedPacer(deps.fallbackMs);
  return decisionPacer({
    model,
    options: config.options,
    fallbackMs: deps.fallbackMs,
    minConfidence: config.minConfidence,
    recent: config.recent,
    context: deps.context,
    ...(deps.work ? { work: deps.work } : {}),
    secrets,
    logger: deps.logger,
  });
}
