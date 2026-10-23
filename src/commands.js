import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listActivity } from './activity.js';
import { addContact, listContacts } from './contacts.js';
import { listClips, readPaste } from './clipboard.js';
import { createDirector } from './director.js';
import { enqueue } from './inbox.js';
import { getKv } from './db.js';
import { syncChatChannel } from './pet.js';
import { loadContext } from './context.js';
import { readPack } from './memes.js';
import { addSchedule, listSchedule } from './schedule.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(homedir(), '.yoyo');

function loadConfig() {
  const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  return raw;
}

function directorAlive() {
  const path = join(dataDir, 'director.pid');
  if (!existsSync(path)) return false;
  const pid = Number(readFileSync(path, 'utf8'));
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function handoff(type) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (directorAlive()) {
    enqueue(dataDir, type);
    console.log(`已交给正在运行的 yoyo：${type}`);
    return;
  }
  const director = createDirector(loadConfig(), dataDir);
  if (type === 'listen') await director.listenNow();
  else await director.perform();
}

export const domains = [
  {
    name: 'alarm',
    summary: '闹钟和周期性日程',
    detail: '到点后 15 分钟内说一次。repeat 可以是 daily、weekdays、weekly。',
    verbs: [
      {
        name: 'list',
        summary: '列出日程',
        run() {
          const items = listSchedule(dataDir);
          if (items.length === 0) return console.log('还没有日程');
          for (const item of items) console.log(`${item.kind}\t${item.time}\t${item.repeat || item.date}\t${item.title}`);
        },
      },
      {
        name: 'add',
        summary: '新增闹钟或任务',
        flags: ['title', 'time', 'repeat', 'date', 'weekday', 'kind'],
        run(flags) {
          const item = addSchedule(dataDir, {
            title: flags.title,
            time: flags.time,
            date: flags.date,
            repeat: flags.repeat || null,
            weekday: flags.weekday === undefined ? undefined : Number(flags.weekday),
            kind: flags.kind || 'alarm',
          });
          console.log(`${item.kind}\t${item.time}\t${item.title}`);
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
          const items = listContacts(dataDir);
          if (items.length === 0) return console.log('还没有联系人');
          for (const item of items) console.log(`${item.name}\t${item.yoyo}${item.note ? `\t${item.note}` : ''}`);
        },
      },
      {
        name: 'add',
        summary: '新增联系人',
        flags: ['name', 'yoyo', 'note'],
        run(flags) {
          const contact = addContact(dataDir, flags);
          console.log(`${contact.name}\t${contact.yoyo}`);
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
          const text = readPaste().trim();
          console.log(text ? text.slice(0, 500) : '粘贴板是空的');
        },
      },
      {
        name: 'history',
        summary: '最近复制过的内容',
        run() {
          const items = listClips(dataDir);
          if (items.length === 0) return console.log('还没有复制记录');
          for (const item of items.slice(0, 20)) console.log(`${item.at}\t${item.text.replace(/\s+/g, ' ').slice(0, 80)}`);
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
          const cfg = loadConfig();
          const baseUrl = getKv(dataDir, 'channel-base');
          if (!baseUrl) {
            console.log('导演没在跑，上下文代理还没起来');
            return;
          }
          const saved = await syncChatChannel(cfg.pet, { ...cfg.llm, baseUrl });
          console.log(`已接上 ${saved.model}`);
        },
      },
    ],
  },
  {
    name: 'context',
    summary: '完整对话上下文',
    detail: '连续碎碎念收成一条。用户和回复按原句保留，先不压缩。存在 ~/.yoyo/yoyo.db。',
    verbs: [
      {
        name: 'tail',
        summary: '最后几条原文',
        run() {
          const items = loadContext(dataDir);
          if (items.length === 0) return console.log('还没有上下文');
          for (const item of items.slice(-12)) console.log(`${item.role}\t${String(item.text).replace(/\s+/g, ' ').slice(0, 80)}`);
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
          const pack = readPack(dataDir);
          const items = pack?.items ?? [];
          if (items.length === 0) return console.log('还没有表情包');
          console.log(`${pack.fetchedAt}\t${items.length}张`);
          for (const item of items) console.log(item.url);
        },
      },
      {
        name: 'refresh',
        summary: '现在就去找一套',
        async run() {
          const cfg = loadConfig();
          const director = createDirector(cfg, dataDir);
          const pack = await director.refreshMemes(new Date(), { force: true });
          console.log(`${pack?.items?.length ?? 0}张`);
        },
      },
    ],
  },
  {
    name: 'listen',
    summary: '马上听一句语音',
    detail: '导演在跑时交给它。没在跑就当场听。默认按键是 Control+Option+Y。',
    verbs: [
      {
        name: 'now',
        summary: '现在就开始听',
        run: () => handoff('listen'),
      },
    ],
  },
  {
    name: 'whisper',
    summary: '马上说一句碎碎念',
    detail: '右键 yoyo 分组里的「碎碎念」也是这一条。宠物自带的那一项到不了这里。',
    verbs: [
      {
        name: 'now',
        summary: '现在就说一句',
        run: () => handoff('whisper'),
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
          const events = listActivity(dataDir, 20);
          if (events.length === 0) return console.log('还没有记录');
          for (const event of events) {
            console.log(`${event.at}\t${event.type}${event.text ? `\t${String(event.text).replace(/\s+/g, ' ').slice(0, 60)}` : ''}`);
          }
        },
      },
    ],
  },
];
