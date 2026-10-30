/**
 * 读、写、改文件和跑命令四个工具共用的一层：每个工具是一个「动作」（查参数、照参数做一次），
 * 开关是 `allow` 时工具直接做，是 `ask` 时工具只记下一条批准请求，等主人在工作台里批准以后由常驻进程照原参数做一次
 * （`runtime/approvals.ts`），是 `deny` 时没有这个工具。`ask` 的工具自己的执行函数不会做事，
 * 所以没有接上批准的地方（没给 `gate`）也只会拒绝，不会放行。
 */
import { tool, type LocalToolRegistry, type ToolOutput } from '@modelctx-ai/ctx';
import type { z } from 'zod';

import { TaskError } from '../features/tasks/tasks.ts';
import { ApprovalError } from '../features/approvals/approvals.ts';

/** 规则不让、路径不对、文件不在：原样交回模型的一句话。 */
export class FileError extends Error {}

/** 常见的系统错误换成一句话；认不出的返回 null。 */
export function errnoText(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return '没有这个文件或目录';
  if (code === 'EISDIR') return '这是目录';
  if (code === 'ENOTDIR') return '路径中间有一段不是目录';
  if (code === 'EACCES' || code === 'EPERM') return '系统不让读写这个位置';
  return null;
}

/** 规则不让、文件不在这些原样交回模型；别的错照常抛。 */
export async function answered(work: () => string | Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FileError) return error.message;
    const text = errnoText(error);
    if (text) return text;
    throw error;
  }
}

/** 一个工具能做的事。输入都是模型给的原样 JSON，这里先按工具的结构查一遍。 */
export interface Action {
  /** 参数对不对、规则让不让；对就回给人看的一句摘要，不对抛 `FileError`（不用等批准就能告诉模型）。 */
  summarize(raw: unknown): string;
  /** 照参数做一次，回给模型看的话。做之前规则会再查一遍。 */
  perform(raw: unknown, signal?: AbortSignal): Promise<string>;
}

/** 批准以后常驻进程照这张表做：工具名到动作。 */
export type ActionTable = Map<string, Action>;

export function defineAction<I>(
  schema: z.ZodType<I>,
  check: (input: I) => string,
  run: (input: I, signal?: AbortSignal) => Promise<string>,
): Action {
  const parse = (raw: unknown): I => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new FileError(
        `参数不对：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
      );
    }
    return parsed.data;
  };
  return {
    summarize: (raw) => {
      try {
        return check(parse(raw));
      } catch (error) {
        const text = error instanceof FileError ? null : errnoText(error);
        if (text) throw new FileError(text, { cause: error });
        throw error;
      }
    },
    perform: (raw, signal) => run(parse(raw), signal),
  };
}

/** 模型调了 `ask` 的工具：记下批准请求，回给模型的话。`session` 是这一轮的会话，`runId` 是这一轮的运行编号。 */
export interface ApprovalGate {
  request(call: {
    readonly tool: string;
    readonly input: unknown;
    readonly summary: string;
    readonly session: string;
    readonly runId?: string | undefined;
  }): string;
}

export interface AskDeps {
  /** 批准以后照着做的表；要接批准的就给。 */
  readonly actions?: ActionTable;
  /** 记批准请求；不给，`ask` 的工具只拒绝。 */
  readonly gate?: ApprovalGate;
}

/** `ask` 的工具说明末尾加的一句：模型据此知道调了不等于做了。 */
export const ASK_NOTE = '要主人在工作台里批准才会真的做：调用以后只是记下一条待批准的请求，先别当作做完了。';

const text = (value: string): ToolOutput => ({ type: 'text', text: value });

export interface GatedTool<I> {
  readonly name: string;
  readonly permission: 'allow' | 'ask' | 'deny';
  readonly description: string;
  readonly schema: z.ZodType<I>;
  readonly action: Action;
}

/**
 * 把一个工具放进注册表：`deny` 不放，`allow` 直接做，`ask` 放进来但每次调用都只记批准请求。
 * 动作同时记进 `actions`，批准以后常驻进程照它做。
 */
export function addGated<I>(registry: LocalToolRegistry, deps: AskDeps, spec: GatedTool<I>): void {
  const { name, permission, action } = spec;
  if (permission === 'deny') return;
  deps.actions?.set(name, action);
  registry.addTool(
    name,
    tool({
      description: permission === 'ask' ? `${spec.description}${ASK_NOTE}` : spec.description,
      inputSchema: spec.schema,
      // 工具自己的执行函数：`ask` 的绝不做事
      execute: async (input, options) =>
        permission === 'ask'
          ? '这个工具要主人批准，这里没法批准，没有做。'
          : action.perform(input, options?.abortSignal),
    }),
  );
  if (permission !== 'ask' || !deps.gate) return;
  const { gate } = deps;
  const { executor: _bound, ...definition } = registry.executor.definition(name)!;
  // 换成建批准请求的函数：它拿得到这一轮的会话，知道是主线程还是哪个子任务要的
  registry.executor.register(
    definition,
    (raw, context) => {
      try {
        const summary = action.summarize(raw);
        return text(gate.request({ tool: name, input: raw, summary, session: context.session, runId: context.runId }));
      } catch (error) {
        if (error instanceof FileError || error instanceof TaskError || error instanceof ApprovalError) {
          return text(error.message);
        }
        throw error;
      }
    },
    { replace: true },
  );
}
