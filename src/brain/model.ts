import type { LanguageModel } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';

import { llmReady, type LlmConfig } from '../app/config.ts';

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
