/**
 * 管理页的接口：只做主人在命令行里也能做的事（看状态、上下文和记录，管记忆、日程和联系人，让 yoyo 说一句或听一句），
 * 用的也是同一套函数。HTTP 和安全检查在 `server.ts`。
 */
import { compareEntries, textOf, type Context, type Entry, type MemoryStore } from '@modelctx-ai/ctx';

import type { Config } from '../app/config.ts';
import type { Paths } from '../app/paths.ts';
import { allFacts } from '../brain/memory.ts';
import { addSchedule, removeSchedule } from '../features/alarms/schedule.ts';
import { addContact, removeContact } from '../features/contacts/contacts.ts';
import type { PetHost, Repos } from '../ports/index.ts';
import { enqueue } from '../runtime/inbox.ts';
import { SettingsError, readSettings, saveSwitches, saveText } from './settings.ts';

export interface WebDeps {
  readonly config: Config;
  readonly paths: Pick<Paths, 'inboxFile' | 'configFile'>;
  readonly repos: Repos;
  readonly context: Pick<Context, 'entries'>;
  readonly memory: MemoryStore;
  readonly host: Pick<PetHost, 'name' | 'workStatus'>;
  /** 编排器的排期：下一句碎碎念、最近一次说话。常驻进程里才有。 */
  readonly schedule?: () => { readonly nextWhisper: number; readonly lastTalk: number };
  readonly now?: () => Date;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** 主人能改的、说清楚哪里不对的错：回 400 和这句话。 */
export class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });

/** 画像最长多少字：比整理时写的宽松，挡住误贴的大段文字。 */
const CORE_MAX = 4000;

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function text(body: unknown, name: string): string | undefined {
  const value = field(body, name);
  return typeof value === 'string' ? value : undefined;
}

