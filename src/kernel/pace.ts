import type { Line, Tone } from './types.ts';

/** 日常碎碎念如果 30 秒内还有别的对话，就顺延到对话结束后 30 秒。对话再出现就继续顺延。 */
export const TALK_GAP_MS = 30_000;

export function nextWhisperAt(scheduledAt: number, lastTalkAt: number, now: number, gapMs = TALK_GAP_MS): number {
  const quietAt = (lastTalkAt || 0) + gapMs;
  if (now < quietAt) return Math.max(scheduledAt, quietAt);
  return scheduledAt;
}

/** 两句碎碎念最少隔这么久，和 `intervalSec` 的下限一致。 */
export const PACE_MIN_MS = 60_000;

/** 缺省四档，秒：5 分钟、15 分钟、30 分钟、1 小时。 */
export const DEFAULT_PACE_SECONDS: readonly number[] = [300, 900, 1800, 3600];

/** 一档间隔。`id` 是给决策模型和行为记录看的稳定名字，例如 `15m`。 */
export interface PaceOption {
  readonly id: string;
  readonly ms: number;
}

/** 从短到长排好、至少两档：`score` 问题要两档以上，类型上就保证。 */
export type PaceOptions = readonly [PaceOption, PaceOption, ...PaceOption[]];

/** 这一次的间隔从哪来。按 `source` 区分，switch 穷尽。 */
export type PaceDecision =
  /** 没配决策模型：`intervalSec`。 */
  | { readonly source: 'fixed'; readonly ms: number }
  /** 决策模型挑的档。 */
  | {
      readonly source: 'decided';
      readonly ms: number;
      readonly option: PaceOption['id'];
      /** 挑中那档的概率，0..1。 */
      readonly confidence: number;
    }
  /** 配了但这次没判成，退回 `intervalSec`。 */
  | {
      readonly source: 'fallback';
      readonly ms: number;
      readonly reason: 'error' | 'timeout' | 'unsure';
    };

/** 交给决策模型的上下文，只放判断间隔要用的，不放密钥。工作状态和最近的对话由决策那一层自己去取。 */
export interface PaceInput {
  readonly now: number;
  readonly tone: Tone;
  /** 刚说的这句。 */
  readonly line: Pick<Line, 'text' | 'kind'>;
  /** 这句念完主人有没有回应。 */
  readonly talked: boolean;
  /** 连着几句碎碎念没人回应（这句算在内；主人回应了或有过对话就清零）。 */
  readonly unanswered: number;
  /** 离最近一次对话多久，毫秒；没说过是 null。 */
  readonly sinceTalkMs: number | null;
}

/** 毫秒写成短名字：`5m`、`1h`、`1h30m`、`90s`。 */
export function paceId(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${seconds ? `${seconds}s` : ''}` || '0s';
}

/** 毫秒写成中文：`5 分钟`、`1 小时`、`1 小时 30 分钟`。 */
export function paceLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return (
    [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', seconds ? `${seconds} 秒` : '']
      .filter(Boolean)
      .join(' ') || '0 秒'
  );
}

/** 从短到长的毫秒数建档位；不到两档是 null。 */
function optionsOf(ms: readonly number[]): PaceOptions | null {
  if (ms.length < 2) return null;
  return ms.map((value) => ({ id: paceId(value), ms: value })) as unknown as PaceOptions;
}

const DEFAULT_OPTIONS = optionsOf(DEFAULT_PACE_SECONDS.map((sec) => sec * 1000))!;

/**
 * 配置里的档位（秒）换成 `PaceOptions`：数字或数字字符串，丢掉不是有限数的、少于 60 的，取整、去重、从短到长；
 * 剩下不到两档就用缺省四档。
 */
export function paceOptionsFrom(raw: unknown): PaceOptions {
  if (!Array.isArray(raw)) return DEFAULT_OPTIONS;
  const seconds = raw
    .map((item: unknown) => (typeof item === 'string' && item.trim() ? Number(item) : item))
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= PACE_MIN_MS / 1000)
    .map((item) => Math.round(item));
  const ms = [...new Set(seconds)].toSorted((a, b) => a - b).map((sec) => sec * 1000);
  return optionsOf(ms) ?? DEFAULT_OPTIONS;
}

/** 间隔夹到 `[一分钟, max]`；不给 `max` 只管下限。 */
export function clampPaceMs(ms: number, max?: number): number {
  const floored = Math.max(PACE_MIN_MS, ms);
  return max === undefined ? floored : Math.min(floored, Math.max(PACE_MIN_MS, max));
}

/**
 * 决策模型给出各档的概率（和档位一一对应）：取概率最大的一档，并列取短的。
 * 概率不是有限数、个数对不上返回 `'invalid'`；最大的那档低于 `minConfidence` 返回 `'unsure'`。
 */
export function pickPace(
  options: PaceOptions,
  probabilities: readonly number[],
  minConfidence: number,
): { readonly option: PaceOption; readonly confidence: number } | 'invalid' | 'unsure' {
  if (probabilities.length !== options.length || !probabilities.every(Number.isFinite)) return 'invalid';
  let best = 0;
  for (const [index, probability] of probabilities.entries()) {
    if (probability > (probabilities[best] ?? 0)) best = index;
  }
  const option = options[best]!;
  const confidence = Math.min(1, Math.max(0, probabilities[best] ?? 0));
  return confidence < minConfidence ? 'unsure' : { option, confidence };
}

/** 工作台上一句短的原因：这次间隔是怎么来的。 */
export function paceNote(pace: PaceDecision, options: PaceOptions): string {
  if (pace.source === 'fixed') return '按固定间隔';
  if (pace.source === 'fallback') {
    const why = pace.reason === 'timeout' ? '超时' : pace.reason === 'unsure' ? '没把握' : '没判成';
    return `决策模型${why}，按固定间隔`;
  }
  const index = options.findIndex((option) => option.id === pace.option);
  const mood = index === 0 ? '主人有空，' : index === options.length - 1 ? '主人在忙，' : '';
  return `${mood}隔 ${paceLabel(pace.ms)}`;
}
