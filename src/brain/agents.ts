import { renderFacts, type AgentSpec, type CallSettings, type Fact, type ModelRef } from '@modelctx-ai/ctx';

import type { Tone } from '../kernel/types.ts';
import { replyInstructions, whisperInstructions } from './prompts.ts';

/**
 * yoyo 的两个 agent。同一个 harness 跑不同的配置就是不同的 agent：这里只放配置（JSON 值），
 * 人设和语气、模型每一轮按当时填进去。
 */

/** 一轮最多等 30 秒，失败重试一次。 */
const SETTINGS: CallSettings = { timeoutMs: 30_000, maxRetries: 1 };

/** 碎碎念：不给工具，一步。 */
export const WHISPER_AGENT = {
  name: 'whisper',
  tools: false,
  maxSteps: 1,
  settings: { ...SETTINGS, temperature: 0.8 },
} as const satisfies Omit<AgentSpec, 'model'>;

/** 回复：缺省不给工具；`llm.tools` 打开时给全部工具，最多 4 步。 */
export const REPLY_AGENT = {
  name: 'reply',
  tools: false,
  maxSteps: 1,
  settings: { ...SETTINGS, temperature: 0.7 },
} as const satisfies Omit<AgentSpec, 'model'>;

const REPLY_TOOL_STEPS = 4;

export function whisperAgent(tone: Tone, model: ModelRef): AgentSpec {
  return { ...WHISPER_AGENT, model, instructions: whisperInstructions(tone) };
}

/** 回复的事实（当前任务、粘贴板）接在指令后面。 */
export function replyAgent(
  tone: Tone,
  model: ModelRef,
  options: { readonly tools?: boolean; readonly facts?: readonly Fact[] } = {},
): AgentSpec {
  const facts = options.facts && options.facts.length > 0 ? renderFacts(options.facts) : '';
  return {
    ...REPLY_AGENT,
    model,
    instructions: [replyInstructions(tone), facts].filter((part) => part.trim() !== '').join('\n\n'),
    ...(options.tools ? { tools: true, maxSteps: REPLY_TOOL_STEPS } : {}),
  };
}
