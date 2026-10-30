/**
 * 管理页的接口：只做主人在命令行里也能做的事（看状态、上下文和记录，管记忆、日程和联系人，让 yoyo 说一句或听一句），
 * 用的也是同一套函数。HTTP 和安全检查在 `server.ts`。
 */
import { compareEntries, textOf, type Context, type Entry, type MemoryStore } from '@modelctx-ai/ctx';
import { MEMORY_DEFAULTS } from '@modelctx-ai/ctx-memory';

import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import { APPROVAL_EVENT, TASK_EVENT, taskSession, taskSteps } from '../brain/context.ts';
import { ApprovalError, decideApproval } from '../features/approvals/approvals.ts';
import { artifactView, removeArtifact } from '../features/tasks/artifacts.ts';
import type { AgentProfile } from '../features/tasks/agents.ts';
import { TaskError, answerTask, cancelAgentTask, createAgentTask, isOpen, progress } from '../features/tasks/tasks.ts';
import { paceNote, type PaceDecision, type PaceOptions } from '../kernel/pace.ts';
import type { AgentTask, Approval, Artifact } from '../kernel/types.ts';
import type { Paths } from '../app/paths.ts';
import { allFacts } from '../brain/memory.ts';
import { addSchedule, removeSchedule, updateSchedule } from '../features/alarms/schedule.ts';
import { addContact, removeContact } from '../features/contacts/contacts.ts';
import type { ArtifactFiles, PetHost, Repos } from '../ports/index.ts';
import { enqueue } from '../runtime/inbox.ts';
import { SettingsError, readSettings, saveFields, saveSwitches, saveText } from './settings.ts';

export interface WebDeps {
  readonly config: Config;
  readonly paths: Pick<Paths, 'inboxFile' | 'configFile'>;
  readonly repos: Repos;
  /** 主线程的上下文；`store` 用来读子任务各自的会话。 */
  readonly context: Pick<Context, 'entries' | 'store'>;
  readonly memory: MemoryStore;
  readonly host: Pick<PetHost, 'name' | 'workStatus'>;
  /** 编排器的排期：下一句碎碎念、最近一次说话。常驻进程里才有。 */
  readonly schedule?: () => {
    readonly nextWhisper: number;
    readonly lastTalk: number;
    /** 最近一次说完以后，下一句的间隔是怎么定的。 */
    readonly lastPace?: PaceDecision | null;
  };
  /**
   * 工作台里和 yoyo 聊一句，返回整段回复。常驻进程里才有。给了 `onDelta`，模型每吐一小段就交一次，
   * 流式接口用它；返回的整段回复才是记进日志的。
   */
  readonly talk?: (text: string, signal?: AbortSignal, onDelta?: (text: string) => void) => Promise<string>;
  /** 子 agent 的类型（内置的加上 `~/.yoyo/agents`）；子任务没打开时是空的，不给也一样：工作台不能派。 */
  readonly agents?: readonly AgentProfile[];
  /** 子任务过程的流多久看一眼有没有新的，毫秒，缺省 1000。 */
  readonly pollMs?: number;
  /** 子任务交付物的文件；不给就看不了、删不了原文。 */
  readonly files?: ArtifactFiles;
  /** 工作台里批准了一件事：常驻进程马上照做，不等下一次轮到。 */
  readonly onApproved?: () => void;
  /** 在访达里选中一个文件。只有 macOS 有。 */
  readonly reveal?: (path: string) => void;
  /** 是不是在 yoyo.app 的窗口里：下载换成在访达里显示。 */
  readonly app?: boolean;
  readonly now?: () => Date;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  /** 有这个就原样回文件，不回 JSON。 */
  readonly file?: ApiFile;
  /** 有这个就回 SSE：`emit` 推一个事件，连接断了 `signal` 就中止；函数返回时流收尾。 */
  readonly stream?: (emit: StreamEmit, signal: AbortSignal) => Promise<void>;
}

export type StreamEmit = (event: string, data: unknown) => void;

