import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  compareEntries,
  textOf,
  type ConsolidateReport,
  type Entry,
  type MemoryFact,
  type Note,
  type Procedure,
} from '@modelctx-ai/ctx';
import { MEMORY_DEFAULTS } from '@modelctx-ai/ctx-memory';

import { assertDirectorReady, llmReady, loadConfig, parseConfig, type Config } from '../app/config.ts';
import {
  createApp,
  createPetHost,
  createPlatformClipboard,
  createPlatformOpener,
  type App,
  type AppOverrides,
} from '../app/container.ts';
import { consoleLogger, errorText } from '../app/log.ts';
import { loadAgentProfiles } from '../app/agents.ts';
import type { Paths } from '../app/paths.ts';
import {
  checkUpdate,
  createUpdateSystem,
  installUpdate,
  installedVersion,
  stepProgress,
  UPDATE_REPO,
  type UpdateSystem,
} from '../app/update.ts';
import { createYoyoContext, taskSession, taskSteps, type TaskStep } from '../brain/context.ts';
import { allFacts, createYoyoMemory, evidenceOf, memorySessions, openMemoryStore, ungated } from '../brain/memory.ts';
import { createLanguageModel } from '../brain/model.ts';
import { addSchedule, pauseSchedule, resumeSchedule, updateSchedule } from '../features/alarms/schedule.ts';
import {
  ApprovalError,
  STATE_LABELS as APPROVAL_LABELS,
  approvalDetail,
  approvalRow,
  decideApproval,
} from '../features/approvals/approvals.ts';
import { addContact } from '../features/contacts/contacts.ts';
import type { AgentProfile } from '../features/tasks/agents.ts';
import { artifactRow, artifactView, removeArtifact } from '../features/tasks/artifacts.ts';
import {
  STATE_LABELS,
  TaskError,
  answerTask,
  cancelAgentTask,
  createAgentTask,
  taskDetail,
  taskRow,
} from '../features/tasks/tasks.ts';
import { localDateKey } from '../kernel/time.ts';
import type { AgentTaskState, Approval, ApprovalState, Artifact, InboxRequest } from '../kernel/types.ts';
import type { ArtifactFiles, Clipboard, Logger, PetHost, Repos, UrlOpener } from '../ports/index.ts';
import { compactContext } from '../runtime/compact.ts';
import { directorAlive, enqueue } from '../runtime/inbox.ts';
import { createArtifactFiles } from '../storage/artifacts.ts';
import { openDatabase } from '../storage/db.ts';
import { createRepos } from '../storage/repos.ts';
import { saveSwitches } from '../web/settings.ts';
import { flagText, type Domain } from './registry.ts';
import { searchKinds, searchRows, searchTerms } from './search.ts';

/** 命令用到的东西都按需才做：只读写本地库的命令不读配置，也不碰桌宠和语音。 */
export interface CommandEnv {
  readonly paths: Paths;
  readonly logger: Logger;
  /** 输出一行结果。 */
  out(text: string): void;
  now(): Date;
  db(): DatabaseSync;
  repos(): Repos;
  /** 读 config.json，没有就报错。 */
  config(): Config;
  /** 有 config.json 就读，没有就用缺省值。 */
  settings(): Config;
  clipboard(): Clipboard;
  opener(): UrlOpener;
  host(): PetHost;
  /** 和导演同一套组装。用完要 close。 */
  app(): Promise<App>;
  /** 子任务交付物的文件。 */
  files(): ArtifactFiles;
  /** 自我更新要碰的网络、命令和进程。 */
  updater(): UpdateSystem;
  /** 装着的版本：安装包里 `lib/VERSION` 写的，从源码跑时是 null。 */
  installed(): string | null;
}

export interface CommandEnvOptions {
  readonly out?: (text: string) => void;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** 测试用：换掉组装里的服务。 */
  readonly overrides?: AppOverrides;
  /** 测试用：换掉自我更新碰的外部东西。 */
  readonly updater?: UpdateSystem;
  /** 测试用：当成装着哪个版本。 */
  readonly installed?: string | null;
}

export function createCommandEnv(paths: Paths, options: CommandEnvOptions = {}): CommandEnv {
  const logger = options.logger ?? consoleLogger;
  const overrides = options.overrides ?? {};
  let db: DatabaseSync | undefined;
  let repos: Repos | undefined;
  let config: Config | undefined;
  const env: CommandEnv = {
    paths,
    logger,
    out: options.out ?? ((text) => console.log(text)),
    now: options.now ?? (() => new Date()),
    db: () => (db ??= overrides.db ?? openDatabase(paths.dbFile)),
    repos: () => (repos ??= overrides.repos ?? createRepos(env.db())),
    config: () => (config ??= loadConfig(paths.configFile)),
    settings: () => (existsSync(paths.configFile) ? env.config() : parseConfig({})),
    clipboard: () => overrides.clipboard ?? createPlatformClipboard(),
    opener: () => overrides.opener ?? createPlatformOpener(),
    host: () => overrides.host ?? createPetHost(env.config(), logger),
    app: () => createApp(env.config(), paths, { logger, db: env.db(), repos: env.repos(), ...overrides }),
    files: () => overrides.artifactFiles ?? createArtifactFiles(paths.artifactsDir),
    updater: () => options.updater ?? createUpdateSystem(),
    installed: () => (options.installed !== undefined ? options.installed : installedVersion(paths.root)),
  };
  return env;
}

