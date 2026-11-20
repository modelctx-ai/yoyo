import type { AgentSpec, CallSettings, ModelRef, OverflowSpec, ToolSelection } from '@modelctx-ai/ctx';

import type { AgentProfile } from '../features/tasks/agents.ts';

import type { Tone } from '../kernel/types.ts';
import { TASK_COMPACT_INSTRUCTIONS, TASK_INSTRUCTIONS, replyInstructions, whisperInstructions } from './prompts.ts';

/**
 * yoyo 的三个 agent：碎碎念、回复，和后台做子任务的子 agent。同一个 harness 跑不同的配置就是不同的 agent：这里只放配置（JSON 值），
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

/** 子 agent：后台做事，给子 agent 那份注册表里的全部工具；一轮最多 20 步，一次模型调用最多等 90 秒。 */
export const TASK_AGENT = {
  name: 'task',
  tools: true,
  maxSteps: 20,
  settings: { timeoutMs: 90_000, maxRetries: 1, temperature: 0.3 },
  context: { facts: { placement: 'instructions' } },
} as const satisfies Omit<AgentSpec, 'model'>;

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
  options: AgentOptions & { readonly tools?: boolean | readonly string[] } = {},
): AgentSpec {
  return {
    ...REPLY_AGENT,
    model,
    instructions: replyInstructions(tone),
    ...(options.tools ? { tools: options.tools, maxSteps: REPLY_TOOL_STEPS } : {}),
    ...(options.sources ? { context: { facts: { ...REPLY_AGENT.context.facts, sources: options.sources } } } : {}),
  };
}

export interface TaskAgentOptions extends AgentOptions {
  /** 这种子 agent 能用的工具：名字清单，或者全部（true）。 */
  readonly tools?: ToolSelection;
  /** 一次模型调用的估算 token 上限（`tasks.maxTokens`），见 `taskOverflow`；不给或 0 不管。 */
  readonly maxTokens?: number;
}

/** 超窗兜底的压缩最多等多久；超时这一轮就只裁剪，不拦着。 */
const TASK_COMPACT_TIMEOUT_MS = 120_000;

/**
 * 子任务的超窗兜底：每一轮开始前 ctx 的 harness 估算整次调用，超了 `maxTokens` 先把较早的过程压成摘要（写进子任务的会话，
 * 最近 12 条原样留着），压完还超、压缩没做成，再从最早的裁掉；都做完还超，这一轮以 `context_overflow` 结束、不调模型。
 * 只在一轮开始时查，一轮里的二十步不查。
 */
export function taskOverflow(maxTokens: number): OverflowSpec {
  return {
    maxTokens,
    strategy: 'compact',
    compact: { instructions: TASK_COMPACT_INSTRUCTIONS, timeoutMs: TASK_COMPACT_TIMEOUT_MS },
  };
}

/** 子 agent：做事的协议在前，这种类型自己的指令接在后面，工具按类型的清单挑。 */
export function taskAgent(
  model: ModelRef,
  profile: Pick<AgentProfile, 'name' | 'instructions'>,
  options: TaskAgentOptions = {},
): AgentSpec {
  return {
    ...TASK_AGENT,
    model,
    name: `task:${profile.name}`,
    instructions: `${TASK_INSTRUCTIONS}\n\n你是「${profile.name}」子 agent。\n${profile.instructions}`,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    context: {
      facts: options.sources ? { ...TASK_AGENT.context.facts, sources: options.sources } : TASK_AGENT.context.facts,
      ...(options.maxTokens ? { overflow: taskOverflow(options.maxTokens) } : {}),
    },
  };
}