export interface ApiFile {
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly name: string;
  /** 工作台里直接看（文本、图片）还是只给下载。 */
  readonly inline: boolean;
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
/** 工作台里一句话最长多少字。 */
const TALK_MAX = 4000;
/** 子任务的过程最多给最近这么多步。 */
const STEPS_MAX = 300;
/** 对话里翻一页最多多少条。 */
const CONTEXT_MAX = 200;
/** 取最近的对话时先读最后这么多条日志；这里面能显示的不够一页才整段读。 */
const WINDOW = 500;

/** 交付物：加上工作台怎么给人看。 */
function artifactSummary(artifact: Artifact): unknown {
  return { ...artifact, view: artifactView(artifact.type) };
}

/** 列表里的一项：不带目标和结果全文。 */
function taskSummary(task: AgentTask): unknown {
  const { id, title, agent, state, origin, createdAt, finishedAt } = task;
  return { id, title, agent, state, origin, createdAt, finishedAt, progress: progress(task) };
}

/** 列表里的一项：不带参数和结果全文（写的内容可以有几 MB），展开时另取。 */
function approvalSummary(approval: Approval): unknown {
  const { id, tool, summary, task, state, createdAt, decidedAt, note } = approval;
  return { id, tool, summary, task, state, createdAt, decidedAt, note, done: approval.result !== null };
}

/** 一条请求的全部：加上完整参数和做完以后的结果。 */
function approvalView(approval: Approval): unknown {
  let input: unknown = approval.input;
  try {
    input = JSON.parse(approval.input);
  } catch {
    // 不是 JSON 就原样给
  }
  return { ...(approvalSummary(approval) as object), input, result: approval.result };
}

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

/** 等一会儿，`signal` 中止了就马上醒。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 删的东西没找到就回 404。 */
function removed<T>(value: T | null, what: string): T {
  if (value === null) throw new RequestError(`没有这${what}`, 404);
  return value;
}

export interface ContextItem {
  readonly at: number;
  /** 日志里的序号：和 `at` 一起是翻页的游标（`before=<at>:<seq>`）。 */
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  /** 从哪来的：`dsh-pet` 是桌宠右键对话，`workbench` 是工作台，没有是语音和自己说的。 */
  readonly via?: string;
  /** `task` 那条是哪个子任务、结束时的状态；`approval` 那条是哪条批准请求、结论是什么。 */
  readonly task?: number;
  readonly approval?: number;
  readonly state?: string;
}

/** 上下文的一条，给页面看：消息按角色，碎碎念、摘要单列。别的条目不列。 */
export function contextItem(entry: Entry): ContextItem | null {
  if (entry.type === 'message') {
    const body = textOf(entry.message);
    if (!body) return null;
    return {
      at: entry.at,
      seq: entry.seq,
      kind: entry.message.role,
      text: body,
      ...(entry.source ? { via: entry.source } : {}),
    };
  }
  if (entry.type === 'event' && entry.kind === 'whisper' && entry.text) {
    return { at: entry.at, seq: entry.seq, kind: 'whisper', text: entry.text };
  }
  if (entry.type === 'summary') return { at: entry.at, seq: entry.seq, kind: 'summary', text: entry.text };
  if (entry.type === 'event' && entry.kind === APPROVAL_EVENT && entry.text) {
    const meta = entry.meta ?? {};
    return {
      at: entry.at,
      seq: entry.seq,
      kind: 'approval',
      text: entry.text,
      ...(typeof meta['id'] === 'number' ? { approval: meta['id'] } : {}),
      ...(typeof meta['state'] === 'string' ? { state: meta['state'] } : {}),
    };
  }
  if (entry.type === 'event' && entry.kind === TASK_EVENT && entry.text) {
    const meta = entry.meta ?? {};
    return {
      at: entry.at,
      seq: entry.seq,
      kind: 'task',
      text: entry.text,
      ...(typeof meta['id'] === 'number' ? { task: meta['id'] } : {}),
      ...(typeof meta['state'] === 'string' ? { state: meta['state'] } : {}),
    };
  }
  return null;
}

/** 下一句的间隔是怎么定的，给页面看：来源、隔多少秒、挑的档和把握或退回的原因，再加一句短的说明。 */
export function paceView(pace: PaceDecision, options: PaceOptions): Record<string, unknown> {
  const base = { source: pace.source, sec: Math.round(pace.ms / 1000), note: paceNote(pace, options) };
  if (pace.source === 'fixed') return base;
  if (pace.source === 'decided') return { ...base, option: pace.option, confidence: pace.confidence };
  return { ...base, reason: pace.reason };
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
      lastPace: schedule?.lastPace ? paceView(schedule.lastPace, config.pace.options) : null,
      lastTalk: schedule && schedule.lastTalk > 0 ? schedule.lastTalk : null,
      alarms: repos.schedule.list().length,
      contacts: repos.contacts.list().length,
      approvals: repos.approvals.list({ states: ['pending'], limit: 200 }).length,
      app: deps.app ?? false,
      reveal: deps.reveal !== undefined,
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
        // 确认够了才交给模型，和命令行的 memory rules 一样
        effective: rule.confirmations >= MEMORY_DEFAULTS.confirmations,
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

  /**
   * 对话的一页：按 `(at, seq)` 排好，取最后 `limit` 条能显示的。给了 `before`（`<at>:<seq>`，页上最早那条的游标）
   * 就只看排在它前面的，往前翻用；不够 `limit` 条就是翻到头了。
   */
  async function recent(query: URLSearchParams): Promise<unknown> {
    const limit = limitOf(query, 40, CONTEXT_MAX);
    const raw = query.get('before');
    const cursor = raw === null ? null : /^(-?\d+):(\d+)$/.exec(raw);
    if (raw !== null && !cursor) throw new RequestError('before 要写成 <at>:<seq>');
    const before = cursor ? { at: Number(cursor[1]), seq: Number(cursor[2]) } : null;
    const page = (entries: readonly Entry[]): ContextItem[] =>
      entries
        .filter((entry) => before === null || compareEntries(entry, before) < 0)
        .toSorted(compareEntries)
        .map(contextItem)
        .filter((item) => item !== null)
        .slice(-limit);
    // entries 按写入顺序返回；导入的桌宠对话 at 在过去，按 (at, seq) 排回它们的位置。
    // 最新的一页每几秒就取一次，只读日志末尾；往前翻、或者末尾里能显示的不够一页，才整段读
    if (before === null) {
      const tail = await deps.context.entries({ last: WINDOW });
      const items = page(tail);
      if (items.length >= limit || tail.length < WINDOW) return items;
    }
    return page(await deps.context.entries());
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

  /** 改一条日程：正文里写了的项才改，类型不对的回 400；没有这条回 404。 */
  function editAlarm(id: string, body: unknown): unknown {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RequestError('要给要改的项');
    // 项名、值的类型（带 ? 的可以是 null）
    const types = {
      title: 'string',
      time: 'string',
      kind: 'string',
      date: 'string?',
      repeat: 'string?',
      weekday: 'number?',
      enabled: 'boolean',
    } as const;
    const names = { string: '要是一段文字', number: '要是一个数', boolean: '只能是 true 或 false' };
    const patch: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(types)) {
      const value = field(body, name);
      if (value === undefined) continue;
      const base = type.replace('?', '') as keyof typeof names;
      if (value === null && type.endsWith('?')) patch[name] = null;
      else if (typeof value === base) patch[name] = value;
      else throw new RequestError(`${name} ${names[base]}`);
    }
    try {
      return removed(updateSchedule(repos, id, patch), '条日程');
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 工作台里说的这句：去掉首尾空白，空的、太长的、没有常驻进程的都在开始回之前就拒绝。 */
  function said(body: unknown): { readonly said: string; readonly talk: NonNullable<WebDeps['talk']> } {
    if (!deps.talk) throw new RequestError('常驻进程里才能聊', 503);
    const value = text(body, 'text')?.trim();
    if (!value) throw new RequestError('要说点什么');
    if (value.length > TALK_MAX) throw new RequestError(`太长了，最多 ${TALK_MAX} 字`);
    return { said: value, talk: deps.talk };
  }

  async function talk(body: unknown): Promise<unknown> {
    const ask = said(body);
    try {
      return { reply: await ask.talk(ask.said) };
    } catch (error) {
      throw new RequestError(`yoyo 没回上来：${errorText(error)}`, 502);
    }
  }

  /**
   * 流式聊一句：`delta` 是模型刚吐的一小段，`done` 是整段回复（和 `POST /api/chat` 交回的、记进日志的是同一份），
   * 没回上来是 `error`。连接断了也让这一轮跑完、照常记进日志：刷新页面不该丢一句话。
   */
  function talkStream(body: unknown): ApiResult {
    const ask = said(body);
    return {
      status: 200,
      body: null,
      stream: async (emit) => {
        try {
          const reply = await ask.talk(ask.said, undefined, (delta) => emit('delta', { text: delta }));
          emit('done', { reply });
        } catch (error) {
          emit('error', { error: `yoyo 没回上来：${errorText(error)}` });
        }
      },
    };
  }

  async function taskView(taskId: number): Promise<unknown> {
    const task = Number.isInteger(taskId) ? repos.agentTasks.get(taskId) : null;
    if (!task) throw new RequestError(`没有子任务 #${taskId}`, 404);
    const steps = taskSteps(await deps.context.store.list(taskSession(task.id)));
    const approvals = repos.approvals.list({ task: task.id, limit: 20 }).map(approvalSummary);
    return { ...task, progress: progress(task), steps: steps.slice(-STEPS_MAX), approvals };
  }

  /** 一个子任务现在的样子有没有变：状态、过程多了一步、批准请求有了结论、交了新文件，任何一样都算。 */
  async function taskStamp(task: AgentTask): Promise<string> {
    const [last] = await deps.context.store.list(taskSession(task.id), { last: 1 });
    const approvals = repos.approvals.list({ task: task.id, limit: 20 });
    const artifacts = repos.artifacts.list({ task: task.id });
    return [
      task.updatedAt,
      last?.seq ?? 0,
      approvals.map((item) => `${item.id}${item.state}${item.result === null ? 0 : 1}`).join(),
      artifacts.map((item) => item.id).join(),
    ].join(':');
  }

  /**
   * 一个子任务的过程，有新的就推：`task` 是整份详情（和 `GET /api/tasks/:id` 一样）加交付物，开头先推一次；
   * 子任务结束了推完最后一份再推 `end`。过程记在会话存储里，没有现成的通知，所以隔 `pollMs` 看一眼，
   * 变了才推：省了页面自己每 4 秒整份重取。
   */
  function taskEvents(taskId: number): ApiResult {
    if (!Number.isInteger(taskId) || !repos.agentTasks.get(taskId))
      throw new RequestError(`没有子任务 #${taskId}`, 404);
    const pollMs = deps.pollMs ?? 1000;
    return {
      status: 200,
      body: null,
      stream: async (emit, signal) => {
        let seen = '';
        while (!signal.aborted) {
          const task = repos.agentTasks.get(taskId);
          if (!task) return;
          const stamp = await taskStamp(task);
          if (stamp !== seen) {
            seen = stamp;
            emit('task', {
              task: await taskView(taskId),
              artifacts: repos.artifacts.list({ task: taskId }).map(artifactSummary),
            });
            if (!isOpen(task)) return emit('end', {});
          }
          await sleep(pollMs, signal);
        }
      },
    };
  }

  /** 子 agent 的类型：名字和什么时候用。 */
  function agentList(): unknown {
    return (deps.agents ?? []).map(({ name, description }) => ({ name, description }));
  }

  /** 工作台里派一个子任务：规则和类型校验同主线程（`createAgentTask`），来源记 `web`。 */
  function newTask(body: unknown): unknown {
    const profiles = deps.agents ?? [];
    if (profiles.length === 0) throw new RequestError('子任务没打开：config.json 里把 tasks.enabled 设成 true', 409);
    const criteria = field(body, 'criteria');
    try {
      const task = createAgentTask(
        repos,
        {
          title: field(body, 'title'),
          goal: field(body, 'goal'),
          // 页面上一行一条；接口也收整段文字，按行拆
          criteria: typeof criteria === 'string' ? criteria.split(/\r?\n/) : criteria,
          agent: field(body, 'agent'),
          origin: 'web',
        },
        now(),
        profiles.map((profile) => profile.name),
      );
      return taskSummary(task);
    } catch (error) {
      if (error instanceof TaskError) throw new RequestError(error.message);
      throw error;
    }
  }

  function approvalOf(id: string): Approval {
    const approval = repos.approvals.get(Number(id));
    if (!approval) throw new RequestError(`没有批准请求 #${id}`, 404);
    return approval;
  }

  /** 批准或拒绝：只对等批准的有效，点第二遍报 409。 */
  function decide(id: string, verdict: 'approved' | 'denied'): unknown {
    approvalOf(id);
    try {
      const decided = decideApproval(repos, Number(id), verdict, now(), 'web');
      if (verdict === 'approved') deps.onApproved?.();
      return approvalSummary(decided);
    } catch (error) {
      if (error instanceof ApprovalError) throw new RequestError(error.message, 409);
      throw error;
    }
  }

  function artifactOf(id: string): Artifact {
    const artifact = repos.artifacts.get(Number(id));
    if (!artifact) throw new RequestError(`没有交付物 ${id}`, 404);
    return artifact;
  }

  function artifactFile(id: string): ApiResult {
    const artifact = artifactOf(id);
    const bytes = deps.files?.read(artifact.task, artifact.name);
    if (!bytes) throw new RequestError(`交付物 ${artifact.name} 的文件不在了`, 404);
    const inline = artifactView(artifact.type) !== 'file';
    return { status: 200, body: null, file: { bytes, type: artifact.type, name: artifact.name, inline } };
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
      if (route === 'GET /api/activity') {
        // types=a,b 只看这几种；before=<ISO 时间> 只看那以前的：往前翻对话时取更早的小卡片
        const types = url.searchParams.get('types');
        const before = url.searchParams.get('before');
        const filter = {
          ...(types ? { types: types.split(',').filter(Boolean) } : {}),
          ...(before ? { before } : {}),
        };
        return ok(repos.activity.list(limitOf(url.searchParams, 50, 500), filter));
      }
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
      if (method === 'PATCH' && parts.length === 3 && parts[1] === 'alarms') return ok(editAlarm(id, body));
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
      if (route === 'PATCH /api/config/fields') {
        const fields = field(body, 'fields');
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields))
          throw new RequestError('要给 fields');
        saveFields(deps.paths.configFile, fields as Record<string, unknown>, text(body, 'version'));
        // 行为记录只写改了哪几项，不写值（里面有密钥）
        repos.activity.record({ type: 'config-fields', text: Object.keys(fields).join(' ') });
        return ok({ saved: true });
      }
      if (route === 'POST /api/chat') return ok(await talk(body));
      if (route === 'POST /api/chat/stream') return talkStream(body);
      if (route === 'GET /api/agents') return ok(agentList());
      if (route === 'GET /api/tasks') return ok(repos.agentTasks.list({ limit: 50 }).map(taskSummary));
      if (route === 'POST /api/tasks') return ok(newTask(body));
      if (method === 'GET' && parts.length === 4 && parts[1] === 'tasks' && parts[3] === 'events') {
        return taskEvents(Number(parts[2]));
      }
      if (method === 'GET' && parts.length === 3 && parts[1] === 'tasks') return ok(await taskView(Number(id)));
      if (method === 'POST' && parts.length === 4 && parts[1] === 'tasks' && parts[3] === 'cancel') {
        try {
          return ok(taskSummary(cancelAgentTask(repos, Number(parts[2]), now())));
        } catch (error) {
          if (error instanceof TaskError) throw new RequestError(error.message, 409);
          throw error;
        }
      }
      if (method === 'POST' && parts.length === 4 && parts[1] === 'tasks' && parts[3] === 'answer') {
        const answer = text(body, 'answer');
        if (answer === undefined) throw new RequestError('要给 answer，回答要是一段文字');
        try {
          return ok(taskSummary(answerTask(repos, Number(parts[2]), answer, now())));
        } catch (error) {
          if (error instanceof TaskError) throw new RequestError(error.message, 409);
          throw error;
        }
      }
      if (route === 'GET /api/approvals') {
        // 等批准的都列，再带上最近处理过的
        const pending = repos.approvals.list({ states: ['pending'], limit: 200 });
        const settled = repos.approvals.list({ limit: 40 }).filter((item) => item.state !== 'pending');
        return ok([...pending, ...settled].map(approvalSummary));
      }
      if (method === 'GET' && parts.length === 3 && parts[1] === 'approvals') return ok(approvalView(approvalOf(id)));
      if (method === 'POST' && parts.length === 4 && parts[1] === 'approvals' && parts[3] === 'approve') {
        return ok(decide(parts[2] ?? '', 'approved'));
      }
      if (method === 'POST' && parts.length === 4 && parts[1] === 'approvals' && parts[3] === 'deny') {
        return ok(decide(parts[2] ?? '', 'denied'));
      }
      if (route === 'GET /api/artifacts') {
        const task = url.searchParams.get('task');
        const options = task ? { task: Number(task) } : {};
        return ok(repos.artifacts.list(options).map(artifactSummary));
      }
      if (method === 'GET' && parts.length === 3 && parts[1] === 'artifacts') return artifactFile(id);
      if (method === 'DELETE' && parts.length === 3 && parts[1] === 'artifacts') {
        if (!deps.files) throw new RequestError('常驻进程里才能删', 503);
        return ok(removed(removeArtifact(repos, deps.files, Number(id)), '个交付物'));
      }
      if (method === 'POST' && parts.length === 4 && parts[1] === 'artifacts' && parts[3] === 'reveal') {
        const artifact = artifactOf(parts[2] ?? '');
        if (!deps.reveal || !deps.files) throw new RequestError('只有 macOS 上能在访达里显示', 503);
        deps.reveal(deps.files.path(artifact.task, artifact.name));
        return ok({ revealed: artifact.id });
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
