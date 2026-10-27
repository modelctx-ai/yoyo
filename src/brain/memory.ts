import type { DatabaseSync } from 'node:sqlite';

import type { ContextSource, LanguageModel, Memory, MemoryStore, SessionStore } from '@modelctx-ai/ctx';
import { createMemory } from '@modelctx-ai/ctx-memory';
import { createSqliteMemoryStore } from '@modelctx-ai/ctx-sqlite';

import type { MemoryConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';
import { currentTask, type TaskDeps } from './sources.ts';

/** 回复用的记忆来源：画像加按最近一条用户话召回的事实。 */
export const MEMORY_SOURCE = 'memory';
/** 碎碎念用的记忆来源：画像加按当前任务召回的事实；没有任务只带画像。 */
export const WHISPER_MEMORY_SOURCE = 'memory-whisper';

/** 回复、碎碎念各带几条召回的事实。 */
const REPLY_FACTS = 5;
const WHISPER_FACTS = 3;

/** 记忆和它的存储。命令和编排器要直接读存储（笔记数、事实表），`Memory` 本身不给。 */
export interface YoyoMemory {
  readonly memory: Memory;
  readonly store: MemoryStore;
}

/** 记忆表和 `ctx_` 表在同一个 yoyo.db 里，表名前缀 `memory_`。 */
export function openMemoryStore(db: DatabaseSync): MemoryStore {
  return createSqliteMemoryStore({ database: db, prefix: 'memory_' });
}

export interface YoyoMemoryOptions {
  readonly store: MemoryStore;
  /** 会话日志，只读。 */
  readonly sessions: Pick<SessionStore, 'list'>;
  readonly config: MemoryConfig;
  /** 反思、重写画像、没配提取模型时提取。没有就跳过反思，画像用缺省渲染。 */
  readonly model?: LanguageModel | null;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** 按 `config.memory` 建 ctx 的记忆。决策模型不配就是 ctx 的启发式。 */
export function createYoyoMemory(options: YoyoMemoryOptions): YoyoMemory {
  const { config } = options;
  const memory = createMemory({
    store: options.store,
    sessions: options.sessions,
    ...(options.model ? { model: options.model } : {}),
    topics: config.topics,
    gate: { theta: config.gate.theta },
    decay: { d: config.decay.d, archiveAt: config.decay.archiveAt },
    core: { budgetTokens: config.core.budgetTokens },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { memory, store: options.store };
}

/** 两个记忆来源：回复按 ctx 的缺省（最近一条用户话）召回，碎碎念按当前任务召回。 */
export function memorySources(memory: Memory, deps: TaskDeps): ContextSource[] {
  return [
    memory.source({ name: MEMORY_SOURCE, k: REPLY_FACTS }),
    memory.source({ name: WHISPER_MEMORY_SOURCE, k: WHISPER_FACTS, query: () => currentTask(deps) }),
  ];
}
