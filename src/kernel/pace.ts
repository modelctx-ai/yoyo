/** 日常碎碎念如果 30 秒内还有别的对话，就顺延到对话结束后 30 秒。对话再出现就继续顺延。 */
export const TALK_GAP_MS = 30_000;

export function nextWhisperAt(scheduledAt: number, lastTalkAt: number, now: number, gapMs = TALK_GAP_MS): number {
  const quietAt = (lastTalkAt || 0) + gapMs;
  if (now < quietAt) return Math.max(scheduledAt, quietAt);
  return scheduledAt;
}
