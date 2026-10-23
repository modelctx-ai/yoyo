import type { Context, LanguageModel } from '@modelctx-ai/ctx';

import { COMPACT_INSTRUCTIONS } from '../brain/prompts.ts';

/** 压缩一次最多等这么久（含重试），超时就这次不压，常驻循环接着走。 */
export const COMPACT_TIMEOUT_MS = 60_000;

/** 整段历史（不按 maxTokens 裁剪）的估算 token。 */
export async function historyTokens(context: Context): Promise<number> {
  return (await context.view({ window: {} })).tokens;
}

export interface Compacted {
  readonly before: number;
  readonly after: number;
}

export interface CompactContextOptions {
  readonly keep: number;
  readonly model: LanguageModel;
  /** 已经量过的 token，省一次读库。 */
  readonly before?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** 把较早的历史压成一条摘要，最近 `keep` 条原样保留。历史不够长时返回 null。 */
export async function compactContext(context: Context, options: CompactContextOptions): Promise<Compacted | null> {
  const before = options.before ?? (await historyTokens(context));
  const summary = await context.compact({
    keep: options.keep,
    instructions: COMPACT_INSTRUCTIONS,
    model: options.model,
    timeoutMs: options.timeoutMs ?? COMPACT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!summary) return null;
  return { before, after: await historyTokens(context) };
}
