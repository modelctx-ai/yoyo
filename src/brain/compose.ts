import {
  describeError,
  textOf,
  type Context,
  type ModelRef,
  type Orchestrator,
  type RunRequest,
  type RunResult,
} from '@modelctx-ai/ctx';

import { TONE_ACTION, TONE_CUES } from '../kernel/tone.ts';
import type { Line, Tone } from '../kernel/types.ts';
import { replyAgent, whisperAgent } from './agents.ts';
import { searchPrompt, whisperPrompt } from './prompts.ts';

/** 去掉模型可能带上的代码块、引号和句首标签，留下能直接念的一句。 */
export function parseWhisper(
  raw: string | null | undefined,
  tone: Tone,
  kind: 'generated' | 'reply' = 'generated',
): Line | null {
  let text =
    (raw ?? '')
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? '';
  text = text
    .replace(/^[「『"']+/, '')
    .replace(/[」』"']+$/, '')
    .trim();
  text = text.replace(/^\[[^\]\n]+\]\s*/, '').trim();
  if (text.length < 4 || text.length > 80) return null;
  const cue = TONE_CUES[tone];
  const action = TONE_ACTION[tone];
  if (!cue || !action) return null;
  return { text, tone, cue, action, kind };
}

export interface ComposeOptions {
  readonly tone: Tone;
  readonly model: ModelRef;
  /** 报错文案里要抹掉的密钥。 */
  readonly secrets?: readonly string[];
  readonly signal?: AbortSignal;
}

/** 跑一轮的那一方：编排器。它决定什么时候、在哪个会话上跑，交给 harness。 */
export type Runs = Pick<Orchestrator, 'submit'>;

/** 模型接口的错误变成一句中文，有状态码时和旧代码一样带上正文片段。 */
function modelErrorText(error: unknown, secrets: readonly string[] | undefined): string {
  const { message, status, detail } = describeError(error, { secrets: secrets ?? [] });
  if (status !== undefined) return `模型接口返回 ${status}${detail ? `：${detail}` : ''}`;
  return `模型没回：${message}`;
}

/**
 * 记下模型抛的原始错误。`RunResult.error` 只有消息，没有状态码和正文，报错文案要用原来的错误。
 * 只包 `doGenerate`、`doStream`，别的原样转给模型。
 */
function watched(model: ModelRef, onError: (error: unknown) => void): ModelRef {
  if (typeof model === 'string') return model;
  return new Proxy(model, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if ((key !== 'doGenerate' && key !== 'doStream') || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (error) {
          onError(error);
          throw error;
        }
      };
    },
  });
}

/** 交给编排器跑一轮，等它跑完，返回最后一步的文字。出错或被取消就抛一句中文。 */
async function run(runs: Runs, request: RunRequest, secrets: readonly string[] | undefined): Promise<string> {
  let failure: unknown;
  const model = watched(request.agent.model, (error) => {
    failure = error;
  });
  let result: RunResult;
  try {
    const handle = await runs.submit({ ...request, agent: { ...request.agent, model } });
    result = await handle.done;
  } catch (error) {
    throw new Error(modelErrorText(error, secrets), { cause: error });
  }
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    const cause = failure ?? new Error(result.error?.message ?? `这一轮停在 ${result.stopReason}`);
    throw new Error(modelErrorText(cause, secrets), { cause });
  }
  return result.text;
}

/**
 * 碎碎念这一轮：人设加语气是指令，历史是上下文视图，这一刻的事实（当前任务、粘贴板）放进最后一条临时用户消息。
 * 只调模型、不写日志：说出口以后才由导演记。
 */
export async function whisperRequest(context: Context, options: ComposeOptions): Promise<RunRequest> {
  const facts = await context.facts(options.signal);
  return {
    session: context.session,
    agent: whisperAgent(options.tone, options.model),
    prompt: whisperPrompt(facts),
    record: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export interface ReplyOptions extends ComposeOptions {
  readonly searchText?: string;
  /** 打开时模型可以调用工具。 */
  readonly tools?: boolean;
}

/** 回复这一轮：事实接在指令后面，有搜索结果时放在最后一条临时用户消息里。不写日志。 */
export async function replyRequest(context: Context, options: ReplyOptions): Promise<RunRequest> {
  const facts = await context.facts(options.signal);
  const prompt = searchPrompt(options.searchText);
  return {
    session: context.session,
    agent: replyAgent(options.tone, options.model, { tools: options.tools === true, facts }),
    ...(prompt !== undefined ? { prompt } : {}),
    record: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** 按上下文视图和这一刻的事实现写一句碎碎念，经编排器跑一轮。 */
export async function generateWhisper(context: Context, runs: Runs, options: ComposeOptions): Promise<Line> {
  const text = await run(runs, await whisperRequest(context, options), options.secrets);
  const line = parseWhisper(text, options.tone);
  if (!line) throw new Error('模型没有返回可用的碎碎念');
  const { messages } = await context.view();
  if (messages.some((message) => textOf(message).includes(line.text))) throw new Error('模型重复了最近说过的句子');
  return line;
}

/** 回复主人刚说的话（调用前先 recordUser），经编排器跑一轮。 */
export async function generateReply(context: Context, runs: Runs, options: ReplyOptions): Promise<Line> {
  const text = await run(runs, await replyRequest(context, options), options.secrets);
  const line = parseWhisper(text, options.tone, 'reply');
  if (!line) throw new Error('模型没有返回可用的回复');
  return line;
}
