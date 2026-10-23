import type { Line } from './types.ts';

/** 短句保持 10 秒。长句按字数把气泡留久一点，上限 40 秒。 */
export function bubbleMs(text: string): number {
  if (text.length <= 20) return 10_000;
  return Math.min(40_000, 8_000 + text.length * 180);
}

/** 行为记录的类型：weather→'weather'，generated/reply→'reply'，reminder→'reminder'，whisper→语气名。与旧代码一致。 */
export function activityLabel(line: Line): string {
  if (line.kind === 'weather') return 'weather';
  if (line.kind === 'generated' || line.kind === 'reply') return 'reply';
  if (line.kind === 'reminder') return 'reminder';
  return line.tone;
}

export type ContextRole = 'assistant' | 'whisper';

/** reply/reminder/weather 记成助手消息，whisper/generated 记成碎碎念事件。与旧代码一致。 */
export function contextRoleOf(line: Line): ContextRole {
  return line.kind === 'reply' || line.kind === 'reminder' || line.kind === 'weather' ? 'assistant' : 'whisper';
}
