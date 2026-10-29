import { randomBytes } from 'node:crypto';

import { chatText, startGateway, type ChatCompletionRequest } from '@modelctx-ai/ctx-gateway';

import { errorText } from '../app/log.ts';
import type { KvRepo, Logger } from '../ports/index.ts';

export interface Channel {
  /** 给桌宠填的接口地址，只听本机。 */
  readonly baseUrl: string;
  /** 给桌宠的一次性本机令牌，真密钥只留在 yoyo 进程里。 */
  readonly token: string;
  close(): Promise<void>;
}

/** 桌宠发来的一次请求：右键对话的一句，或者它自己的「碎碎念」。 */
export type PetAsk = { readonly kind: 'chat'; readonly text: string } | { readonly kind: 'whisper' };

/** 回答桌宠的一次请求，给出回复的正文。`signal` 在桌宠断开或等太久时中止。 */
export type AnswerPet = (ask: PetAsk, signal: AbortSignal) => Promise<string>;

/** 桌宠一次请求最多等 60 秒（独立模式 `timeoutMs` 的上限，绑定时设成它）；留几秒把回复送回去。 */
export const ANSWER_TIMEOUT_MS = 55_000;

/** 桌宠自己的碎碎念请求以这句开头（dsh-pet `host/whisper.ts` 的 `USER_TEXT`）。 */
const PET_WHISPER = '随便说一句日常碎碎念';
/** 开着对话配图时，桌宠在主人这句后面接一段表情包清单（dsh-pet `host/chat.ts` 的 `imageInstruction`）。 */
const IMAGE_INSTRUCTION = '\n\n[配图]';

/** 桌宠这次要什么：看最后一条用户消息。桌宠自己带的人设和截断历史都不要，上下文用 yoyo 的。 */
export function petAsk(request: ChatCompletionRequest): PetAsk | null {
  const last = request.messages.findLast((message) => message.role === 'user');
  if (!last) return null;
  const raw = chatText(last.content);
  if (raw.startsWith(PET_WHISPER)) return { kind: 'whisper' };
  const cut = raw.indexOf(IMAGE_INSTRUCTION);
  const text = (cut < 0 ? raw : raw.slice(0, cut)).trim();
  return text ? { kind: 'chat', text } : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function failure(status: number, message: string): Response {
  return json(status, { error: { message, type: 'yoyo_error' } });
}

/**
 * 网关的上游换成 yoyo 自己：`POST …/chat/completions` 交给 `answer`，按请求的 `stream`
 * 回 Chat Completions 的 SSE 或一次性 JSON；别的路径 404。网关的令牌、Host、Origin 检查照旧。
 */
export function answeringFetch(answer: AnswerPet, logger?: Logger): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return failure(404, 'not found');
    // 网关配了改写：正文已经按 JSON 解析、检查过 messages，再序列化成字符串交过来
    if (typeof init.body !== 'string') return failure(400, 'request body must be JSON');
    const request = JSON.parse(init.body) as ChatCompletionRequest;
    const ask = petAsk(request);
    if (!ask) return failure(400, 'no user message');
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(ANSWER_TIMEOUT_MS)]);
    const reply = answer(ask, signal).catch((error: unknown) => {
      logger?.warn(`右键对话没回成：${errorText(error)}`);
      throw error;
    });
    const id = `chatcmpl-${randomBytes(9).toString('base64url')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof request.model === 'string' && request.model ? request.model : 'yoyo';

    if (request.stream !== true) {
      try {
        const content = await reply;
        return json(200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        });
      } catch (error) {
        return failure(502, errorText(error));
      }
    }

    const encoder = new TextEncoder();
    const event = (data: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta: Record<string, string>, finish: 'stop' | null) =>
      event({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // 先回一个角色块：桌宠马上拿到响应头，一轮可能要调工具，跑得久
        controller.enqueue(chunk({ role: 'assistant' }, null));
        let parts: Uint8Array[];
        try {
          parts = [chunk({ content: await reply }, null), chunk({}, 'stop'), encoder.encode('data: [DONE]\n\n')];
        } catch (error) {
          // OpenAI 的 SDK 读到流里的 error 就抛错
          parts = [event({ error: { message: errorText(error), type: 'yoyo_error' } })];
        }
        if (signal.aborted) return;
        try {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        } catch {
          /* 桌宠已经断开 */
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    });
  };
}

/**
 * 桌宠右键对话的渠道：本机网关，令牌只给桌宠。请求不转发出去，由 `answer` 在 yoyo 里跑完整的一轮。
 * kv 里记下 channel-base、channel-token，`yoyo chat sync` 用它重接。
 */
export async function startChannel(options: {
  readonly answer: AnswerPet;
  readonly kv: KvRepo;
  readonly logger?: Logger;
}): Promise<Channel> {
  const { answer, kv, logger } = options;
  const token = randomBytes(24).toString('base64url');
  const gateway = await startGateway({
    // 不会真的连：`fetch` 换成了 yoyo 自己
    upstream: { baseUrl: 'http://yoyo.invalid/v1' },
    accessToken: token,
    // 原样返回：只为让网关先解析、检查请求正文，坏的回 400
    rewrite: (request) => request,
    fetch: answeringFetch(answer, logger),
    onError: (error) => logger?.warn(`对话渠道出错：${errorText(error)}`),
  });
  kv.set('channel-base', gateway.baseUrl);
  kv.set('channel-token', token);
  return { baseUrl: gateway.baseUrl, token, close: () => gateway.close() };
}