function limitOf(query: URLSearchParams, fallback: number, max: number): number {
  const value = Number(query.get('limit'));
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** 删的东西没找到就回 404。 */
function removed<T>(value: T | null, what: string): T {
  if (value === null) throw new RequestError(`没有这${what}`, 404);
  return value;
}

/** 上下文的一条，给页面看：消息按角色，碎碎念、摘要单列。别的条目不列。 */
export function contextItem(entry: Entry): { at: number; kind: string; text: string } | null {
  if (entry.type === 'message') {
    const body = textOf(entry.message);
    return body ? { at: entry.at, kind: entry.message.role, text: body } : null;
  }
  if (entry.type === 'event' && entry.kind === 'whisper' && entry.text) {
    return { at: entry.at, kind: 'whisper', text: entry.text };
  }
  if (entry.type === 'summary') return { at: entry.at, kind: 'summary', text: entry.text };
  return null;
}

export function createWebApi(deps: WebDeps): (method: string, path: string, body?: unknown) => Promise<ApiResult> {
  const { config, repos, memory } = deps;
  const now = deps.now ?? (() => new Date());

  async function status(): Promise<unknown> {
    let pet: unknown = null;
    if (deps.host.name !== 'console') {
      try {
        pet = { reachable: true, work: await deps.host.workStatus() };
      } catch {
        pet = { reachable: false, work: null };
      }
    }
    const schedule = deps.schedule?.();
    const core = await memory.core.get();
    return {
      stage: config.stage,
      petId: config.pet.id,
      pet,
      llm: { provider: config.llm.provider, model: config.llm.model || null, tools: config.llm.tools },
      memory: {
        enabled: config.memory.enabled,
        facts: (await allFacts(memory, { open: true })).length,
        coreAt: core?.text.trim() ? core.at : null,
      },
      channel: repos.kv.get('channel-base') !== null,
      mcpServers: Object.keys(config.mcpServers),
      nextWhisper: schedule ? schedule.nextWhisper : null,
      lastTalk: schedule && schedule.lastTalk > 0 ? schedule.lastTalk : null,
      alarms: repos.schedule.list().length,
      contacts: repos.contacts.list().length,
    };
  }

  async function memoryView(): Promise<unknown> {
    const [core, facts, rules] = await Promise.all([
      memory.core.get(),
      allFacts(memory, { open: true }),
      memory.procedures.list({ active: true }),
    ]);
    return {
      enabled: config.memory.enabled,
      core: core?.text.trim() ? { text: core.text, at: core.at } : null,
      facts: facts
        .toSorted((a, b) => a.validFrom - b.validFrom)
        .map((fact) => ({
          id: fact.id,
          topic: fact.topic ?? null,
          text: fact.text,
          validFrom: fact.validFrom,
          recalls: fact.recalls.length,
        })),
      rules: rules.map((rule) => ({
        id: rule.id,
        topic: rule.topic ?? null,
        when: rule.when,
        do: rule.do,
        confirmations: rule.confirmations,
      })),
    };
  }

  async function setCore(body: unknown): Promise<unknown> {
    const value = text(body, 'text');
    if (value === undefined) throw new RequestError('画像要是一段文字');
    const trimmed = value.trim();
    if (trimmed.length > CORE_MAX) throw new RequestError(`画像太长了，最多 ${CORE_MAX} 字`);
    const at = now().getTime();
    await memory.core.set(trimmed, at);
    repos.activity.record({ type: 'memory-core-edit', length: trimmed.length });
    return { text: trimmed, at };
  }

  async function forgetFact(id: string): Promise<unknown> {
    if ((await memory.facts.forget([id])) === 0) throw new RequestError(`没有这条事实：${id}`, 404);
    repos.activity.record({ type: 'memory-forget', id });
    return { id };
  }

  async function retireRule(id: string): Promise<unknown> {
    const rule = (await memory.procedures.list({ active: true })).find((item) => item.id === id);
    if (!rule) throw new RequestError(`没有这条程序：${id}`, 404);
    // ctx 的 MemoryStore 没有删程序的方法，只能退役：不再交给模型，记录还在
    await memory.procedures.retire(id, now().getTime());
    repos.activity.record({ type: 'memory-retire', id });
    return { id };
  }

  async function recent(query: URLSearchParams): Promise<unknown> {
    const limit = limitOf(query, 40, 200);
    // entries 按写入顺序返回；导入的桌宠对话 at 在过去，按 (at, seq) 排回它们的位置
    return (await deps.context.entries({ last: 500 }))
      .toSorted(compareEntries)
      .map(contextItem)
      .filter((item) => item !== null)
      .slice(-limit);
  }

  function addAlarm(body: unknown): unknown {
    const weekday = field(body, 'weekday');
    try {
      return addSchedule(
        repos,
        {
          title: text(body, 'title'),
          time: text(body, 'time'),
          date: text(body, 'date') ?? null,
          repeat: text(body, 'repeat') || null,
          weekday: typeof weekday === 'number' ? weekday : undefined,
          kind: text(body, 'kind') || 'alarm',
        },
        now(),
      );
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  function newContact(body: unknown): unknown {
    try {
      return addContact(repos, { name: text(body, 'name'), yoyo: text(body, 'yoyo'), note: text(body, 'note') }, now());
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  return async (method, path, body) => {
    const url = new URL(path, 'http://yoyo.local');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${method} /${parts.join('/')}`;
    const id = parts.at(-1) ?? '';
    try {
      if (route === 'GET /api/status') return ok(await status());
      if (route === 'GET /api/context') return ok(await recent(url.searchParams));
      if (route === 'GET /api/activity') return ok(repos.activity.list(limitOf(url.searchParams, 50, 500)));
      if (route === 'GET /api/memory') return ok(await memoryView());
      if (route === 'PUT /api/memory/core') return ok(await setCore(body));
      if (method === 'DELETE' && parts.length === 4 && parts[1] === 'memory' && parts[2] === 'facts') {
        return ok(await forgetFact(id));
      }
      if (method === 'DELETE' && parts.length === 4 && parts[1] === 'memory' && parts[2] === 'rules') {
        return ok(await retireRule(id));
      }
      if (route === 'GET /api/alarms') return ok(repos.schedule.list());
      if (route === 'POST /api/alarms') return ok(addAlarm(body));
      if (method === 'DELETE' && parts.length === 3 && parts[1] === 'alarms') {
        return ok(removed(removeSchedule(repos, id), '条日程'));
      }
      if (route === 'GET /api/contacts') return ok(repos.contacts.list());
      if (route === 'POST /api/contacts') return ok(newContact(body));
      if (method === 'DELETE' && parts.length === 3 && parts[1] === 'contacts') {
        return ok(removed(removeContact(repos, id), '个联系人'));
      }
      if (route === 'GET /api/config')
        return ok({ file: deps.paths.configFile, ...readSettings(deps.paths.configFile) });
      if (route === 'PUT /api/config') {
        const value = text(body, 'text');
        if (value === undefined) throw new RequestError('整份配置要是一段文字');
        saveText(deps.paths.configFile, value, text(body, 'version'));
        repos.activity.record({ type: 'config-edit' });
        // 常驻进程盯着 config.json，一两秒内自己换上
        return ok({ saved: true });
      }
      if (route === 'PATCH /api/config') {
        const switches = field(body, 'switches');
        if (typeof switches !== 'object' || switches === null) throw new RequestError('要给 switches');
        saveSwitches(deps.paths.configFile, switches as Record<string, unknown>);
        repos.activity.record({ type: 'config-switch', text: Object.keys(switches).join(' ') });
        return ok({ saved: true });
      }
      if (route === 'POST /api/actions/whisper' || route === 'POST /api/actions/listen') {
        // 和右键菜单一样交给常驻进程的收件箱，下一拍做
        enqueue(deps.paths.inboxFile, id === 'listen' ? 'listen' : 'whisper');
        return ok({ queued: id });
      }
      return { status: 404, body: { error: '没有这个接口' } };
    } catch (error) {
      if (error instanceof RequestError) return { status: error.status, body: { error: error.message } };
      if (error instanceof SettingsError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  };
}
