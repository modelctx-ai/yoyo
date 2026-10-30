import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vite-plus/test';

import { openDatabase, transaction } from './db.ts';
import { createRepos } from './repos.ts';

/** 旧版 db.js 的建表语句，原样抄来，用来造一个老用户的库。 */
const LEGACY_SCHEMA = `
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

const APP_TABLES = [
  'activity',
  'agent_tasks',
  'clipboard',
  'contacts',
  'kv',
  'meme_pack',
  'memes',
  'schedule',
  'spoken',
  'tasks',
];

/** 旧版以后新加的表：只加表，旧表一字不动。 */
const ADDED_TABLES = ['agent_tasks'];

/** 去掉新加的表，剩下的应该和旧版一样。 */
function oldTables(sql: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(sql).filter(([name]) => !ADDED_TABLES.includes(name)));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-'));
}

/** 建表语句，按表名排好。 */
function tableSql(db: DatabaseSync): Record<string, string> {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return Object.fromEntries(tables.map((row) => [String(row.name), String(row.sql)]));
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

function writeJson(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data));
}

/** 旧版各个 JSON 文件，内容覆盖每一种导入。 */
function writeLegacyFiles(dir: string): void {
  writeJson(dir, 'contacts.json', {
    items: [
      { id: 'c_1', name: '小王', yoyo: 'yoyo://xiaowang@example', note: '同事', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'c_2', name: '小李', yoyo: 'yoyo://xiaoli@example', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  writeJson(dir, 'schedule.json', {
    items: [
      {
        id: 's_1',
        title: '喝水',
        kind: 'alarm',
        time: '15:30',
        repeat: 'daily',
        enabled: true,
        lastFired: '2026-10-22T15:30',
      },
      { id: 's_2', title: '交周报', kind: 'task', time: '09:00', date: '2026-10-23', enabled: false },
    ],
  });
  writeJson(dir, 'clipboard.json', {
    items: [
      { text: '新的', at: '2026-10-23T02:00:00.000Z' },
      { text: '旧的', at: '2026-10-23T01:00:00.000Z' },
    ],
  });
  writeJson(dir, 'context.json', {
    items: [
      { role: 'whisper', text: '在呢', at: 1 },
      { role: 'user', text: '在吗', at: 2, key: 'pet:2:user:在吗' },
      { role: 'assistant', text: '在的' },
    ],
  });
  writeJson(dir, 'memes.json', {
    fetchedAt: '2026-10-23T03:00:00.000Z',
    query: '可爱表情包 png',
    items: [{ url: 'https://example.com/z.png' }, { url: '' }, { url: 'https://example.com/a.png' }],
  });
  writeJson(dir, 'spoken.json', { items: [{ text: '水记得喝一口哦', at: 1_000 }] });
  writeJson(dir, 'weather-reported.json', { date: '2026-10-22' });
  writeJson(dir, 'place.json', { name: '北京', latitude: 39.9, longitude: 116.4 });
  writeJson(dir, 'tasks.json', { items: ['  修天气地点 ', '', 3, '写测试'] });
  writeFileSync(
    join(dir, 'activity.jsonl'),
    [
      JSON.stringify({ at: '2026-10-23T01:00:00.000Z', type: 'lively', action: '写代码', text: '在呢' }),
      '',
      JSON.stringify({ at: '2026-10-23T01:05:00.000Z', type: 'sfx', action: '写代码' }),
      '',
    ].join('\n'),
  );
}

const LEGACY_NAMES = [
  'contacts.json',
  'schedule.json',
  'clipboard.json',
  'context.json',
  'memes.json',
  'spoken.json',
  'weather-reported.json',
  'place.json',
  'tasks.json',
  'activity.jsonl',
];

describe('openDatabase', () => {
  test('新库建出旧版那九张表，语句一字不差，不建 context_items；另外只多出新加的表', () => {
    const dir = join(tempDir(), 'data', 'yoyo');
    const db = openDatabase(join(dir, 'yoyo.db'));
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(LEGACY_SCHEMA);
    const expected = tableSql(legacy);
    delete expected['context_items'];
    assert.deepEqual(Object.keys(tableSql(db)), APP_TABLES);
    assert.deepEqual(oldTables(tableSql(db)), expected);
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    db.close();
  });

  test('同一路径只开一次，关掉以后再开是新的连接', () => {
    const file = join(tempDir(), 'yoyo.db');
    const first = openDatabase(file);
    assert.equal(openDatabase(file), first);
    first.close();
    const second = openDatabase(file);
    assert.notEqual(second, first);
    assert.equal(second.isOpen, true);
    second.close();
  });

  test(':memory: 每次都是新库，表照样建好', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    assert.notEqual(a, b);
    assert.deepEqual(Object.keys(tableSql(a)), APP_TABLES);
  });

  test('旧 JSON 和 activity.jsonl 导进来，原文件改名成 .migrated', () => {
    const dir = tempDir();
    writeLegacyFiles(dir);
    const before = Date.now();
    const db = openDatabase(join(dir, 'yoyo.db'));
    const repos = createRepos(db);

    assert.deepEqual(repos.contacts.list(), [
      { id: 'c_2', name: '小李', yoyo: 'yoyo://xiaoli@example', note: '', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c_1', name: '小王', yoyo: 'yoyo://xiaowang@example', note: '同事', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    assert.deepEqual(repos.schedule.list(), [
      {
        id: 's_2',
        title: '交周报',
        kind: 'task',
        time: '09:00',
        date: '2026-10-23',
        repeat: null,
        weekday: null,
        enabled: false,
        lastFired: null,
      },
      {
        id: 's_1',
        title: '喝水',
        kind: 'alarm',
        time: '15:30',
        date: null,
        repeat: 'daily',
        weekday: null,
        enabled: true,
        lastFired: '2026-10-22T15:30',
      },
    ]);
    assert.deepEqual(repos.clipboard.list(), [
      { text: '新的', at: '2026-10-23T02:00:00.000Z' },
      { text: '旧的', at: '2026-10-23T01:00:00.000Z' },
    ]);
    assert.deepEqual(repos.memes.read(), {
      fetchedAt: '2026-10-23T03:00:00.000Z',
      query: '可爱表情包 png',
      items: [{ url: 'https://example.com/z.png' }, { url: 'https://example.com/a.png' }],
    });
    assert.deepEqual(repos.spoken.recent(2_000, 10_000), [{ text: '水记得喝一口哦', at: 1_000 }]);
    assert.equal(repos.kv.get('weather-date'), '2026-10-22');
    assert.deepEqual(JSON.parse(repos.kv.get('place') ?? ''), { name: '北京', latitude: 39.9, longitude: 116.4 });
    assert.deepEqual(repos.tasks.list(), ['修天气地点', '写测试']);
    assert.deepEqual(repos.activity.list(), [
      { at: '2026-10-23T01:00:00.000Z', type: 'lively', action: '写代码', text: '在呢' },
      { at: '2026-10-23T01:05:00.000Z', type: 'sfx', action: '写代码' },
    ]);
    assert.deepEqual(rows(db, 'SELECT payload FROM activity ORDER BY id LIMIT 1'), [
      { payload: '{"action":"写代码","text":"在呢"}' },
    ]);

    const context = rows(db, 'SELECT role, text, at, item_key FROM context_items ORDER BY id');
    assert.deepEqual(context.slice(0, 2), [
      { role: 'whisper', text: '在呢', at: 1, item_key: null },
      { role: 'user', text: '在吗', at: 2, item_key: 'pet:2:user:在吗' },
    ]);
    assert.equal(context[2]?.text, '在的');
    assert.ok(Number(context[2]?.at) >= before, '没有时间的条目记成导入时刻');

    for (const name of LEGACY_NAMES) {
      assert.equal(existsSync(join(dir, name)), false, `${name} 应该改名了`);
      assert.equal(existsSync(join(dir, `${name}.migrated`)), true, `${name}.migrated 应该在`);
    }
    db.close();
  });

  test('再开一次不会重复导入', () => {
    const dir = tempDir();
    writeLegacyFiles(dir);
    const file = join(dir, 'yoyo.db');
    openDatabase(file).close();
    const db = openDatabase(file);
    for (const [table, n] of Object.entries({ contacts: 2, schedule: 2, clipboard: 2, context_items: 3, memes: 2 })) {
      assert.equal(count(db, table), n, table);
    }
    for (const [table, n] of Object.entries({ spoken: 1, kv: 2, tasks: 2, activity: 2 })) {
      assert.equal(count(db, table), n, table);
    }
    db.close();
  });

  test('读不懂或写不进的旧文件原样留着，整份不导，下次再试', () => {
    const dir = tempDir();
    const file = join(dir, 'yoyo.db');
    writeFileSync(join(dir, 'clipboard.json'), '{ 不是 JSON');
    // 第二个联系人缺 yoyo 地址，整份回滚，第一个也不留
    writeJson(dir, 'contacts.json', {
      items: [
        { id: 'c_1', name: '小王', yoyo: 'yoyo://xiaowang@example', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c_2', name: '小李' },
      ],
    });
    writeFileSync(join(dir, 'activity.jsonl'), `${JSON.stringify({ at: 'x', type: 'sfx' })}\n{坏了\n`);
    writeJson(dir, 'tasks.json', { items: ['写测试'] });

    const db = openDatabase(file);
    assert.equal(count(db, 'clipboard'), 0);
    assert.equal(count(db, 'contacts'), 0);
    assert.equal(count(db, 'activity'), 0);
    assert.equal(count(db, 'tasks'), 1);
    assert.equal(readFileSync(join(dir, 'clipboard.json'), 'utf8'), '{ 不是 JSON');
    assert.equal(existsSync(join(dir, 'contacts.json')), true);
    assert.equal(existsSync(join(dir, 'activity.jsonl')), true);
    assert.equal(existsSync(join(dir, 'tasks.json.migrated')), true);
    db.close();

    writeJson(dir, 'contacts.json', {
      items: [{ id: 'c_1', name: '小王', yoyo: 'yoyo://xiaowang@example', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const again = openDatabase(file);
    assert.equal(count(again, 'contacts'), 1);
    assert.equal(existsSync(join(dir, 'contacts.json.migrated')), true);
    again.close();
  });

  test('先发的那版子任务表没有 agent 列：打开时补上，以前的子任务都算 general', () => {
    const file = join(tempDir(), 'yoyo.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, goal TEXT NOT NULL, criteria TEXT NOT NULL,
  state TEXT NOT NULL, todos TEXT NOT NULL DEFAULT '[]', result TEXT, checks TEXT NOT NULL DEFAULT '[]', error TEXT,
  origin TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
  announced_at INTEGER)`);
    old
      .prepare(
        'INSERT INTO agent_tasks (title, goal, criteria, state, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('周报', '目标', '[]', 'done', 'main', 1, 1);
    old.close();
    const repos = createRepos(openDatabase(file));
    assert.equal(repos.agentTasks.get(1)?.agent, 'general');
    assert.equal(
      repos.agentTasks.create({ title: '查', goal: '查', criteria: [], agent: 'research', origin: 'cli' }, 2).agent,
      'research',
    );
    // 再开一次不会重复加
    assert.doesNotThrow(() => createRepos(openDatabase(file)));
  });

  test('旧版建的库（带着有数据的 context_items）直接能用，那张表原样不动', () => {
    const dir = tempDir();
    const file = join(dir, 'yoyo.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA journal_mode = WAL');
    legacy.exec(LEGACY_SCHEMA);
    const insert = legacy.prepare('INSERT INTO context_items (role, text, at, item_key) VALUES (?, ?, ?, ?)');
    insert.run('whisper', '在呢', 1, null);
    insert.run('user', '在吗', 2, 'pet:2:user:在吗');
    legacy
      .prepare('INSERT INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c_1', '小王', 'yoyo://xiaowang@example', '', '2026-01-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('channel-base', 'http://127.0.0.1:4000/v1');
    const schemaBefore = tableSql(legacy);
    legacy.close();

    const db = openDatabase(file);
    const repos = createRepos(db);
    assert.deepEqual(oldTables(tableSql(db)), schemaBefore);
    assert.deepEqual(rows(db, 'SELECT id, role, text, at, item_key FROM context_items ORDER BY id'), [
      { id: 1, role: 'whisper', text: '在呢', at: 1, item_key: null },
      { id: 2, role: 'user', text: '在吗', at: 2, item_key: 'pet:2:user:在吗' },
    ]);
    assert.equal(repos.contacts.list()[0]?.name, '小王');
    assert.equal(repos.kv.get('channel-base'), 'http://127.0.0.1:4000/v1');
    repos.kv.set('channel-token', 't');
    assert.equal(repos.kv.get('channel-token'), 't');
    db.close();
  });
});

describe('transaction', () => {
  test('出错整段回滚；可以嵌套，也能放进别人的事务里', () => {
    const db = openDatabase(':memory:');
    const put = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    assert.throws(
      () =>
        transaction(db, () => {
          put.run('a', '1');
          throw new Error('写坏了');
        }),
      /写坏了/,
    );
    assert.equal(count(db, 'kv'), 0);
    transaction(db, () => {
      put.run('a', '1');
      transaction(db, () => put.run('b', '2'));
    });
    assert.equal(count(db, 'kv'), 2);
    db.exec('BEGIN');
    transaction(db, () => put.run('c', '3'));
    db.exec('ROLLBACK');
    assert.equal(count(db, 'kv'), 2);
    assert.equal(db.isTransaction, false);
  });
});
