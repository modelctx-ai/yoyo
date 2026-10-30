import type { Line, Tone } from './types.ts';

/** 日常碎碎念如果 30 秒内还有别的对话，就顺延到对话结束后 30 秒。对话再出现就继续顺延。 */
export const TALK_GAP_MS = 30_000;

export function nextWhisperAt(scheduledAt: number, lastTalkAt: number, now: number, gapMs = TALK_GAP_MS): number {
  const quietAt = (lastTalkAt || 0) + gapMs;
  if (now < quietAt) return Math.max(scheduledAt, quietAt);
  return scheduledAt;
}

// ---- 下一句隔多久 ----

/** 两句日常碎碎念的间隔（`intervalSec`）：至少一分钟，缺省 5 分钟。没配决策模型、或者没判成时用它。 */
export function whisperIntervalMs(intervalSec: number): number {
  return Math.max(60, intervalSec || 300) * 1000;
}

/** 一档间隔。`id` 是给决策模型和行为记录看的稳定名字，例如 `15m`。 */
export interface PaceOption {
  readonly id: string;
  readonly ms: number;
}

/** 从短到长排好、至少两档：决策模型的有序量表要两档以上，类型上就保证。 */
export type PaceOptions = readonly [PaceOption, PaceOption, ...PaceOption[]];

/** 最短的一档：和 `intervalSec` 的下限一样，一分钟。 */
export const MIN_PACE_SEC = 60;

/** 缺省四档：5 分钟、15 分钟、30 分钟、1 小时。 */
export const DEFAULT_PACE_SEC: readonly number[] = [300, 900, 1800, 3600];

/** 秒数写成档名：整小时 `1h`，整分钟 `15m`，别的 `90s`。 */
export function paceId(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** 给人和模型看的：`1 小时`、`15 分钟`、`90 秒`。 */
export function paceLabel(option: PaceOption): string {
  const sec = option.ms / 1000;
  if (sec % 3600 === 0) return `${sec / 3600} 小时`;
  if (sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${sec} 秒`;
}

/** 配置里的秒数整理成档位：不是有限数、少于一分钟的丢掉，取整、去重、从短到长；不到两档用缺省四档。 */
export function paceOptions(seconds: readonly number[]): PaceOptions {
  const clean = [
    ...new Set(seconds.filter((sec) => Number.isFinite(sec) && sec >= MIN_PACE_SEC).map((sec) => Math.round(sec))),
  ].toSorted((a, b) => a - b);
  const [first, second, ...rest] = (clean.length >= 2 ? clean : DEFAULT_PACE_SEC).map((sec): PaceOption => ({
    id: paceId(sec),
    ms: sec * 1000,
  }));
  // 上面保证至少两档
  return [first!, second!, ...rest];
}

/** 这一次的间隔从哪来。 */
export type PaceDecision =
  /** 没配决策模型：`intervalSec`。 */
  | { readonly source: 'fixed'; readonly ms: number }
  /** 决策模型挑的档。 */
  | {
      readonly source: 'decided';
      readonly ms: number;
      readonly option: string;
      /** 挑中那档的概率，0..1。 */
      readonly confidence: number;
    }
  /** 配了决策模型，但这次没判成，退回 `intervalSec`。 */
  | { readonly source: 'fallback'; readonly ms: number; readonly reason: PaceFallback };

/** 没判成的原因：出错、超时、把握不够。 */
export type PaceFallback = 'error' | 'timeout' | 'unsure';

/**
 * 按各档的概率挑：概率最大的那档（一样大取短的）；它的概率低于 `minConfidence`，或者概率的档数和档位对不上，返回 null。
 */
export function pickPace(
  options: PaceOptions,
  probabilities: readonly number[],
  minConfidence: number,
): { readonly option: PaceOption; readonly confidence: number } | null {
  if (probabilities.length !== options.length) return null;
  let best = 0;
  for (let index = 1; index < probabilities.length; index++) {
    if ((probabilities[index] ?? 0) > (probabilities[best] ?? 0)) best = index;
  }
  const confidence = probabilities[best] ?? 0;
  const option = options[best];
  if (!option || !Number.isFinite(confidence) || confidence < minConfidence) return null;
  return { option, confidence };
}

/** 说完一句以后交给定间隔的：排期这边知道的事。主人在做什么、最近聊了什么，由定间隔的自己去取。 */
export interface PaceInput {
  readonly now: number;
  readonly tone: Tone;
  /** 刚说的这句。 */
  readonly line: Pick<Line, 'text' | 'kind'>;
  /** 这句念完主人有没有回应。 */
  readonly talked: boolean;
  /** 连着几句碎碎念没人回应（这句算在内）；中间有过对话就从头数。 */
  readonly unanswered: number;
  /** 离最近一次对话多久（毫秒）；从没说过话是 null。 */
  readonly sinceTalkMs: number | null;
}