/** 管理页的地址（带令牌）；没开着就说清楚为什么。 */
function manager(env: CommandEnv): { readonly url: string } | { readonly problem: string } {
  if (!env.settings().web.enabled) return { problem: 'config.json 的 web.enabled 关着，没有管理页' };
  const url = env.repos().kv.get('web-url');
  if (!url || !directorAlive(env.paths.pidFile)) return { problem: '常驻进程没在跑，管理页跟着它开' };
  return { url };
}

const STEP_LABELS: Readonly<Record<TaskStep['kind'], string>> = {
  input: '收到',
  say: '说',
  call: '调用',
  result: '结果',
};

function agentProfiles(env: CommandEnv): AgentProfile[] {
  return loadAgentProfiles(env.paths.agentsDir, env.logger);
}

/** `--state` 写的状态，逗号分开；写错报出能写哪些。 */
function taskStates(value: string): AgentTaskState[] {
  const all = Object.keys(STATE_LABELS) as AgentTaskState[];
  const picked = value.split(',').map((item) => item.trim());
  const wrong = picked.filter((item) => !(all as string[]).includes(item));
  if (wrong.length > 0) throw new Error(`没有「${wrong.join('、')}」这种状态，有：${all.join('、')}`);
  return picked as AgentTaskState[];
}

function artifactOf(env: CommandEnv, args: readonly string[]): Artifact {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error('要给交付物编号，例如 yoyo artifact show 3');
  const item = env.repos().artifacts.get(id);
  if (!item) throw new Error(`没有交付物 ${id}`);
  return item;
}

/** `--state` 写的批准状态，逗号分开；写错报出能写哪些。 */
function approvalStates(value: string): ApprovalState[] {
  const all = Object.keys(APPROVAL_LABELS) as ApprovalState[];
  const picked = value.split(',').map((item) => item.trim());
  const wrong = picked.filter((item) => !(all as string[]).includes(item));
  if (wrong.length > 0) throw new Error(`没有「${wrong.join('、')}」这种状态，有：${all.join('、')}`);
  return picked as ApprovalState[];
}

