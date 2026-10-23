import { randomBytes } from 'node:crypto';

import type { Context } from '@modelctx-ai/ctx';
import { startGateway, withContext } from '@modelctx-ai/ctx-gateway';

import { llmReady, type LlmConfig } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { KvRepo, Logger } from '../ports/index.ts';

export interface Channel {
  /** 给桌宠填的接口地址，只听本机。 */
  readonly baseUrl: string;
  /** 给桌宠的一次性本机令牌，真密钥只留在 yoyo 进程里。 */
  readonly token: string;
  close(): Promise<void>;
}

/**
 * 桌宠右键对话的渠道：本机网关转发到 `llm.baseUrl`，桌宠自己截过的历史换成 ctx 的视图。
 * kv 里记下 channel-base、channel-token，`yoyo chat sync` 用它重接。
 */
export async function startChannel(options: {
  readonly llm: LlmConfig;
  readonly context: Context;
  readonly kv: KvRepo;
  readonly logger?: Logger;
}): Promise<Channel> {
  const { llm, context, kv, logger } = options;
  if (llm.provider !== 'openai-compatible') throw new Error('对话渠道只支持 openai-compatible 的模型接口');
  if (!llmReady(llm)) throw new Error('config.json 的 llm 不完整');
  const token = randomBytes(24).toString('base64url');
  const gateway = await startGateway({
    upstream: { baseUrl: llm.baseUrl, apiKey: llm.apiKey },
    accessToken: token,
    rewrite: withContext(context),
    onError: (error) => logger?.warn(`对话渠道转发失败：${errorText(error)}`),
  });
  kv.set('channel-base', gateway.baseUrl);
  kv.set('channel-token', token);
  return { baseUrl: gateway.baseUrl, token, close: () => gateway.close() };
}
