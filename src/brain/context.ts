import type { DatabaseSync } from 'node:sqlite';

import {
  assistantEntry,
  createContext,
  eventEntry,
  textOf,
  userEntry,
  type Context,
  type ContextSource,
  type Entry,
  type EntryOptions,
  type Executor,
  type LanguageModel,
  type NewEntry,
  type ProjectionOptions,
  type SessionStore,
  type ToolOutput,
  type ToolRegistry,
} from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

import { contextRoleOf } from '../kernel/line.ts';
import type { Line, PetChatMessage } from '../kernel/types.ts';
import type { Logger } from '../ports/index.ts';

const LEGACY_TABLE = 'context_items';
const MIGRATED_TABLE = 'context_items_migrated';

/** 每只桌宠一个会话。 */
export function sessionFor(petId: string): string {
  return `pet:${petId}`;
}

/** 连续的碎碎念收成一条助手消息；用户话和回复原样带上，不截断。 */
export const yoyoProjection: ProjectionOptions = {
  events: {
    whisper: {
      fold: true,
      render: (events) => {
        const texts = events.map((event) => event.text ?? '').filter(Boolean);
        return texts.length > 0 ? { role: 'assistant', content: `碎碎念：\n${texts.join('\n')}` } : null;
      },
    },
  },
  summary: (entry) => ({ role: 'user', content: `前面对话的摘要：\n${entry.text}` }),
};

/** 子任务做完写回主线程的 `task` 事件：作为一条系统消息交给主线程，由它转告主人。 */
export const TASK_EVENT = 'task';

/** 主线程的投影：再加上子任务的结果。子任务自己的会话用 `yoyoProjection`。 */
export const mainProjection: ProjectionOptions = {
  ...yoyoProjection,
  events: {
    ...yoyoProjection.events,
    [TASK_EVENT]: {
      render: (events) =>
        events
          .filter((event) => event.text)
          .map((event) => ({ role: 'user' as const, content: `系统消息：${event.text ?? ''}` })),
    },
  },
};

/** 子 agent 做的一步，给人看：收到的话、说的话、调了哪个工具、工具回了什么。 */
export interface TaskStep {
  readonly at: number;
  readonly kind: 'input' | 'say' | 'call' | 'result';
  /** 工具名，`call` 和 `result` 才有。 */
  readonly name?: string;
  readonly text: string;
}

