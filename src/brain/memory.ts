import type { DatabaseSync } from 'node:sqlite';

import {
  type ContextSource,
  type DecisionModel,
  type Entry,
  type ExtractionModel,
  type FactQuery,
  type LanguageModel,
  type Memory,
  type MemoryFact,
  type MemoryStore,
  type SessionStore,
  type SourceRef,
} from '@modelctx-ai/ctx';
import { createMemory } from '@modelctx-ai/ctx-memory';
import { createDecisionModel, createExtractionModel } from '@modelctx-ai/ctx-models';
import { createSqliteMemoryStore } from '@modelctx-ai/ctx-sqlite';

import type { MemoryConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';
import { currentTask, type TaskDeps } from './sources.ts';
import { createSystemOne } from './system-one.ts';

/** 回复用的记忆来源：画像加按最近一条用户话召回的事实。 */
export const MEMORY_SOURCE = 'memory';
/** 碎碎念用的记忆来源：画像加按当前任务召回的事实；没有任务只带画像。 */
export const WHISPER_MEMORY_SOURCE = 'memory-whisper';

/** 回复、碎碎念各带几条召回的事实。 */
const REPLY_FACTS = 5;
const WHISPER_FACTS = 3;

/** 天气和提醒可以重算，不进门控。 */
const UNGATED_KINDS: ReadonlySet<unknown> = new Set(['weather', 'reminder']);

/** `recordLine` 记成助手消息的天气和提醒。 */
export function ungated(entry: Entry): boolean {
  return entry.type === 'message' && entry.message.role === 'assistant' && UNGATED_KINDS.has(entry.meta?.['kind']);
}

/**
 * 记忆读到的会话日志：剔掉天气和提醒。ctx 的 `gate.entries` 只能按条目类型和事件 kind 挑，挑不了消息的 `meta`，
 * 所以在读日志这一层滤掉；门控、巩固读证据、来源取最近一条用户话都经过它。
 */
export function memorySessions(sessions: Pick<SessionStore, 'list'>): Pick<SessionStore, 'list'> {
  return {
    list: async (session, options) => (await sessions.list(session, options)).filter((entry) => !ungated(entry)),
  };
}

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
  /** 门控和并入判断；不给是 ctx 的启发式。 */
  readonly decision?: DecisionModel;
  /** 夜里提取；不给就让 `model` 提取，`model` 也没有就不提取。 */
  readonly extraction?: ExtractionModel;
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
    sessions: memorySessions(options.sessions),
    ...(options.decision ? { decision: options.decision } : {}),
    ...(options.extraction ? { extraction: options.extraction } : {}),
    ...(options.model ? { model: options.model } : {}),
    topics: config.topics,
    // 只看消息：碎碎念是事件，框架事件 ctx.* 也是事件，都不进门控
    gate: { theta: config.gate.theta, entries: { types: ['message'] } },
    decay: { d: config.decay.d, archiveAt: config.decay.archiveAt },
    core: { budgetTokens: config.core.budgetTokens },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { memory, store: options.store };
}

export interface SystemOneModels {
  readonly decision?: DecisionModel;
  readonly extraction?: ExtractionModel;
}

/**
 * `memory.decision`、`memory.extraction` 配了就按 ctx-models 的 System One 工厂造；写得不对（没有 provider、model，
 * cloudflare 没有 accountId，认不得的服务商）记一行，用 ctx 的缺省：门控是启发式，提取交给 `llm` 的模型。
 * `secrets` 从报错里抹掉。
 */
export function createSystemOneModels(
  config: MemoryConfig,
  logger: Logger,
  secrets: readonly string[] = [],
): SystemOneModels {
  const decision = createSystemOne(
    config.decision,
    'memory.decision',
    '门控用启发式',
    createDecisionModel,
    logger,
    secrets,
  );
  const extraction = createSystemOne(
    config.extraction,
    'memory.extraction',
    '提取交给 llm 的模型',
    createExtractionModel,
    logger,
    secrets,
  );
  return { ...(decision ? { decision } : {}), ...(extraction ? { extraction } : {}) };
}

/** 报错里要抹掉的记忆模型密钥。 */
export function memorySecrets(config: MemoryConfig): string[] {
  return [config.decision?.apiKey, config.extraction?.apiKey].filter((key): key is string => Boolean(key));
}

/** 两个记忆来源：回复按 ctx 的缺省（最近一条用户话）召回，碎碎念按当前任务召回。 */
export function memorySources(memory: Memory, deps: TaskDeps): ContextSource[] {
  return [
    memory.source({ name: MEMORY_SOURCE, k: REPLY_FACTS }),
    memory.source({ name: WHISPER_MEMORY_SOURCE, k: WHISPER_FACTS, query: () => currentTask(deps) }),
  ];
}

/** 按 `query` 翻完所有页的事实。 */
export async function allFacts(
  store: MemoryStore,
  query: Omit<FactQuery, 'after' | 'limit'> = {},
): Promise<MemoryFact[]> {
  const out: MemoryFact[] = [];
  for (;;) {
    const page = await store.facts.list({ ...query, ...(out.length ? { after: out.at(-1)!.id } : {}), limit: 200 });
    out.push(...page);
    if (page.length < 200) return out;
  }
}

/** 证据区间里的原文，按会话、`seq` 排。 */
export async function evidenceOf(sessions: Pick<SessionStore, 'list'>, refs: readonly SourceRef[]): Promise<Entry[]> {
  const out = new Map<string, Entry>();
  for (const ref of refs) {
    for (const entry of await sessions.list(ref.session, { after: ref.from - 1 })) {
      if (entry.seq > ref.upTo) break;
      out.set(entry.id, entry);
    }
  }
  return [...out.values()].toSorted((a, b) =>
    a.session === b.session ? a.seq - b.seq : a.session < b.session ? -1 : 1,
  );
}
