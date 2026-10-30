/**
 * 导演和常驻循环测试用的替身。都在内存里，不联网、不开子进程。
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { userEntry, type Context } from '@modelctx-ai/ctx';

import { createYoyoContext, recordUser } from '../brain/context.ts';
import { createRepos } from '../storage/repos.ts';
import type {
  ActivityRecord,
  Line,
  ClipEntry,
  Contact,
  MemePack,
  PetChatMessage,
  PetSaying,
  ScheduleItem,
} from '../kernel/types.ts';
import type {
  AudioPlayer,
  Logger,
  PetHost,
  Recorder,
  Repos,
  SfxPlayer,
  Synthesizer,
  Transcriber,
  UrlOpener,
  WebSearch,
} from '../ports/index.ts';
import type { Director } from './director.ts';

export interface MemoryLogger extends Logger {
  readonly lines: string[];
}

export function memoryLogger(): MemoryLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

export function memoryRepos(options: { readonly now?: () => Date } = {}): Repos {
  const now = options.now ?? (() => new Date());
  let contacts: Contact[] = [];
  let schedule: ScheduleItem[] = [];
  const clips: ClipEntry[] = [];
  let pack: MemePack | null = null;
  const activity: ActivityRecord[] = [];
  const spoken = new Map<string, number>();
  const kv = new Map<string, string>();
  const tasks: string[] = [];
  const sqlite = createRepos(new DatabaseSync(':memory:'), now);
  return {
    contacts: {
      list: () => [...contacts],
      insert: (contact) => void contacts.push(contact),
      remove: (id) => {
        const before = contacts.length;
        contacts = contacts.filter((contact) => contact.id !== id);
        return contacts.length < before;
      },
    },
    schedule: {
      list: () => schedule.toSorted((a, b) => a.time.localeCompare(b.time)),
      insert: (item) => void schedule.push(item),
      markFired: (id, occurrence) => {
        schedule = schedule.map((item) => (item.id === id ? { ...item, lastFired: occurrence } : item));
      },
      update: (next) => {
        const found = schedule.some((item) => item.id === next.id);
        schedule = schedule.map((item) => (item.id === next.id ? next : item));
        return found;
      },
      remove: (id) => {
        const before = schedule.length;
        schedule = schedule.filter((item) => item.id !== id);
        return schedule.length < before;
      },
    },
    clipboard: {
      list: (limit = 50) => clips.slice(0, limit),
      insert: (entry) => {
        clips.unshift(entry);
        clips.splice(50);
      },
    },
    memes: {
      read: () => pack,
      write: (next) => {
        pack = next;
      },
    },
    activity: {
      record: (event) => void activity.push({ ...event, at: now().toISOString() }),
      list: (limit = 20, filter) =>
        activity
          .filter(
            (item) =>
              (!filter?.types || filter.types.includes(item.type)) && (!filter?.before || item.at < filter.before),
          )
          .slice(-limit),
    },
    spoken: {
      recent: (at, windowMs) =>
        [...spoken].filter(([, when]) => at - when < windowMs).map(([text, when]) => ({ text, at: when })),
      remember: (text, at, windowMs) => {
        for (const [old, when] of spoken) if (at - when >= windowMs) spoken.delete(old);
        spoken.set(text, at);
      },
    },
    kv: {
      get: (key) => kv.get(key) ?? null,
      set: (key, value) => void kv.set(key, value),
    },
    tasks: { list: () => [...tasks] },
    // 子任务和交付物的读写有 JSON 列和自增 id，直接用内存里的 SQLite，不另写一份
    agentTasks: sqlite.agentTasks,
    artifacts: sqlite.artifacts,
    approvals: sqlite.approvals,
  };
}

/** 记下的调用顺序，例如 `lock`、`broadcast:…`、`play:…`。 */
export type CallLog = string[];

export interface FakeHostOptions {
  readonly name?: string;
  readonly chat?: () => Promise<readonly PetChatMessage[]>;
  readonly cue?: (action: string) => Promise<void>;
  readonly sayings?: readonly PetSaying[];
  readonly menu?: readonly string[];
}