function brief(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function outputText(output: ToolOutput): unknown {
  if (output.type === 'text') return output.text;
  if (output.type === 'json') return output.value;
  if (output.type === 'error') return `出错：${output.message}`;
  return output.parts.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
}

/** 子任务会话的日志变成一步步：消息和工具调用、结果，运行记录之类的事件不列。 */
export function taskSteps(entries: readonly Entry[]): TaskStep[] {
  const steps: TaskStep[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const { message, at } = entry;
    if (message.role === 'user') {
      steps.push({ at, kind: 'input', text: textOf(message) });
    } else if (message.role === 'assistant') {
      const parts =
        typeof message.content === 'string' ? [{ type: 'text', text: message.content } as const] : message.content;
      for (const part of parts) {
        if (part.type === 'text' && part.text.trim()) steps.push({ at, kind: 'say', text: part.text.trim() });
        if (part.type === 'tool-call') steps.push({ at, kind: 'call', name: part.name, text: brief(part.input, 400) });
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        steps.push({ at, kind: 'result', name: part.name, text: brief(outputText(part.output), 400) });
      }
    }
  }
  return steps;
}

/** 每个子任务一个会话，输入、工具调用和结果都记在里面。 */
export function taskSession(id: number): string {
  return `task:${id}`;
}

export interface YoyoContextOptions {
  readonly db: DatabaseSync;
  readonly petId: string;
  readonly sources?: readonly ContextSource[];
  readonly tools?: ToolRegistry;
  /** 注册表里非本地工具绑定的执行环境，例如 MCP hub。 */
  readonly executors?: readonly Executor[];
  readonly model?: LanguageModel | null;
  /** 交给模型的历史上限（估算 token）。不给就整段带上。 */
  readonly maxTokens?: number;
  readonly logger?: Logger;
}

export interface TaskContextOptions {
  readonly sources?: readonly ContextSource[];
  readonly tools: ToolRegistry;
  readonly executors?: readonly Executor[];
  readonly model?: LanguageModel | null;
  readonly logger?: Logger;
}

/**
 * 子任务用的上下文：和主线程同一个存储，工具是子 agent 那份注册表。会话按运行给（`taskSession`），
 * 这里的缺省会话不会用到。
 */
export function createTaskContext(main: Pick<Context, 'store'>, options: TaskContextOptions): Context {
  return createContext({
    store: main.store,
    session: taskSession(0),
    projection: yoyoProjection,
    sources: options.sources,
    tools: options.tools,
    executors: options.executors,
    model: options.model ?? undefined,
    source: 'yoyo',
    logger: options.logger,
  });
}

/** ctx-sqlite 复用 yoyo.db（表前缀 'ctx_'）；打开时 ctx-sqlite 自己把 0.1 的库迁到当前结构，第一次还会把旧表 context_items 迁进来。 */
export async function createYoyoContext(options: YoyoContextOptions): Promise<Context> {
  const store = createSqliteStore({ database: options.db, prefix: 'ctx_' });
  const session = sessionFor(options.petId);
  await migrateLegacyContext(options.db, store, session);
  return createContext({
    store,
    session,
    projection: { ...mainProjection, window: options.maxTokens ? { maxTokens: options.maxTokens } : undefined },
    sources: options.sources,
    tools: options.tools,
    executors: options.executors,
    model: options.model ?? undefined,
    source: 'yoyo',
    logger: options.logger,
  });
}

interface LegacyRow {
  readonly role: unknown;
  readonly text: unknown;
  readonly at: unknown;
  readonly item_key: unknown;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** 旧表的一行变成条目。认不出的角色和空文字跳过，和旧的 toMessages 一样。 */
function legacyEntry(row: LegacyRow): NewEntry | null {
  const text = typeof row.text === 'string' ? row.text : '';
  if (!text) return null;
  const stamp = Number(row.at);
  const key = typeof row.item_key === 'string' ? row.item_key : undefined;
  const options: EntryOptions = {
    at: Number.isFinite(stamp) ? stamp : Date.now(),
    source: key?.startsWith('pet:') ? 'dsh-pet' : 'yoyo',
    ...(key !== undefined ? { key } : {}),
  };
  if (row.role === 'user') return userEntry(text, options);
  if (row.role === 'assistant') return assistantEntry(text, options);
  if (row.role === 'whisper') return eventEntry('whisper', { ...options, text });
  return null;
}

/**
 * 把旧表 context_items 迁进 ctx，然后改名成 context_items_migrated，返回写入的条数。
 * 整个过程在一个事务里，失败回滚、下次再试；`store` 要和 `db` 是同一个库。
 */
export async function migrateLegacyContext(db: DatabaseSync, store: SessionStore, session: string): Promise<number> {
  if (!hasTable(db, LEGACY_TABLE)) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    // 别的进程可能刚迁完
    if (!hasTable(db, LEGACY_TABLE)) {
      db.exec('COMMIT');
      return 0;
    }
    const rows = db
      .prepare(`SELECT role, text, at, item_key FROM ${LEGACY_TABLE} ORDER BY at, id`)
      .all() as unknown as LegacyRow[];
    const entries = rows.map(legacyEntry).filter((entry): entry is NewEntry => entry !== null);
    const written = entries.length > 0 ? await store.append(session, entries) : [];
    if (hasTable(db, MIGRATED_TABLE)) {
      // 旧版本又建过一次表：并进已有的备份
      db.exec(
        `INSERT INTO ${MIGRATED_TABLE} (role, text, at, item_key) ` +
          `SELECT role, text, at, item_key FROM ${LEGACY_TABLE} ORDER BY at, id`,
      );
      db.exec(`DROP TABLE ${LEGACY_TABLE}`);
    } else {
      db.exec(`ALTER TABLE ${LEGACY_TABLE} RENAME TO ${MIGRATED_TABLE}`);
    }
    db.exec('COMMIT');
    return written.length;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 说出口的一句写进上下文：回复、提醒、天气是助手消息，碎碎念是碎碎念事件。`meta.kind` 记下台词的类别，
 * 记忆的门控按它剔掉天气和提醒。
 */
export async function recordLine(context: Context, line: Line, at: number): Promise<void> {
  const options = { at, meta: { kind: line.kind } };
  const entry =
    contextRoleOf(line) === 'assistant'
      ? assistantEntry(line.text, options)
      : eventEntry('whisper', { ...options, text: line.text });
  await context.append(entry);
}

export async function recordUser(context: Context, text: string, at: number): Promise<void> {
  await context.append(userEntry(text, { at }));
}

/** 桌宠对话记忆变成条目。同一条（时间、角色、原文）用同一个幂等键，和旧代码一字不差。 */
export function petChatEntries(messages: readonly PetChatMessage[]): NewEntry[] {
  const seen = new Set<string>();
  const entries: NewEntry[] = [];
  for (const message of messages ?? []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = message.content ?? '';
    if (!text) continue;
    const key = `pet:${message.ts}:${message.role}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const options: EntryOptions = { at: message.ts || Date.now(), key, source: 'dsh-pet' };
    entries.push(message.role === 'user' ? userEntry(text, options) : assistantEntry(text, options));
  }
  return entries;
}

/** 并进桌宠对话记忆，已有的键由存储跳过。返回新写入的条数。 */
export async function storePetChat(context: Context, messages: readonly PetChatMessage[]): Promise<number> {
  const entries = petChatEntries(messages);
  if (entries.length === 0) return 0;
  return (await context.append(...entries)).length;
}
