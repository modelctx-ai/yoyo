import {
  describeError,
  redact,
  textOf,
  type Context,
  type ErrorDescription,
  type ErrorInfo,
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
  /** 这一轮只收这些来源（按名字）；不给就全部。 */
  readonly sources?: readonly string[];
  readonly signal?: AbortSignal;
}

/** 跑一轮的那一方：编排器。它决定什么时候、在哪个会话上跑，交给 harness。 */
export type Runs = Pick<Orchestrator, 'submit'>;

/** 模型接口的错误变成一句中文，有状态码时和旧代码一样带上正文片段。 */
function modelErrorText({ message, status, detail }: ErrorDescription): string {
  if (status !== undefined) return `模型接口返回 ${status}${detail ? `：${detail}` : ''}`;
  return `模型没回：${message}`;
}

/** `RunResult.error` 的描述：抹掉密钥、压成一行、截短，和 `describeError` 对抛出来的错误做的一样。 */
function describeInfo(info: ErrorInfo, secrets: readonly string[]): ErrorDescription {
  const clean = (text: string): string => redact(text, secrets).replace(/\s+/g, ' ').trim().slice(0, 180);
  const detail = clean(info.responseBody ?? '');
  return {
    message: clean(info.message),
    ...(info.statusCode !== undefined ? { status: info.statusCode } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** 交给编排器跑一轮，等它跑完，返回最后一步的文字。出错或被取消就抛一句中文。 */
async function run(runs: Runs, request: RunRequest, secrets: readonly string[] | undefined): Promise<string> {
  let result: RunResult;
  try {
    const handle = await runs.submit(request);
    result = await handle.done;
  } catch (error) {
    throw new Error(modelErrorText(describeError(error, { secrets: secrets ?? [] })), { cause: error });
  }
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    const info = result.error ?? { message: `这一轮停在 ${result.stopReason}` };
    throw new Error(modelErrorText(describeInfo(info, secrets ?? [])), { cause: info });
  }
  return result.text;
}

/**
 * 碎碎念这一轮：人设加语气是指令，历史是上下文视图，这一刻的事实（当前任务、粘贴板）由 agent 的 `context` 放进最后一条临时用户消息。
 * 只调模型、不写日志：说出口以后才由导演记。
 */
export function whisperRequest(context: Context, options: ComposeOptions): RunRequest {
  return {
    session: context.session,
    agent: whisperAgent(options.tone, options.model, options.sources ? { sources: options.sources } : {}),
    prompt: whisperPrompt(),
    record: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export interface ReplyOptions extends ComposeOptions {
  readonly searchText?: string;
  /** 打开时模型可以调用工具。 */
  readonly tools?: boolean;
}

function replyRequestAgent(options: ReplyOptions) {
  return replyAgent(options.tone, options.model, {
    tools: options.tools === true,
    ...(options.sources ? { sources: options.sources } : {}),
  });
}

/** 回复这一轮：事实由 agent 的 `context` 接在指令后面，有搜索结果时放在最后一条临时用户消息里。不写日志。 */
export function replyRequest(context: Context, options: ReplyOptions): RunRequest {
  const prompt = searchPrompt(options.searchText);
  return {
    session: context.session,
    agent: replyRequestAgent(options),
    ...(prompt !== undefined ? { prompt } : {}),
    record: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export interface ChatOptions extends ReplyOptions {
  /** 主人在右键对话里说的这句。 */
  readonly text: string;
}

/**
 * 右键对话这一轮：和回复同一个 agent。主人这句还没进日志，连同搜索结果放进最后一条临时用户消息。
 * 不写日志：这一问一答由桌宠记进它的对话记忆，下一拍并进来。
 */
export function chatRequest(context: Context, options: ChatOptions): RunRequest {
  const found = searchPrompt(options.searchText);
  return {
    session: context.session,
    agent: replyRequestAgent(options),
    prompt: found ? `${options.text}\n\n${found}` : options.text,
    record: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** 按上下文视图和这一刻的事实现写一句碎碎念，经编排器跑一轮。 */
export async function generateWhisper(context: Context, runs: Runs, options: ComposeOptions): Promise<Line> {
  const text = await run(runs, whisperRequest(context, options), options.secrets);
  const line = parseWhisper(text, options.tone);
  if (!line) throw new Error('模型没有返回可用的碎碎念');
  const { messages } = await context.view();
  if (messages.some((message) => textOf(message).includes(line.text))) throw new Error('模型重复了最近说过的句子');
  return line;
}

/** 右键对话：经编排器跑一轮，返回整段回复。气泡装得下多句，不按念的那一句截。 */
export async function generateChat(context: Context, runs: Runs, options: ChatOptions): Promise<string> {
  const text = (await run(runs, chatRequest(context, options), options.secrets)).trim();
  if (!text) throw new Error('模型没有返回可用的回复');
  return text;
}

/** 回复主人刚说的话（调用前先 recordUser），经编排器跑一轮。 */
export async function generateReply(context: Context, runs: Runs, options: ReplyOptions): Promise<Line> {
  const text = await run(runs, replyRequest(context, options), options.secrets);
  const line = parseWhisper(text, options.tone, 'reply');
  if (!line) throw new Error('模型没有返回可用的回复');
  return line;
}
