/**
 * 导演和常驻循环测试用的替身。都在内存里，不联网、不开子进程。
 */
import { writeFileSync } from 'node:fs';

import type {
  ActivityRecord,
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
  const contacts: Contact[] = [];
  let schedule: ScheduleItem[] = [];
  const clips: ClipEntry[] = [];
  let pack: MemePack | null = null;
  const activity: ActivityRecord[] = [];
  const spoken = new Map<string, number>();
  const kv = new Map<string, string>();
  const tasks: string[] = [];
  return {
    contacts: {
      list: () => [...contacts],
      insert: (contact) => void contacts.push(contact),
    },
    schedule: {
      list: () => schedule.toSorted((a, b) => a.time.localeCompare(b.time)),
      insert: (item) => void schedule.push(item),
      markFired: (id, occurrence) => {
        schedule = schedule.map((item) => (item.id === id ? { ...item, lastFired: occurrence } : item));
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
      list: (limit = 20) => activity.slice(-limit),
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
