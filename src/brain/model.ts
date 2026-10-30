import type { LanguageModel } from '@modelctx-ai/ctx';
import { createModel, type SystemOneSpec } from '@modelctx-ai/ctx-models';

import { llmReady, type LlmConfig, type SystemOneConfig } from '../app/config.ts';

/** 模型配齐了才建；没配齐返回 null，碎碎念只用预制台词。 */
export function createLanguageModel(llm: LlmConfig): LanguageModel | null {
  if (!llmReady(llm)) return null;
  return createModel({
    provider: llm.provider,
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    name: 'yoyo',
  });
}
/** 配置里的一节写成 `SystemOneSpec`：空着的项不带。 */
export function systemOneSpec(config: SystemOneConfig): SystemOneSpec {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.accountId ? { accountId: config.accountId } : {}),
  };
}
