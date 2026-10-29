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
import { consoleLogger } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import { createYoyoContext } from '../brain/context.ts';
import { allFacts, createYoyoMemory, evidenceOf, memorySessions, openMemoryStore, ungated } from '../brain/memory.ts';
import { createLanguageModel } from '../brain/model.ts';
import { addSchedule } from '../features/alarms/schedule.ts';
import { addContact } from '../features/contacts/contacts.ts';
import { localDateKey } from '../kernel/time.ts';
import type { InboxRequest } from '../kernel/types.ts';
import type { Clipboard, Logger, PetHost, Repos, UrlOpener } from '../ports/index.ts';
import { compactContext } from '../runtime/compact.ts';
import { directorAlive, enqueue } from '../runtime/inbox.ts';
import { openDatabase } from '../storage/db.ts';
import { createRepos } from '../storage/repos.ts';
import { flagText, type Domain } from './registry.ts';

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
}

export interface CommandEnvOptions {
  readonly out?: (text: string) => void;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** 测试用：换掉组装里的服务。 */
  readonly overrides?: AppOverrides;
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
  };
  return env;
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
      detail: '到点后 15 分钟内说一次。repeat 可以是 daily、weekdays、weekly。',
      verbs: [
        {
          name: 'list',
          summary: '列出日程',
          run() {
            const items = env.repos().schedule.list();
            if (items.length === 0) return env.out('还没有日程');
            for (const item of items) env.out(`${item.kind}\t${item.time}\t${item.repeat || item.date}\t${item.title}`);
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
      name: 'web',
      summary: '管理页',
      detail:
        '常驻进程开着一个只听本机的网页：看状态和对话，管记忆、日程和联系人。地址每次启动都换，带着一次性令牌。config.json 的 web.enabled 关掉就不开。',
      verbs: [
        {
          name: 'open',
          summary: '用浏览器打开管理页',
          run() {
            if (!env.settings().web.enabled) return env.out('config.json 的 web.enabled 关着，没有管理页');
            const url = env.repos().kv.get('web-url');
            if (!url || !directorAlive(env.paths.pidFile)) return env.out('常驻进程没在跑，管理页跟着它开');
            env.opener().open(url);
            env.out(url);
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
