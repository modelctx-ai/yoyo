import { findLossySummaries, recompactLossy, type Context, type LanguageModel } from '@modelctx-ai/ctx';

import { errorText } from '../app/log.ts';
import { COMPACT_INSTRUCTIONS } from '../brain/prompts.ts';
import type { Logger } from '../ports/index.ts';

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

export interface RecompactOptions {
  /** 没有模型就只记一条警告。 */
  readonly model: LanguageModel | null;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * 升到 ctx 0.3 以后，旧摘要的 `covers` 按 `seq` 解释：摘要之前就有补写的旧记录（桌宠对话导入）时，
 * 它们原来看得见，现在被盖住。找出这些摘要，用 yoyo 自己的压缩指令重新压一次，新摘要取代旧摘要。
 * 新摘要是新版本的行，下次启动再找就是空的。没有模型或这次没压成，留到下次启动；出错不抛，不挡常驻进程启动。
 * 返回重新压缩成的摘要数。
 */
export async function recompactLossySummaries(
  context: Pick<Context, 'session' | 'store' | 'builder'>,
  options: RecompactOptions,
): Promise<number> {
  const { model, logger } = options;
  try {
    const findings = await findLossySummaries(context.store, { session: context.session });
    if (findings.length === 0) return 0;
    const hidden = findings.reduce((sum, finding) => sum + finding.hidden.length, 0);
    if (!model) {
      logger.warn(`旧摘要盖住了 ${hidden} 条较晚写进来的记录，没配模型，等下次带着模型启动时再重新压缩`);
      return 0;
    }
    let done = 0;
    for (const finding of findings) {
      const summary = await recompactLossy(context.builder, finding, {
        instructions: COMPACT_INSTRUCTIONS,
        model,
        timeoutMs: options.timeoutMs ?? COMPACT_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (summary) {
        done += 1;
        logger.info(`旧摘要盖住了 ${finding.hidden.length} 条记录，已重新压缩`);
      } else {
        logger.warn('旧摘要没重新压缩成：模型没有给出完整的摘要，等下次启动再试');
      }
    }
    return done;
  } catch (error) {
    logger.warn(`旧摘要没重新压缩成：${errorText(error)}`);
    return 0;
  }
}
