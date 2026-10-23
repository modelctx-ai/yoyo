import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

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
CREATE TABLE IF NOT EXISTS context_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  item_key TEXT
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

const open = new Map();

function importJson(dataDir, name, load) {
  const path = join(dataDir, name);
  if (!existsSync(path)) return;
  try {
    load(JSON.parse(readFileSync(path, 'utf8')));
    renameSync(path, `${path}.migrated`);
  } catch {
    /* 旧文件留着，下次还能再试 */
  }
}

function migrate(db, dataDir) {
  importJson(dataDir, 'contacts.json', (data) => {
    const insert = db.prepare('INSERT OR IGNORE INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const item of data.items ?? []) {
      insert.run(item.id, item.name, item.yoyo, item.note ?? '', item.createdAt ?? new Date().toISOString());
    }
  });
  importJson(dataDir, 'schedule.json', (data) => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO schedule (id, title, kind, time, date, repeat, weekday, enabled, last_fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const item of data.items ?? []) {
      insert.run(item.id, item.title, item.kind, item.time, item.date ?? null, item.repeat ?? null, item.weekday ?? null, item.enabled === false ? 0 : 1, item.lastFired ?? null);
    }
  });
  importJson(dataDir, 'clipboard.json', (data) => {
    const insert = db.prepare('INSERT INTO clipboard (text, at) VALUES (?, ?)');
    for (const item of [...(data.items ?? [])].reverse()) insert.run(item.text, item.at);
  });
  importJson(dataDir, 'context.json', (data) => {
    const insert = db.prepare('INSERT INTO context_items (role, text, at, item_key) VALUES (?, ?, ?, ?)');
    for (const item of data.items ?? []) insert.run(item.role, item.text, item.at ?? Date.now(), item.key ?? null);
  });
  importJson(dataDir, 'memes.json', (data) => {
    db.prepare('INSERT OR REPLACE INTO meme_pack (id, fetched_at, query) VALUES (1, ?, ?)').run(data.fetchedAt ?? null, data.query ?? null);
    const insert = db.prepare('INSERT OR IGNORE INTO memes (url) VALUES (?)');
    for (const item of data.items ?? []) if (item.url) insert.run(item.url);
  });
  importJson(dataDir, 'spoken.json', (data) => {
    const insert = db.prepare('INSERT OR REPLACE INTO spoken (text, at) VALUES (?, ?)');
    for (const item of data.items ?? []) insert.run(item.text, item.at);
  });
  importJson(dataDir, 'weather-reported.json', (data) => {
    if (data.date) db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('weather-date', data.date);
  });
  importJson(dataDir, 'place.json', (data) => {
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('place', JSON.stringify(data));
  });
  importJson(dataDir, 'tasks.json', (data) => {
    const insert = db.prepare('INSERT INTO tasks (text) VALUES (?)');
    for (const item of data.items ?? []) if (typeof item === 'string' && item.trim()) insert.run(item.trim());
  });
  const activityPath = join(dataDir, 'activity.jsonl');
  if (existsSync(activityPath)) {
    try {
      const insert = db.prepare('INSERT INTO activity (at, type, payload) VALUES (?, ?, ?)');
      for (const line of readFileSync(activityPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const { at, type, ...rest } = event;
        insert.run(at, type, JSON.stringify(rest));
      }
      renameSync(activityPath, `${activityPath}.migrated`);
    } catch {
      /* 旧日志留着 */
    }
  }
}

export function openDb(dataDir) {
  const path = join(dataDir, 'yoyo.db');
  const cached = open.get(path);
  if (cached) return cached;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db, dataDir);
  open.set(path, db);
  return db;
}

export function listContacts(dataDir) {
  return openDb(dataDir)
    .prepare('SELECT id, name, yoyo, note, created_at AS createdAt FROM contacts ORDER BY created_at')
    .all();
}

