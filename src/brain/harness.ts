import { createHarness, type Context, type Executor, type Harness, type RunResult } from '@modelctx-ai/ctx';

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

/** 一轮的文字增量：模型每吐一小段就交一次。 */
export type DeltaSink = (text: string) => void;

export interface DeltaTap {
  /** 交给编排器的 harness：登记过的那一轮改走流式，别的原样跑。 */
  readonly harness: Harness;
  /** 登记一轮（按 `runId`，请求里自己给）要看文字增量；返回的函数取消登记，跑完记得调。 */
  watch(runId: string, sink: DeltaSink): () => void;
}

/**
 * 编排器只调 harness 的 `run`，拿不到增量。包一层：登记过 `runId` 的那一轮改用 harness 的 `stream`，
 * 把 `text.delta` 交给登记的函数，再用 `run.ended` 的结果当这一轮的返回，结果和 `run` 一样（文字、停下的原因、错误）；
 * 流式的结果不带 `messages` 和 `recorded`（事件里没有这两样），要它们的请求不要登记。
 * harness 没有 `stream`，或者这一轮没登记，就原样 `run`。
 */
export function tapDeltas(inner: Harness): DeltaTap {
  const sinks = new Map<string, DeltaSink>();
  return {
    harness: {
      async run(request) {
        const sink = request.runId ? sinks.get(request.runId) : undefined;
        if (!sink || !inner.stream) return inner.run(request);
        let result: RunResult | undefined;
        for await (const event of inner.stream(request)) {
          if (event.type === 'text.delta') {
            try {
              sink(event.text);
            } catch {
              // 看增量的一方出错不能连累这一轮
            }
          } else if (event.type === 'run.ended') {
            result = { ...event.result, messages: [], recorded: [] };
          }
        }
        if (!result) throw new Error('模型的流没有正常结束');
        return result;
      },
    },
    watch(runId, sink) {
      sinks.set(runId, sink);
      return () => void sinks.delete(runId);
    },
  };
}
