import type { ListenConfig } from '../../app/config.ts';
import type { Line } from '../../kernel/types.ts';

/** 碎碎念和模型现写的话可以听回应。天气播报和提醒不听。 */
export function wantsReply(line: Line | null | undefined, listen: Pick<ListenConfig, 'enabled'>): boolean {
  if (!listen.enabled) return false;
  if (!line || line.kind === 'weather' || line.kind === 'reminder') return false;
  return true;
}

/** 听几秒：取整，限在 1 到 10 秒；读不懂就 5 秒。 */
export function listenSeconds(listen: Pick<ListenConfig, 'seconds'>): number {
  const seconds = Number(listen.seconds);
  if (!Number.isFinite(seconds)) return 5;
  return Math.min(10, Math.max(1, Math.round(seconds)));
}
