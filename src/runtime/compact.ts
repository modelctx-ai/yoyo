import type { Context, LanguageModel } from '@modelctx-ai/ctx';

import { COMPACT_INSTRUCTIONS } from '../brain/prompts.ts';

/** 整段历史（不按 maxTokens 裁剪）的估算 token。 */
export async function historyTokens(context: Context): Promise<number> {
  return (await context.view({ window: {} })).tokens;
}

export interface Compacted {
  readonly before: number;
  readonly after: number;
}

/** 把较早的历史压成一条摘要，最近 `keep` 条原样保留。历史不够长时返回 null。 */
export async function compactContext(
  context: Context,
  options: { readonly keep: number; readonly model: LanguageModel; readonly before?: number },
): Promise<Compacted | null> {
  const before = options.before ?? (await historyTokens(context));
  const summary = await context.compact({
    keep: options.keep,
    instructions: COMPACT_INSTRUCTIONS,
    model: options.model,
  });
  if (!summary) return null;
  return { before, after: await historyTokens(context) };
}
