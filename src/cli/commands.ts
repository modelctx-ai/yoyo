import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { compareEntries, textOf, type Entry } from '@modelctx-ai/ctx';

import { assertDirectorReady, llmReady, loadConfig, parseConfig, type Config } from '../app/config.ts';
import { createApp, createPetHost, createPlatformClipboard, type App, type AppOverrides } from '../app/container.ts';
import { consoleLogger } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import { createYoyoContext } from '../brain/context.ts';
import { createLanguageModel } from '../brain/model.ts';
import { addSchedule } from '../features/alarms/schedule.ts';
import { addContact } from '../features/contacts/contacts.ts';
import type { InboxRequest } from '../kernel/types.ts';
import type { Clipboard, Logger, PetHost, Repos } from '../ports/index.ts';
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
    host: () => overrides.host ?? createPetHost(env.config(), logger),
    app: () => createApp(env.config(), paths, { logger, db: env.db(), repos: env.repos(), ...overrides }),
  };
  return env;
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').slice(0, max);
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
