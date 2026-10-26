import { createHarness, type Context, type Executor, type Harness } from '@modelctx-ai/ctx';

import type { Logger } from '../ports/index.ts';

export interface YoyoHarnessOptions {
  /** 注册表里非本地工具绑定的执行环境，例如 MCP hub。注册表自带的函数执行环境不用另给。 */
  readonly executors?: readonly Executor[];
  readonly logger?: Logger;
}

/**
 * yoyo 跑一轮用的 harness：ctx 的参考实现，组装走上下文的 builder，工具走上下文的注册表。
 * 事实怎么收、放哪由 agent 的 `context` 定（碎碎念放进最后一条临时消息，回复接在指令后面）。
 */
export function createYoyoHarness(context: Context, options: YoyoHarnessOptions = {}): Harness {
  return createHarness({
    store: context.store,
    context: context.builder,
    ...(context.tools ? { tools: context.tools } : {}),
    ...(options.executors ? { executors: options.executors } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    source: 'yoyo',
  });
}