function approvalOf(env: CommandEnv, args: readonly string[]): Approval {
  const id = Number((args[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new Error('要给批准请求的编号，例如 yoyo approval show 3');
  const item = env.repos().approvals.get(id);
  if (!item) throw new Error(`没有批准请求 #${id}`);
  return item;
}

function scheduleId(args: readonly string[]): string {
  const id = (args[0] ?? '').trim();
  if (!id) throw new Error('要给日程编号：yoyo alarm list 能看到');
  return id;
}

function taskId(args: readonly string[]): number {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error('要给子任务编号，例如 yoyo task show 3');
  return id;
}

/** 规则不让做的事报成一句话。 */
function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TaskError || error instanceof ApprovalError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

function updateRepo(): string {
  return process.env['YOYO_UPDATE_REPO'] || UPDATE_REPO;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}`;
}

/** 终端里的一行下载进度；不知道总大小就只说下了多少。 */
function downloadLine(done: number, total: number): string {
  if (total <= 0) return `已下载 ${megabytes(done)} MB`;
  return `下载 ${Math.min(100, Math.floor((done / total) * 100))}%（${megabytes(done)}/${megabytes(total)} MB）`;
}

/**
 * `yoyo update install --json`：一行一个 JSON 事件，给 app 外壳读。
 * `{"type":"step","text":…}` 做到哪一步；`{"type":"progress","done":…,"total":…}` 下载进度（字节，每 1% 一条，总大小不知道时 total 是 0）；
 * 最后是 `{"type":"done","updated":…,"message":…}` 或 `{"type":"error","message":…}`（出错时命令也以非 0 退出）。
 */
async function installJson(env: CommandEnv): Promise<void> {
  const emit = (event: Record<string, unknown>) => env.out(JSON.stringify(event));
  try {
    const system = env.updater();
    const check = await checkUpdate(env.installed(), system, updateRepo());
    if (!check.available) return emit({ type: 'done', updated: false, message: check.message });
    const { relaunch } = await installUpdate({
      check,
      paths: env.paths,
      system,
      out: (text) => emit({ type: 'step', text }),
      progress: stepProgress(1, (done, total) => emit({ type: 'progress', done, total })),
    });
    emit({
      type: 'done',
      updated: true,
      message: relaunch ? `换上 ${check.latest} 后重开 yoyo` : `${check.latest} 装好了`,
    });
  } catch (error) {
    emit({ type: 'error', message: errorText(error) });
    throw error;
  }
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function entryText(entry: Entry): string {
  return entry.type === 'message' ? textOf(entry.message) : '';
}

/** `context tail` 的一行：消息按角色，碎碎念记成 whisper。其余条目不列。 */
export function contextRow(entry: Entry): string | null {
  if (entry.type === 'message') {
    const text = textOf(entry.message);
    return text ? `${entry.message.role}\t${oneLine(text, 80)}` : null;
  }
  if (entry.type === 'event' && entry.kind === 'whisper' && entry.text) return `whisper\t${oneLine(entry.text, 80)}`;
  return null;
}

function day(at: number): string {
  return localDateKey(new Date(at));
}

/** `memory facts` 的一行：id、主题、一句话、从何时起、被召回几次。 */
export function factRow(fact: MemoryFact): string {
  return `${fact.id}\t${fact.topic ?? '-'}\t${oneLine(fact.text, 80)}\t${day(fact.validFrom)} 起\t召回 ${fact.recalls.length} 次`;
}

/** `memory rules` 的一行：id、主题、触发条件和动作、确认次数。确认够了才交给模型。 */
export function ruleRow(procedure: Procedure): string {
  const state = procedure.confirmations >= MEMORY_DEFAULTS.confirmations ? '生效' : '待确认';
  return `${procedure.id}\t${procedure.topic ?? '-'}\t${oneLine(procedure.when, 40)} → ${oneLine(procedure.do, 40)}\t确认 ${procedure.confirmations} 次\t${state}`;
}

/** 笔记的状态：门控没过的那段写下时就标成处理过（settledAt 等于 at）。 */
function noteState(note: Note): string {
  if (note.settledAt === undefined) return '待整理';
  return note.settledAt === note.at ? '不记' : '已整理';
}

/** `memory tail` 的一行：什么时候、哪段话、显著性、主题、类别、处理了没，加这段第一句话。 */
export function noteRow(note: Note, first: string | undefined): string {
  return [
    new Date(note.at).toISOString(),
    `${note.session}#${note.from}-${note.upTo}`,
    note.salience.toFixed(2),
    note.topic ?? '-',
    note.kind ?? '-',
    noteState(note),
    ...(first ? [oneLine(first, 40)] : []),
  ].join('\t');
}

export function consolidateText(report: ConsolidateReport): string {
  const { facts, procedures } = report;
  return (
    `整理了 ${report.notes} 条笔记：新增 ${facts.added} 条事实，并入 ${facts.merged}，取代 ${facts.superseded}，归档 ${facts.archived}；` +
    `程序新增 ${procedures.added}，确认 ${procedures.confirmed}；画像${report.core ? '重写了' : '没变'}`
  );
}

/** 导演在跑就经收件箱交给它的编排器；没在跑就当场组装一份，由编排器当场做。 */
async function handoff(env: CommandEnv, type: InboxRequest): Promise<void> {
  if (directorAlive(env.paths.pidFile)) {
    enqueue(env.paths.inboxFile, type);
    env.out(`已交给正在运行的 yoyo：${type}`);
    return;
  }
  assertDirectorReady(env.config());
  const app = await env.app();
  try {
    if (type === 'listen') await app.orchestrator.listen();
    else await app.orchestrator.whisper();
  } finally {
    await app.close();
  }
}

export function buildDomains(env: CommandEnv): Domain[] {
  return [
    {
      name: 'alarm',
      summary: '闹钟和周期性日程',
      detail:
        '到点后 15 分钟内说一次。repeat 可以是 daily、weekdays、weekly；edit 的 --repeat none 是改成一次性（要同时给 --date）。pause 暂停的日程到点不响，list 里标「暂停中」，resume 恢复。',
      verbs: [
        {
          name: 'list',
          summary: '列出日程',
          agent: true,
          run() {
            const items = env.repos().schedule.list();
            if (items.length === 0) return env.out('还没有日程');
            for (const item of items) {
              const line = `${item.kind}\t${item.time}\t${item.repeat || item.date}\t${item.title}\t${item.id}`;
              env.out(item.enabled ? line : `${line}\t暂停中`);
            }
          },
        },
        {
          name: 'add',
          summary: '新增闹钟或任务',
          flags: ['title', 'time', 'repeat', 'date', 'weekday', 'kind'],
          run(flags) {
            const weekday = flagText(flags, 'weekday');
            const item = addSchedule(
              env.repos(),
              {
                title: flagText(flags, 'title'),
                time: flagText(flags, 'time'),
                date: flagText(flags, 'date'),
                repeat: flagText(flags, 'repeat') || null,
                weekday: weekday === undefined ? undefined : Number(weekday),
                kind: flagText(flags, 'kind') || 'alarm',
              },
              env.now(),
            );
            env.out(`${item.kind}\t${item.time}\t${item.title}`);
          },
        },
        {
          name: 'edit',
          summary: '改一条日程：写哪项改哪项，其余不动',
          usage: '<编号>',
          flags: ['title', 'time', 'repeat', 'date', 'weekday', 'kind'],
          run(flags, args) {
            const weekday = flagText(flags, 'weekday');
            const repeat = flagText(flags, 'repeat');
            const patch = {
              title: flagText(flags, 'title'),
              time: flagText(flags, 'time'),
              date: flagText(flags, 'date'),
              repeat: repeat === undefined ? undefined : repeat === 'none' ? null : repeat,
              weekday: weekday === undefined ? undefined : Number(weekday),
              kind: flagText(flags, 'kind'),
            };
            const id = scheduleId(args);
            const item = updateSchedule(env.repos(), id, patch);
            if (!item) throw new Error(`没有这条日程：${id}`);
            env.out(`${item.kind}\t${item.time}\t${item.title}`);
          },
        },
        {
          name: 'pause',
          summary: '暂停一条日程：到点不响，留着',
          run(_flags, args) {
            const id = scheduleId(args);
            const item = pauseSchedule(env.repos(), id);
            if (!item) throw new Error(`没有这条日程：${id}`);
            env.out(`已暂停\t${item.title}\t${item.id}`);
          },
        },
        {
          name: 'resume',
          summary: '恢复暂停的日程',
          run(_flags, args) {
            const id = scheduleId(args);
            const item = resumeSchedule(env.repos(), id);
            if (!item) throw new Error(`没有这条日程：${id}`);
            env.out(`已恢复\t${item.title}\t${item.id}`);
          },
        },
      ],
    },
    {
      name: 'contact',
      aliases: ['contract'],
      summary: 'yoyo 联系人',
      detail: '现在只保存名字和对方的 yoyo 地址。以后用这个地址联系对方的 yoyo。',
      verbs: [
        {
          name: 'list',
          summary: '列出联系人',
          agent: true,
          run() {
            const items = env.repos().contacts.list();
            if (items.length === 0) return env.out('还没有联系人');
            for (const item of items) env.out(`${item.name}\t${item.yoyo}${item.note ? `\t${item.note}` : ''}`);
          },
        },
        {
          name: 'add',
          summary: '新增联系人',
          flags: ['name', 'yoyo', 'note'],
          run(flags) {
            const contact = addContact(
              env.repos(),
              { name: flagText(flags, 'name'), yoyo: flagText(flags, 'yoyo'), note: flagText(flags, 'note') },
              env.now(),
            );
            env.out(`${contact.name}\t${contact.yoyo}`);
          },
        },
      ],
    },
    {
      name: 'clip',
      summary: '粘贴板和复制历史',
      detail: 'get 读当前粘贴板。history 是 yoyo 自己记下的变化，不是系统的全部历史。',
      verbs: [
        {
          name: 'get',
          summary: '当前粘贴板',
          run() {
            const text = env.clipboard().read().trim();
            env.out(text ? text.slice(0, 500) : '粘贴板是空的');
          },
        },
        {
          name: 'history',
          summary: '最近复制过的内容',
          run() {
            const items = env.repos().clipboard.list();
            if (items.length === 0) return env.out('还没有复制记录');
            for (const item of items.slice(0, 20)) env.out(`${item.at}\t${oneLine(item.text, 80)}`);
          },
        },
      ],
    },
    {
      name: 'chat',
      summary: '桌宠右键对话用的模型',
      detail: 'sync 把 config.json 里的 llm 写进桌宠独立模式。自动碎碎念仍由 yoyo 发，不打开桌宠自己的周期碎碎念。',
      verbs: [
        {
          name: 'sync',
          summary: '把渠道接到桌宠对话',
          async run() {
            const config = env.config();
            const { kv } = env.repos();
            const baseUrl = kv.get('channel-base');
            const token = kv.get('channel-token');
            if (!baseUrl || !token || !directorAlive(env.paths.pidFile)) {
              env.out('导演没在跑，上下文代理还没起来');
              return;
            }
            if (!llmReady(config.llm)) throw new Error('config.json 的 llm 不完整');
            const saved = await env.host().bindChat({ baseUrl, model: config.llm.model, apiKey: token });
            env.out(`已接上 ${saved.model}`);
          },
        },
      ],
    },
    {
      name: 'context',
      summary: '完整对话上下文',
      detail:
        '连续碎碎念收成一条。用户和回复按原句保留；配了 context.compactAt 才压缩，较早的部分压成一条摘要。存在 ~/.yoyo/yoyo.db。',
      verbs: [
        {
          name: 'tail',
          summary: '最后几条原文',
          agent: true,
          async run() {
            const context = await createYoyoContext({ db: env.db(), petId: env.settings().pet.id });
            // entries 按写入顺序返回；导入的桌宠对话 at 在过去，展示前按 (at, seq) 排回它们的位置
            const rows = (await context.entries({ last: 500 }))
              .toSorted(compareEntries)
              .map(contextRow)
              .filter((row): row is string => row !== null);
            if (rows.length === 0) return env.out('还没有上下文');
            for (const row of rows.slice(-12)) env.out(row);
          },
        },
        {
          name: 'compact',
          summary: '现在就压缩较早的部分',
          async run() {
            const config = env.config();
            const model = createLanguageModel(config.llm);
            if (!model) return env.out('还没配好 llm，压缩要用模型');
            const context = await createYoyoContext({ db: env.db(), petId: config.pet.id, model, logger: env.logger });
            const done = await compactContext(context, { keep: config.context.keep, model });
            env.out(done ? `上下文压成摘要：约 ${done.before} → ${done.after} token` : '上下文还不长，不用压缩');
          },
        },
      ],
    },
    {
      name: 'memory',
      summary: '桌宠记住的事',
      detail:
        '只读写本地库，不用模型、不碰桌宠。记忆存在 ~/.yoyo/yoyo.db 的 memory_ 表；config.json 的 memory.enabled 打开以后，常驻进程才记。',
      verbs: [
        {
          name: 'core',
          summary: '画像和它的更新时间',
          agent: true,
          async run() {
            const core = await openMemoryStore(env.db()).core.get();
            if (!core?.text.trim()) return env.out('还没有画像');
            env.out(`更新于 ${new Date(core.at).toISOString()}`);
            env.out(core.text);
          },
        },
        {
          name: 'facts',
          summary: '仍然成立的事实',
          agent: true,
          flags: ['topic'],
          async run(flags) {
            const topic = flagText(flags, 'topic');
            const facts = await allFacts(openMemoryStore(env.db()), { open: true, ...(topic ? { topic } : {}) });
            if (facts.length === 0) return env.out(topic ? `主题 ${topic} 下还没有记住的事` : '还没有记住的事');
            for (const fact of facts.toSorted((a, b) => a.validFrom - b.validFrom)) env.out(factRow(fact));
          },
        },
        {
          name: 'history',
          summary: '一条事实的来源原文、取代了谁、被谁取代',
          agent: true,
          usage: '<id>',
          async run(_flags, args) {
            const [id] = args;
            if (!id) return env.out('要给事实的 id：yoyo memory history <id>');
            const facts = await allFacts(openMemoryStore(env.db()));
            const fact = facts.find((item) => item.id === id);
            if (!fact) return env.out(`没有这条事实：${id}`);
            const until = fact.validTo !== undefined ? `，到 ${day(fact.validTo)}` : '';
            const archived = fact.archivedAt !== undefined ? `，${day(fact.archivedAt)} 归档` : '';
            env.out(`${fact.id}\t${fact.topic ?? '-'}\t${fact.text}`);
            env.out(`成立：${day(fact.validFrom)} 起${until}${archived}`);
            for (const older of facts.filter((item) => item.supersededBy === fact.id)) {
              env.out(`取代了：${older.id}\t${oneLine(older.text, 80)}`);
            }
            const newer = fact.supersededBy ? facts.find((item) => item.id === fact.supersededBy) : undefined;
            if (newer) env.out(`被取代：${newer.id}\t${oneLine(newer.text, 80)}`);
            const context = await createYoyoContext({ db: env.db(), petId: env.settings().pet.id });
            // 和记忆读到的一样：天气和提醒不算原文
            const rows = (await evidenceOf(memorySessions(context.store), fact.sources))
              .map((entry) => {
                const row = contextRow(entry);
                return row ? `${entry.session}#${entry.seq}\t${row}` : null;
              })
              .filter((row): row is string => row !== null);
            env.out(rows.length > 0 ? '原文：' : '原文：日志里已经没有了');
            for (const row of rows) env.out(row);
          },
        },
        {
          name: 'rules',
          summary: '夜里从教训里归纳出的程序',
          agent: true,
          async run() {
            const rules = await openMemoryStore(env.db()).procedures.list({ active: true });
            if (rules.length === 0) return env.out('还没有程序');
            for (const rule of rules) env.out(ruleRow(rule));
          },
        },
        {
          name: 'tail',
          summary: '最近 12 条笔记',
          async run() {
            // NoteQuery 只能取最早的 N 条，最近的要全读出来再截
            const notes = (await openMemoryStore(env.db()).notes.list()).slice(-12);
            if (notes.length === 0) return env.out('还没有笔记');
            const context = await createYoyoContext({ db: env.db(), petId: env.settings().pet.id });
            const firsts = new Map<string, string>();
            for (const session of new Set(notes.map((note) => note.session))) {
              const from = Math.min(...notes.filter((note) => note.session === session).map((note) => note.from));
              const entries = await context.store.list(session, { after: from - 1, types: ['message'] });
              for (const note of notes.filter((item) => item.session === session)) {
                const entry = entries.find(
                  (item) => item.seq >= note.from && item.seq <= note.upTo && !ungated(item) && entryText(item),
                );
                if (entry) firsts.set(note.id, entryText(entry));
              }
            }
            for (const note of notes) env.out(noteRow(note, firsts.get(note.id)));
          },
        },
        {
          name: 'forget',
          summary: '真删除一条事实；程序改成退役',
          usage: '<id>',
          async run(_flags, args) {
            const [id] = args;
            if (!id) return env.out('要给事实或程序的 id：yoyo memory forget <id>');
            const store = openMemoryStore(env.db());
            if ((await store.facts.forget([id])) > 0) {
              env.repos().activity.record({ type: 'memory-forget', id });
              return env.out(`忘掉了 ${id}，下一次整理时画像跟着改`);
            }
            const procedure = (await store.procedures.list()).find((item) => item.id === id);
            if (!procedure) return env.out(`没有这条事实或程序：${id}`);
            // ctx 的 MemoryStore 没有删程序的方法，只能退役：不再交给模型，记录还在
            await store.procedures.retire(id, env.now().getTime());
            env.repos().activity.record({ type: 'memory-retire', id });
            env.out(`程序 ${id} 退役了，不再交给模型`);
          },
        },
        {
          name: 'consolidate',
          summary: '现在就整理一次',
          async run() {
            const settings = env.settings();
            const context = await createYoyoContext({ db: env.db(), petId: settings.pet.id });
            // 命令行不用模型：没有提取就不处理笔记，只做衰减归档和画像的缺省渲染。
            // 不给 logger：ctx 对此的英文告警和下面那行中文说的是一件事
            const { memory, store } = createYoyoMemory({
              store: openMemoryStore(env.db()),
              sessions: context.store,
              config: settings.memory,
            });
            const report = await memory.consolidate({ now: env.now().getTime() });
            env.repos().activity.record({ type: 'memory-consolidate', notes: report.notes, manual: true });
            env.out(consolidateText(report));
            const left = (await store.notes.list({ pending: true })).length;
            if (left > 0) env.out(`还有 ${left} 条笔记要用模型提取，留给常驻进程夜里整理`);
          },
        },
      ],
    },
    {
      name: 'meme',
      summary: '表情包套餐',
      detail: '没事干的时候会自己搜一套图。碎碎念大约四成会带上一张。天气和闹钟不带。',
      verbs: [
        {
          name: 'list',
          summary: '看现在这套图',
          run() {
            const pack = env.repos().memes.read();
            const items = pack?.items ?? [];
            if (!pack || items.length === 0) return env.out('还没有表情包');
            env.out(`${pack.fetchedAt}\t${items.length}张`);
            for (const item of items) env.out(item.url);
          },
        },
        {
          name: 'refresh',
          summary: '现在就去找一套',
          async run() {
            const app = await env.app();
            try {
              const pack = await app.director.refreshMemes(env.now(), { force: true });
              env.out(`${pack?.items.length ?? 0}张`);
            } finally {
              await app.close();
            }
          },
        },
      ],
    },
    {
      name: 'listen',
      summary: '马上听一句语音',
      detail: '导演在跑时交给它。没在跑就当场听。默认按键是 Control+Option+Y。',
      verbs: [{ name: 'now', summary: '现在就开始听', run: () => handoff(env, 'listen') }],
    },
    {
      name: 'whisper',
      summary: '马上说一句碎碎念',
      detail: '右键 yoyo 分组里的「碎碎念」也是这一条。宠物自带的那一项到不了这里。',
      verbs: [{ name: 'now', summary: '现在就说一句', run: () => handoff(env, 'whisper') }],
    },
    {
      name: 'task',
      aliases: ['tasks'],
      summary: '子任务：yoyo 派给后台子 agent 的事',
      detail:
        '平时只和 yoyo 说，要花时间、要好几步的事它派成子任务在后台做：先拆 todo、边做边标，验收标准逐条对上再把结果交回 yoyo。常驻进程在跑才会做，同时做几件看 tasks.concurrency（缺省 2），多的排队。',
      verbs: [
        {
          name: 'list',
          summary: '最近的子任务：编号、状态、todo 进度、标题',
          agent: true,
          flags: ['state'],
          run(flags) {
            const state = flagText(flags, 'state');
            const states = state ? taskStates(state) : undefined;
            const tasks = env.repos().agentTasks.list({ limit: 20, ...(states ? { states } : {}) });
            if (tasks.length === 0) return env.out(state ? `没有「${state}」的子任务` : '还没有子任务');
            for (const task of tasks) env.out(taskRow(task));
          },
        },
        {
          name: 'show',
          summary: '一个子任务的全部：目标、验收标准、todo、问题和回答、结果',
          agent: true,
          usage: '<编号>',
          run(_flags, args) {
            const task = env.repos().agentTasks.get(taskId(args));
            if (!task) throw new Error(`没有子任务 #${args[0]}`);
            env.out(
              taskDetail(
                task,
                env.repos().artifacts.list({ task: task.id }),
                env.repos().approvals.list({ task: task.id }).toReversed(),
              ),
            );
          },
        },
        {
          name: 'log',
          summary: '子 agent 一步步做了什么：收到的话、调的工具、工具回的',
          agent: true,
          usage: '<编号>',
          async run(_flags, args) {
            const id = taskId(args);
            if (!env.repos().agentTasks.get(id)) throw new Error(`没有子任务 #${id}`);
            const context = await createYoyoContext({ db: env.db(), petId: env.settings().pet.id });
            const steps = taskSteps(await context.store.list(taskSession(id)));
            if (steps.length === 0) return env.out('还没开始做');
            for (const step of steps) {
              const label = step.name ? `${STEP_LABELS[step.kind]} ${step.name}` : STEP_LABELS[step.kind];
              env.out(`${new Date(step.at).toISOString()}\t${label}\t${oneLine(step.text, 120)}`);
            }
          },
        },
        {
          name: 'add',
          summary: '自己派一个子任务（平时由 yoyo 派）',
          flags: ['title', 'goal', 'criteria', 'agent'],
          run(flags) {
            const criteria = (flagText(flags, 'criteria') ?? '').split(/[;；\n]/);
            const names = agentProfiles(env).map((profile) => profile.name);
            const input = {
              title: flagText(flags, 'title'),
              goal: flagText(flags, 'goal'),
              criteria,
              agent: flagText(flags, 'agent'),
              origin: 'cli',
            };
            const task = guard(() => createAgentTask(env.repos(), input, env.now(), names));
            env.out(`开了子任务 #${task.id}，交给 ${task.agent}，常驻进程在跑就会去做`);
          },
        },
        {
          name: 'agents',
          summary: '有哪些子 agent 类型：内置的，加上 ~/.yoyo/agents/*.md',
          agent: true,
          run() {
            for (const profile of agentProfiles(env)) {
              const tools = profile.tools ? profile.tools.join(', ') || '只有任务工具' : '全部工具';
              const from = profile.source === 'builtin' ? '内置' : profile.source;
              env.out(
                `${profile.name}\t${profile.description}\t${tools}${profile.model ? `\t${profile.model}` : ''}\t${from}`,
              );
            }
          },
        },
        {
          name: 'answer',
          summary: '回答在等回答的子任务（子 agent 做到一半问的问题），它排队接着做',
          usage: '<编号> <回答…>',
          run(_flags, args) {
            const id = taskId(args);
            const task = guard(() => answerTask(env.repos(), id, args.slice(1).join(' '), env.now()));
            env.out(`回答交给子任务 #${task.id} 了，常驻进程在跑就会接着做`);
          },
        },
        {
          name: 'cancel',
          summary: '取消还开着（排队、在做、等回答）的子任务',
          usage: '<编号>',
          run(_flags, args) {
            const task = guard(() => cancelAgentTask(env.repos(), taskId(args), env.now()));
            env.out(`取消了子任务 #${task.id}`);
          },
        },
      ],
    },
    {
      name: 'approval',
      aliases: ['approvals'],
      summary: '要你批准的事：开关是 ask 的工具（读写文件、跑命令）每次动手前先问',
      detail:
        'config.json 里 files.read、files.write、files.edit、files.bash 写成 "ask"：yoyo 想读、写、改文件或跑命令时不当场做，记成一条批准请求，等你在工作台的「待批准」里或这里批准。批准了常驻进程照原参数做一次，结果回到 yoyo 那里；拒绝或等太久（files.askTimeout，缺省 24 小时）就不做。批准不能扩大范围：不在工作区和只读目录里的，批准了也还是读写不了。',
      verbs: [
        {
          name: 'list',
          summary: '最近的批准请求：编号、状态、工具、谁要的、摘要，等批准的在前',
          agent: true,
          flags: ['state'],
          run(flags) {
            const state = flagText(flags, 'state');
            const states = state ? approvalStates(state) : undefined;
            const all = env.repos().approvals.list({ limit: 200, ...(states ? { states } : {}) });
            const items = states
              ? all.slice(0, 20)
              : [...all.filter((a) => a.state === 'pending'), ...all.filter((a) => a.state !== 'pending').slice(0, 20)];
            if (items.length === 0) return env.out(state ? `没有「${state}」的批准请求` : '还没有批准请求');
            for (const item of items) env.out(approvalRow(item));
          },
        },
        {
          name: 'show',
          summary: '一条批准请求的全部：完整参数（写的内容、改的原文和新文、命令）和做完的结果',
          agent: true,
          usage: '<编号>',
          run(_flags, args) {
            env.out(approvalDetail(approvalOf(env, args)));
          },
        },
        {
          name: 'approve',
          summary: '批准：常驻进程照原参数做一次，结果回到 yoyo 那里（先 show 看看要做什么）',
          usage: '<编号>',
          run(_flags, args) {
            const id = approvalOf(env, args).id;
            const item = guard(() => decideApproval(env.repos(), id, 'approved', env.now(), 'cli'));
            env.out(`批准了 #${item.id}「${item.summary}」，常驻进程在跑就会照做`);
          },
        },
        {
          name: 'deny',
          summary: '拒绝：不做，yoyo 会知道没做',
          usage: '<编号>',
          run(_flags, args) {
            const id = approvalOf(env, args).id;
            const item = guard(() => decideApproval(env.repos(), id, 'denied', env.now(), 'cli'));
            env.out(`拒绝了 #${item.id}「${item.summary}」`);
          },
        },
      ],
    },
    {
      name: 'artifact',
      aliases: ['artifacts'],
      summary: '子任务交的文件',
      detail:
        '子 agent 用 task_deliver 交的文件，存在 ~/.yoyo/artifacts/<子任务编号>/。子任务不删，交付物跟着留着；不要了用 rm 一个个删。',
      verbs: [
        {
          name: 'list',
          summary: '最近的交付物：编号、子任务、大小、类型、文件名',
          flags: ['task'],
          agent: true,
          run(flags) {
            const task = flagText(flags, 'task');
            const items = env.repos().artifacts.list(task ? { task: Number(task.replace(/^#/, '')) } : { limit: 50 });
            if (items.length === 0)
              return env.out(task ? `子任务 #${task.replace(/^#/, '')} 没交文件` : '还没有交付物');
            for (const item of items) env.out(artifactRow(item));
          },
        },
        {
          name: 'show',
          summary: '打出一个交付物：文字的打内容，别的打位置',
          usage: '<编号>',
          agent: true,
          run(_flags, args) {
            const item = artifactOf(env, args);
            const path = env.files().path(item.task, item.name);
            if (artifactView(item.type) !== 'text') return env.out(`${item.name}\t${item.type}\t${path}`);
            const bytes = env.files().read(item.task, item.name);
            if (!bytes) throw new Error(`${item.name} 的文件不在了：${path}`);
            env.out(Buffer.from(bytes).toString('utf8'));
          },
        },
        {
          name: 'rm',
          summary: '删掉一个交付物，文件和记录一起删',
          usage: '<编号>',
          run(_flags, args) {
            const item = removeArtifact(env.repos(), env.files(), artifactOf(env, args).id);
            env.out(`删了 ${item?.name ?? ''}`);
          },
        },
      ],
    },
    {
      name: 'web',
      summary: '管理页',
      detail:
        '常驻进程开着一个只听本机的网页：看状态和对话，管记忆、日程和联系人。地址每次启动都换，带着一次性令牌。config.json 的 web.enabled 关掉就不开。从 yoyo.app 里跑时在 app 的窗口里打开。',
      verbs: [
        {
          name: 'open',
          summary: '打开管理页',
          run() {
            const found = manager(env);
            if ('problem' in found) return env.out(found.problem);
            // 从 yoyo.app 里跑时打开 app：它把管理页放在自己的窗口里
            env.opener().open(env.paths.appBundle ?? found.url);
            env.out(found.url);
          },
        },
        {
          name: 'url',
          summary: '只打出管理页的地址，没开着时报错',
          run() {
            const found = manager(env);
            if ('problem' in found) throw new Error(found.problem);
            env.out(found.url);
          },
        },
      ],
    },
    {
      name: 'update',
      summary: '检查和安装新版本',
      detail: `从 GitHub Release（${UPDATE_REPO}）取最新版本。yoyo.app 能自己换上新版：下载 dmg、校验，等 app 收好常驻进程和桌宠退出后换掉，再重开。从源码跑的用 git pull。`,
      verbs: [
        {
          name: 'check',
          summary: '看有没有新版本',
          flags: ['json'],
          async run(flags) {
            const check = await checkUpdate(env.installed(), env.updater(), updateRepo());
            if (flags['json'] === true) {
              const { current, latest, available, page, body, message } = check;
              return env.out(JSON.stringify({ current, latest, available, page, body, message }));
            }
            env.out(check.message);
            if (check.available) env.out('yoyo update install 换上新版');
          },
        },
        {
          name: 'install',
          summary: '下载新版本，换上以后重开 yoyo.app',
          flags: ['json'],
          async run(flags) {
            if (flags['json'] === true) return installJson(env);
            const system = env.updater();
            const check = await checkUpdate(env.installed(), system, updateRepo());
            if (!check.available) return env.out(check.message);
            const { relaunch } = await installUpdate({
              check,
              paths: env.paths,
              system,
              out: (text) => env.out(text),
              // 终端里每 5% 一行
              progress: stepProgress(5, (done, total) => {
                if (done > 0) env.out(downloadLine(done, total));
              }),
            });
            env.out(relaunch ? `换上 ${check.latest} 后重开 yoyo` : `${check.latest} 装好了`);
          },
        },
      ],
    },
    {
      name: 'app',
      summary: 'yoyo.app 自己的设置',
      detail:
        '只有从 yoyo.app 跑才管用，从源码跑的没有 app 外壳。login 看或改 config.json 的 app.launchAtLogin：开了，登录 Mac 时 yoyo.app 自己打开（macOS 13 以上）；改完 app 几秒内跟上，和工作台设置页、app 菜单里的「开机时打开」是同一项。',
      verbs: [
        {
          name: 'login',
          summary: '看或改登录时自动打开 yoyo.app',
          usage: '[on|off]',
          run(_flags, args) {
            const want = args[0];
            if (want === undefined) {
              return env.out(env.settings().app.launchAtLogin ? '登录时自动打开：开着' : '登录时自动打开：关着');
            }
            if (want !== 'on' && want !== 'off') throw new Error('要写 on 或 off：yoyo app login on');
            saveSwitches(env.paths.configFile, { 'app.launchAtLogin': want === 'on' });
            env.out(want === 'on' ? '登录时会自动打开 yoyo' : '登录时不再自动打开 yoyo');
            if (!env.paths.appBundle) env.out('注意：现在不是从 yoyo.app 跑的，这一项只在 yoyo.app 里管用');
          },
        },
      ],
    },
    {
      name: 'search',
      summary: '在对话、子任务、交付物、记住的事、日程、联系人里找',
      detail:
        '几个词都要有，不分大小写；每类最多 --limit 条（缺省 8），新的在前。--in 只找哪几类：chat、tasks、files、facts、alarms、contacts，逗号分开。',
      fallback: 'all',
      verbs: [
        {
          name: 'all',
          summary: '找一个词：yoyo search 周报',
          usage: '<词>...',
          flags: ['in', 'limit'],
          agent: true,
          async run(flags, args) {
            const terms = searchTerms(args);
            if (terms.length === 0) return env.out('要给词：yoyo search 周报');
            const kinds = new Set(searchKinds(flagText(flags, 'in')));
            const limit = Math.max(1, Math.floor(Number(flagText(flags, 'limit')) || 8));
            const repos = env.repos();
            const rows = searchRows(
              {
                ...(kinds.has('chat')
                  ? {
                      entries: await (
                        await createYoyoContext({ db: env.db(), petId: env.settings().pet.id })
                      ).entries({ last: 2000 }),
                    }
                  : {}),
                ...(kinds.has('tasks') ? { tasks: repos.agentTasks.list({ limit: 500 }) } : {}),
                ...(kinds.has('files') ? { artifacts: repos.artifacts.list({ limit: 500 }) } : {}),
                ...(kinds.has('facts') ? { facts: await allFacts(openMemoryStore(env.db()), { open: true }) } : {}),
                ...(kinds.has('alarms') ? { schedule: repos.schedule.list() } : {}),
                ...(kinds.has('contacts') ? { contacts: repos.contacts.list() } : {}),
              },
              terms,
              limit,
            );
            if (rows.length === 0) return env.out(`没找到「${terms.join(' ')}」`);
            for (const row of rows) env.out(row);
          },
        },
      ],
    },
    {
      name: 'log',
      summary: '最近做过的事',
      verbs: [
        {
          name: 'tail',
          summary: '最后 20 条记录',
          agent: true,
          run() {
            const events = env.repos().activity.list(20);
            if (events.length === 0) return env.out('还没有记录');
            for (const event of events) {
              env.out(`${event.at}\t${event.type}${event.text ? `\t${oneLine(String(event.text), 60)}` : ''}`);
            }
          },
        },
      ],
    },
  ];
}
