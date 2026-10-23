import { describeError, textOf, type Context, type GenerateOptions, type LanguageModel } from '@modelctx-ai/ctx';

import { TONE_ACTION, TONE_CUES } from '../kernel/tone.ts';
import type { Line, Tone } from '../kernel/types.ts';
import { replyInstructions, searchPrompt, whisperInstructions, whisperPrompt } from './prompts.ts';

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
  /** 不给就用上下文的缺省模型。 */
  readonly model?: LanguageModel | null;
  /** 报错文案里要抹掉的密钥。 */
  readonly secrets?: readonly string[];
  readonly signal?: AbortSignal;
}

/** 模型接口的错误变成一句中文，有状态码时和旧代码一样带上正文片段。 */
function modelErrorText(error: unknown, secrets: readonly string[] | undefined): string {
  const { message, status, detail } = describeError(error, { secrets: secrets ?? [] });
  if (status !== undefined) return `模型接口返回 ${status}${detail ? `：${detail}` : ''}`;
  return `模型没回：${message}`;
}

/** 只调模型、不写日志：说出口以后才由导演记。 */
async function ask(context: Context, options: ComposeOptions, call: GenerateOptions): Promise<string> {
  try {
    const result = await context.generate({
      ...call,
      timeoutMs: 30_000,
      maxRetries: 1,
      record: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return result.text;
  } catch (error) {
    throw new Error(modelErrorText(error, options.secrets), { cause: error });
  }
}

/** 按上下文视图和这一刻的事实（当前任务、粘贴板）现写一句碎碎念。 */
export async function generateWhisper(context: Context, options: ComposeOptions): Promise<Line> {
  const text = await ask(context, options, {
    instructions: whisperInstructions(options.tone),
    prompt: whisperPrompt,
    temperature: 0.8,
    tools: false,
  });
  const line = parseWhisper(text, options.tone);
  if (!line) throw new Error('模型没有返回可用的碎碎念');
  const { messages } = await context.view();
  if (messages.some((message) => textOf(message).includes(line.text))) throw new Error('模型重复了最近说过的句子');
  return line;
}

/** 回复主人刚说的话（调用前先 recordUser）。`tools` 打开时模型可以调用工具。 */
export async function generateReply(
  context: Context,
  options: ComposeOptions & { readonly searchText?: string; readonly tools?: boolean },
): Promise<Line> {
  const tools = options.tools === true;
  const text = await ask(context, options, {
    instructions: replyInstructions(options.tone),
    prompt: searchPrompt(options.searchText),
    temperature: 0.7,
    tools,
    maxSteps: tools ? 4 : 1,
  });
  const line = parseWhisper(text, options.tone, 'reply');
  if (!line) throw new Error('模型没有返回可用的回复');
  return line;
}