export function insertContact(dataDir, contact) {
  openDb(dataDir)
    .prepare('INSERT INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(contact.id, contact.name, contact.yoyo, contact.note, contact.createdAt);
}

export function listSchedule(dataDir) {
  return openDb(dataDir)
    .prepare('SELECT id, title, kind, time, date, repeat, weekday, enabled, last_fired AS lastFired FROM schedule ORDER BY time')
    .all()
    .map((row) => ({ ...row, enabled: row.enabled === 1, weekday: row.weekday ?? null, date: row.date ?? null, repeat: row.repeat ?? null, lastFired: row.lastFired ?? null }));
}

export function replaceSchedule(dataDir, items) {
  const db = openDb(dataDir);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM schedule');
    const insert = db.prepare(
      'INSERT INTO schedule (id, title, kind, time, date, repeat, weekday, enabled, last_fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const item of items) {
      insert.run(item.id, item.title, item.kind, item.time, item.date ?? null, item.repeat ?? null, item.weekday ?? null, item.enabled === false ? 0 : 1, item.lastFired ?? null);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listClips(dataDir) {
  return openDb(dataDir).prepare('SELECT text, at FROM clipboard ORDER BY id DESC LIMIT 50').all();
}

export function insertClip(dataDir, entry) {
  const db = openDb(dataDir);
  db.prepare('INSERT INTO clipboard (text, at) VALUES (?, ?)').run(entry.text, entry.at);
  db.prepare('DELETE FROM clipboard WHERE id NOT IN (SELECT id FROM clipboard ORDER BY id DESC LIMIT 50)').run();
}

export function loadContext(dataDir) {
  return openDb(dataDir)
    .prepare('SELECT role, text, at, item_key AS key FROM context_items ORDER BY at, id')
    .all()
    .map((row) => ({ role: row.role, text: row.text, at: row.at, key: row.key ?? undefined }));
}

export function saveContext(dataDir, items) {
  const db = openDb(dataDir);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM context_items');
    const insert = db.prepare('INSERT INTO context_items (role, text, at, item_key) VALUES (?, ?, ?, ?)');
    for (const item of items) insert.run(item.role, item.text, item.at ?? Date.now(), item.key ?? null);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readPack(dataDir) {
  const pack = openDb(dataDir).prepare('SELECT fetched_at AS fetchedAt, query FROM meme_pack WHERE id = 1').get();
  if (!pack) return null;
  const items = openDb(dataDir).prepare('SELECT url FROM memes').all();
  return { fetchedAt: pack.fetchedAt, query: pack.query, items };
}

export function writePack(dataDir, pack) {
  const db = openDb(dataDir);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR REPLACE INTO meme_pack (id, fetched_at, query) VALUES (1, ?, ?)').run(pack.fetchedAt, pack.query);
    db.exec('DELETE FROM memes');
    const insert = db.prepare('INSERT INTO memes (url) VALUES (?)');
    for (const item of pack.items ?? []) insert.run(item.url);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function recordActivity(dataDir, event) {
  const { type, ...rest } = event;
  openDb(dataDir)
    .prepare('INSERT INTO activity (at, type, payload) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), type, JSON.stringify(rest));
}

export function listActivity(dataDir, limit = 20) {
  return openDb(dataDir)
    .prepare('SELECT at, type, payload FROM activity ORDER BY id DESC LIMIT ?')
    .all(limit)
    .reverse()
    .map((row) => ({ at: row.at, type: row.type, ...JSON.parse(row.payload) }));
}

export function listSpoken(dataDir) {
  return openDb(dataDir).prepare('SELECT text, at FROM spoken').all();
}

export function saveSpoken(dataDir, items) {
  const db = openDb(dataDir);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM spoken');
    const insert = db.prepare('INSERT INTO spoken (text, at) VALUES (?, ?)');
    for (const item of items) insert.run(item.text, item.at);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getKv(dataDir, key) {
  return openDb(dataDir).prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function setKv(dataDir, key, value) {
  openDb(dataDir).prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

export function listTasks(dataDir) {
  return openDb(dataDir).prepare('SELECT text FROM tasks ORDER BY id').all().map((row) => row.text);
}
