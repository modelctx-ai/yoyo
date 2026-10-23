import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 应用自己的表。结构和旧版一样，老用户的 yoyo.db 直接能用。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yoyo TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  time TEXT NOT NULL,
  date TEXT,
  repeat TEXT,
  weekday INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired TEXT
);
CREATE TABLE IF NOT EXISTS clipboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memes (
  url TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS meme_pack (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT,
  query TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spoken (
  text TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 旧版的上下文表。只有导入旧 context.json 时才建，之后由 brain 迁进 ctx。 */
const LEGACY_CONTEXT = `
CREATE TABLE IF NOT EXISTS context_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  item_key TEXT
);
`;

const MEMORY = ':memory:';

const open = new Map<string, DatabaseSync>();

/** 建表。都是 IF NOT EXISTS，重复调用没关系。 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

/** 用 SAVEPOINT，所以已经在别人的事务里也能用。出错整段回滚。 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('SAVEPOINT yoyo_write');
  try {
    const result = work();
    db.exec('RELEASE yoyo_write');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO yoyo_write');
    db.exec('RELEASE yoyo_write');
    throw error;
  }
}

// ---------- 旧 JSON 的一次性导入 ----------

interface LegacyList<T> {
  readonly items?: readonly T[];
}

interface LegacyContact {
  readonly id: string;
  readonly name: string;
  readonly yoyo: string;
  readonly note?: string;
  readonly createdAt?: string;
}

interface LegacySchedule {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly time: string;
  readonly date?: string | null;
  readonly repeat?: string | null;
  readonly weekday?: number | null;
  readonly enabled?: boolean;
  readonly lastFired?: string | null;
}

interface LegacyClip {
  readonly text: string;
  readonly at: string;
}

interface LegacyContextItem {
  readonly role: string;
  readonly text: string;
  readonly at?: number;
  readonly key?: string | null;
}

interface LegacyMemes extends LegacyList<{ readonly url?: string }> {
  readonly fetchedAt?: string | null;
  readonly query?: string | null;
}

interface LegacySpoken {
  readonly text: string;
  readonly at: number;
}

interface LegacyActivity {
  readonly at: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

/** 导进去了才改名成 `*.migrated`；读不懂或写失败就整份回滚，旧文件留着下次再试。 */
function importFile(db: DatabaseSync, dir: string, name: string, load: (raw: string) => void): void {
  const path = join(dir, name);
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, 'utf8');
    transaction(db, () => load(raw));
    renameSync(path, `${path}.migrated`);
  } catch {
    /* 旧文件留着，下次还能再试 */
  }
}

function importJson<T>(db: DatabaseSync, dir: string, name: string, load: (data: T) => void): void {
  importFile(db, dir, name, (raw) => load(JSON.parse(raw) as T));
}

function migrate(db: DatabaseSync, dir: string): void {
  importJson<LegacyList<LegacyContact>>(db, dir, 'contacts.json', (data) => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of data.items ?? []) {
      insert.run(item.id, item.name, item.yoyo, item.note ?? '', item.createdAt ?? new Date().toISOString());
    }
  });
  importJson<LegacyList<LegacySchedule>>(db, dir, 'schedule.json', (data) => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO schedule (id, title, kind, time, date, repeat, weekday, enabled, last_fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const item of data.items ?? []) {
      insert.run(
        item.id,
        item.title,
        item.kind,
        item.time,
        item.date ?? null,
        item.repeat ?? null,
        item.weekday ?? null,
        item.enabled === false ? 0 : 1,
        item.lastFired ?? null,
      );
    }
  });
  importJson<LegacyList<LegacyClip>>(db, dir, 'clipboard.json', (data) => {
    const insert = db.prepare('INSERT INTO clipboard (text, at) VALUES (?, ?)');
    for (const item of [...(data.items ?? [])].reverse()) insert.run(item.text, item.at);
  });
  importJson<LegacyList<LegacyContextItem>>(db, dir, 'context.json', (data) => {
    db.exec(LEGACY_CONTEXT);
    const insert = db.prepare('INSERT INTO context_items (role, text, at, item_key) VALUES (?, ?, ?, ?)');
    for (const item of data.items ?? []) insert.run(item.role, item.text, item.at ?? Date.now(), item.key ?? null);
  });
  importJson<LegacyMemes>(db, dir, 'memes.json', (data) => {
    db.prepare('INSERT OR REPLACE INTO meme_pack (id, fetched_at, query) VALUES (1, ?, ?)').run(
      data.fetchedAt ?? null,
      data.query ?? null,
    );
    const insert = db.prepare('INSERT OR IGNORE INTO memes (url) VALUES (?)');
    for (const item of data.items ?? []) if (item.url) insert.run(item.url);
  });
  importJson<LegacyList<LegacySpoken>>(db, dir, 'spoken.json', (data) => {
    const insert = db.prepare('INSERT OR REPLACE INTO spoken (text, at) VALUES (?, ?)');
    for (const item of data.items ?? []) insert.run(item.text, item.at);
  });
  importJson<{ readonly date?: string }>(db, dir, 'weather-reported.json', (data) => {
    if (data.date) db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('weather-date', data.date);
  });
  importJson<unknown>(db, dir, 'place.json', (data) => {
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('place', JSON.stringify(data));
  });
  importJson<LegacyList<unknown>>(db, dir, 'tasks.json', (data) => {
    const insert = db.prepare('INSERT INTO tasks (text) VALUES (?)');
    for (const item of data.items ?? []) if (typeof item === 'string' && item.trim()) insert.run(item.trim());
  });
  importFile(db, dir, 'activity.jsonl', (raw) => {
    const insert = db.prepare('INSERT INTO activity (at, type, payload) VALUES (?, ?, ?)');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const { at, type, ...rest } = JSON.parse(line) as LegacyActivity;
      insert.run(at, type, JSON.stringify(rest));
    }
  });
}

/**
 * 打开 yoyo.db。同一路径只开一次；目录 0700；WAL；建表；再把同目录下的旧 JSON 导进来。
 * `:memory:` 每次都是新库，也不去找旧文件。
 */
export function openDatabase(dbFile: string): DatabaseSync {
  if (dbFile === MEMORY) {
    const db = new DatabaseSync(MEMORY);
    ensureSchema(db);
    return db;
  }
  const path = resolve(dbFile);
  const cached = open.get(path);
  if (cached?.isOpen) return cached;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // 常驻进程和命令行会同时写，碰上锁先等一会儿，不要立刻报 database is locked
  db.exec('PRAGMA busy_timeout = 5000');
  ensureSchema(db);
  migrate(db, dir);
  open.set(path, db);
  return db;
}
