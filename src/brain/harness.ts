import { createHarness, type Context, type Executor, type Harness } from '@modelctx-ai/ctx';

import type { Logger } from '../ports/index.ts';

export interface YoyoHarnessOptions {
  /** 注册表里非本地工具绑定的执行环境，例如 MCP hub。注册表自带的函数执行环境不用另给。 */
  readonly executors?: readonly Executor[];
  readonly logger?: Logger;
}

/**
 * yoyo 跑一轮用的 harness：ctx 的参考实现，组装走上下文的 builder，工具走上下文的注册表。
 * 事实由提交的一方按 agent 放好（碎碎念放进最后一条临时消息，回复接在指令后面），这里的 builder 不再收集，免得放两遍。
 */
export function createYoyoHarness(context: Context, options: YoyoHarnessOptions = {}): Harness {
  return createHarness({
    store: context.store,
    context: {
      build: (request) => context.builder.build({ ...request, facts: false }),
      view: (session, viewOptions) => context.builder.view(session, viewOptions),
    },
    ...(context.tools ? { tools: context.tools } : {}),
    ...(options.executors ? { executors: options.executors } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    source: 'yoyo',
  });
}
