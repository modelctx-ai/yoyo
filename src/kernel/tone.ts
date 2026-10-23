import type { Tone } from './types.ts';

export const TONES: readonly Tone[] = ['lively', 'warm', 'calm', 'brisk'];

/** 每档语气的 Fish Audio S2 句首情绪标签。 */
export const TONE_CUES: Readonly<Record<Tone, string>> = {
  lively: '[happy]',
  warm: '[relaxed]',
  calm: '[calm]',
  brisk: '[confident]',
};

/** 模型现写的句子没有自带动作，按语气配一个。 */
export const TONE_ACTION: Readonly<Record<Tone, string>> = {
  lively: '碎碎念-对屏碎碎念',
  warm: '碎碎念-对屏碎碎念',
  calm: '碎碎念-发呆碎碎念',
  brisk: '写代码',
};

/** 凌晨、清晨、深夜平静；早上、傍晚、晚上温和；上午、中午明快；下午活泼。 */
export function toneForHour(hour: number): Tone {
  if (hour >= 7 && hour < 9) return 'warm';
  if (hour >= 9 && hour < 13) return 'brisk';
  if (hour >= 13 && hour < 17) return 'lively';
  if (hour >= 17 && hour < 23) return 'warm';
  return 'calm';
}
