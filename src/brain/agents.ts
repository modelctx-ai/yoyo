import type { AgentSpec, CallSettings, ModelRef } from '@modelctx-ai/ctx';

import type { Tone } from '../kernel/types.ts';
import { replyInstructions, whisperInstructions } from './prompts.ts';

/**
 * yoyo 的两个 agent。同一个 harness 跑不同的配置就是不同的 agent：这里只放配置（JSON 值），
 * 人设和语气、模型每一轮按当时填进去。
 */

/** 一轮最多等 30 秒，失败重试一次。 */
const SETTINGS: CallSettings = { timeoutMs: 30_000, maxRetries: 1 };

/** 碎碎念：不给工具，一步。事实放进最后一条临时用户消息。 */
export const WHISPER_AGENT = {
  name: 'whisper',
  tools: false,
  maxSteps: 1,
  settings: { ...SETTINGS, temperature: 0.8 },
  context: { facts: { placement: 'prompt' } },
} as const satisfies Omit<AgentSpec, 'model'>;

/** 回复：缺省不给工具；`llm.tools` 打开时给全部工具，最多 4 步。事实接在指令后面。 */
export const REPLY_AGENT = {
  name: 'reply',
  tools: false,
  maxSteps: 1,
  settings: { ...SETTINGS, temperature: 0.7 },
  context: { facts: { placement: 'instructions' } },
} as const satisfies Omit<AgentSpec, 'model'>;

const REPLY_TOOL_STEPS = 4;

/** 两个 agent 各收哪些来源（按名字）。不给就收 builder 里的全部来源。 */
export interface FactSources {
  readonly whisper: readonly string[];
  readonly reply: readonly string[];
}

export interface AgentOptions {
  /** 这一轮只收这些来源；不给就全部。 */
  readonly sources?: readonly string[];
}

export function whisperAgent(tone: Tone, model: ModelRef, options: AgentOptions = {}): AgentSpec {
  return {
    ...WHISPER_AGENT,
    model,
    instructions: whisperInstructions(tone),
    ...(options.sources ? { context: { facts: { ...WHISPER_AGENT.context.facts, sources: options.sources } } } : {}),
  };
}

export function replyAgent(
  tone: Tone,
  model: ModelRef,
  options: AgentOptions & { readonly tools?: boolean } = {},
): AgentSpec {
  return {
    ...REPLY_AGENT,
    model,
    instructions: replyInstructions(tone),
    ...(options.tools ? { tools: true, maxSteps: REPLY_TOOL_STEPS } : {}),
    ...(options.sources ? { context: { facts: { ...REPLY_AGENT.context.facts, sources: options.sources } } } : {}),
  };
}