/** 和真宿主一样的顺序：占锁、投喂、点播，执行 during，放锁。 */
export function fakeHost(calls: CallLog, options: FakeHostOptions = {}): PetHost {
  return {
    name: options.name ?? 'fake',
    async present(line, during) {
      calls.push('lock', `broadcast:${line.text}${line.imageUrl ? ` ${line.imageUrl}` : ''}`, `anim:${line.action}`);
      try {
        if (during) await during();
      } finally {
        calls.push('release');
      }
    },
    cue(action) {
      calls.push(`cue:${action}`);
      return options.cue ? options.cue(action) : Promise.resolve();
    },
    chatHistory: () => (options.chat ? options.chat() : Promise.resolve([])),
    workStatus: () => Promise.resolve(null),
    async *menu() {
      yield* options.menu ?? [];
    },
    async *sayings() {
      yield* options.sayings ?? [];
    },
    async bindChat(binding) {
      calls.push(`bind:${binding.baseUrl}`);
      return { model: binding.model };
    },
  };
}

export function fakeSynthesizer(calls: CallLog): Synthesizer {
  return {
    async synthesize(text, cue) {
      calls.push(`synth:${cue} ${text}`);
      return `voice/${text}.mp3`;
    },
  };
}

export function fakePlayer(calls: CallLog): AudioPlayer {
  return {
    async play(file) {
      calls.push(`play:${file}`);
    },
    fire(file) {
      calls.push(`fire:${file}`);
    },
  };
}

export function fakeSfx(calls: CallLog): SfxPlayer {
  return {
    play: (action) => void calls.push(`sfx:${action}`),
  };
}

export interface FakeRecorder extends Recorder {
  /** 录过的文件路径。 */
  readonly files: string[];
}

/** 真的写一个文件，好检查导演用完删没删。 */
export function fakeRecorder(calls: CallLog, fail?: Error): FakeRecorder {
  const files: string[] = [];
  return {
    files,
    async record(file, seconds) {
      calls.push(`record:${seconds}`);
      files.push(file);
      writeFileSync(file, 'RIFF');
      if (fail) throw fail;
      return file;
    },
  };
}

export function fakeTranscriber(calls: CallLog, heard: () => string): Transcriber {
  return {
    async transcribe() {
      calls.push('transcribe');
      return heard();
    },
  };
}

/** 给 Error 就让每次搜索都失败。 */
export function fakeSearch(calls: CallLog, result: string | Error): WebSearch {
  return {
    async search(query) {
      calls.push(`search:${query}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export function fakeOpener(calls: CallLog): UrlOpener {
  return { open: (url) => void calls.push(`open:${url}`) };
}

export const LINE: Line = { text: '我在呢', tone: 'lively', cue: '[happy]', action: '照镜子', kind: 'whisper' };

/** 只记调用的导演：`choose` 给 LINE，`speak` 记 `speak:<文字>`，`hear` 记 `hear` 并当作听到「我在」。 */
export function fakeDirector(calls: string[], overrides: Partial<Director> = {}): Director {
  return {
    choose: async () => LINE,
    dress: (line) => line,
    speak: async (line) => void calls.push(`speak:${line.text}`),
    hear: async () => {
      calls.push('hear');
      return '我在';
    },
    remind: async (item) => void calls.push(`remind:${item.title}`),
    bake: async () => void calls.push('bake'),
    claim: (text) => void calls.push(`claim:${text}`),
    playForeign: async (text) => {
      calls.push(`foreign:${text}`);
      return true;
    },
    refreshMemes: async () => {
      calls.push('memes');
      return null;
    },
    syncPetChat: async () => {
      calls.push('sync');
      return 0;
    },
    compactIfNeeded: async () => {
      calls.push('compact');
      return false;
    },
    ...overrides,
  };
}

/**
 * 0.2 留下的会话：晚到的回答（at 500）先于锚点（at 300）写进来，摘要的 covers 是 { at: 300, seq: 3 }。
 * 旧规则按 at 比，晚到的回答摘要之后还看得见；0.3 按 seq 比，它被盖住了。新库里写好，再把摘要那一行改回 v0 的样子。
 */
export async function lossyContext(): Promise<Context> {
  const db = new DatabaseSync(':memory:');
  const context = await createYoyoContext({ db, petId: 'main' });
  await recordUser(context, '很早的问题', 100);
  await context.append(userEntry('晚到的回答', { at: 500 }));
  await recordUser(context, '问题二', 300);
  await context.append({ type: 'summary', text: '旧摘要：问题一和二', covers: 3, at: 700 });
  await recordUser(context, '之后的问题', 800);
  db.exec(
    `UPDATE ctx_entries SET v = 0, body = json_set(body, '$.covers', json('{"at":300,"seq":3}')) WHERE type = 'summary'`,
  );
  return context;
}
