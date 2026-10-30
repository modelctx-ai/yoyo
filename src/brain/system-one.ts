import { redact } from '@modelctx-ai/ctx';
import type { SystemOneSpec } from '@modelctx-ai/ctx-models';

import type { SystemOneConfig } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Logger } from '../ports/index.ts';

/** 配置里的一节写成 `SystemOneSpec`：空着的项不带。记忆的决策、提取模型和碎碎念的间隔模型共用。 */
export function systemOneSpec(config: SystemOneConfig): SystemOneSpec {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.accountId ? { accountId: config.accountId } : {}),
  };
}

/**
 * 按配置里的一节造 System One 模型。没写（`section` 是 undefined）返回 undefined；写得不对（没有 provider、model，
 * cloudflare 没有 accountId，认不得的服务商）记一行「config.json 的 `key` 不对：……，`fallback`」，也返回 undefined。
 * `secrets` 从报错里抹掉。
 */
export function createSystemOne<T>(
  section: SystemOneConfig | undefined,
  key: string,
  fallback: string,
  build: (spec: SystemOneSpec) => T,
  logger: Logger,
  secrets: readonly string[] = [],
): T | undefined {
  if (!section) return undefined;
  try {
    return build(systemOneSpec(section));
  } catch (error) {
    logger.warn(`config.json 的 ${key} 不对：${redact(errorText(error), secrets)}，${fallback}`);
    return undefined;
  }
}
