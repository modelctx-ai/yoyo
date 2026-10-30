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
CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  criteria TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'general',
  state TEXT NOT NULL,
  todos TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  announced_at INTEGER,
  question TEXT,
  asked_at INTEGER,
  answer TEXT,
  answered_at INTEGER,
  question_announced_at INTEGER
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, name)
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
  // 子任务的表先发过一版没有 agent 列的：补上，以前的子任务都算 general
  const columns = db
    .prepare('PRAGMA table_info(agent_tasks)')
    .all()
    .map((row) => String(row.name));
  if (!columns.includes('agent')) db.exec("ALTER TABLE agent_tasks ADD COLUMN agent TEXT NOT NULL DEFAULT 'general'");
  // 子 agent 中途问主人：问题、回答和各自的时间
  const asking: readonly (readonly [string, string])[] = [
    ['question', 'TEXT'],
    ['asked_at', 'INTEGER'],
    ['answer', 'TEXT'],
    ['answered_at', 'INTEGER'],
    ['question_announced_at', 'INTEGER'],
  ];
  for (const [name, type] of asking) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE agent_tasks ADD COLUMN ${name} ${type}`);
  }
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

/** 读出来的 JSON 不带类型，各个调用方按旧文件的形状断言。 */
function importJson(db: DatabaseSync, dir: string, name: string, load: (json: unknown) => void): void {
  importFile(db, dir, name, (raw) => load(JSON.parse(raw)));
}

function migrate(db: DatabaseSync, dir: string): void {
  importJson(db, dir, 'contacts.json', (json) => {
    const data = json as LegacyList<LegacyContact>;
    const insert = db.prepare(
      'INSERT OR IGNORE INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of data.items ?? []) {
      insert.run(item.id, item.name, item.yoyo, item.note ?? '', item.createdAt ?? new Date().toISOString());
    }
  });
  importJson(db, dir, 'schedule.json', (json) => {
    const data = json as LegacyList<LegacySchedule>;
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
  importJson(db, dir, 'clipboard.json', (json) => {
    const data = json as LegacyList<LegacyClip>;
    const insert = db.prepare('INSERT INTO clipboard (text, at) VALUES (?, ?)');
    for (const item of (data.items ?? []).toReversed()) insert.run(item.text, item.at);
  });
  importJson(db, dir, 'context.json', (json) => {
    const data = json as LegacyList<LegacyContextItem>;
    db.exec(LEGACY_CONTEXT);
    const insert = db.prepare('INSERT INTO context_items (role, text, at, item_key) VALUES (?, ?, ?, ?)');
    for (const item of data.items ?? []) insert.run(item.role, item.text, item.at ?? Date.now(), item.key ?? null);
  });
  importJson(db, dir, 'memes.json', (json) => {
    const data = json as LegacyMemes;
    db.prepare('INSERT OR REPLACE INTO meme_pack (id, fetched_at, query) VALUES (1, ?, ?)').run(
      data.fetchedAt ?? null,
      data.query ?? null,
    );
    const insert = db.prepare('INSERT OR IGNORE INTO memes (url) VALUES (?)');
    for (const item of data.items ?? []) if (item.url) insert.run(item.url);
  });
  importJson(db, dir, 'spoken.json', (json) => {
    const data = json as LegacyList<LegacySpoken>;
    const insert = db.prepare('INSERT OR REPLACE INTO spoken (text, at) VALUES (?, ?)');
    for (const item of data.items ?? []) insert.run(item.text, item.at);
  });
  importJson(db, dir, 'weather-reported.json', (json) => {
    const data = json as { readonly date?: string };
    if (data.date) db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('weather-date', data.date);
  });
  importJson(db, dir, 'place.json', (data) => {
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('place', JSON.stringify(data));
  });
  importJson(db, dir, 'tasks.json', (json) => {
    const data = json as LegacyList<unknown>;
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
