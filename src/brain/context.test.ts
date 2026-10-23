import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { createContext, createMemoryStore, type ContextEntry, type ModelMessage } from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

import type { Line, PetChatMessage } from '../kernel/types.ts';
import {
  createYoyoContext,
  migrateLegacyContext,
  petChatEntries,
  recordLine,
  recordUser,
  storePetChat,
  threadFor,
  yoyoProjection,
} from './context.ts';

function line(kind: Line['kind'], text: string): Line {
  return { text, kind, tone: 'warm', cue: '[relaxed]', action: '碎碎念-对屏碎碎念' };
}

function memoryContext() {
  let clock = 0;
  return createContext({
    store: createMemoryStore({ now: () => (clock += 1) }),
    thread: threadFor('main'),
    projection: yoyoProjection,
  });
}

function shown(messages: readonly ModelMessage[]): string[] {
  return messages.map((message) => `${message.role}:${String(message.content)}`);
}

function shapes(entries: readonly ContextEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'message') return `${entry.message.role}:${String(entry.message.content)}`;
    if (entry.type === 'event') return `${entry.kind}:${entry.text ?? ''}`;
    return `summary:${entry.text}`;
  });
}

interface LegacyItem {
  readonly role: string;
  readonly text: string;
  readonly at: number;
  readonly key?: string;
}

const LEGACY_SCHEMA = `CREATE TABLE IF NOT EXISTS %s (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  item_key TEXT
)`;

function legacyTable(db: DatabaseSync, name: string, items: readonly LegacyItem[]): void {
  db.exec(LEGACY_SCHEMA.replace('%s', name));
  const insert = db.prepare(`INSERT INTO ${name} (role, text, at, item_key) VALUES (?, ?, ?, ?)`);
  for (const item of items) insert.run(item.role, item.text, item.at, item.key ?? null);
}

function tables(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'context_items%'").all() as {
      name: string;
    }[]
  )
    .map((row) => row.name)
    .sort();
}

const LEGACY: readonly LegacyItem[] = [
  { role: 'whisper', text: '在呢', at: 10 },
  { role: 'whisper', text: '水记得喝一口哦', at: 20 },
  { role: 'system', text: '认不出的角色', at: 25 },
  { role: 'whisper', text: '', at: 26 },
  { role: 'user', text: '在吗', at: 30, key: 'pet:30:user:在吗' },
  { role: 'assistant', text: '在的', at: 40, key: 'pet:40:assistant:在的' },
  { role: 'user', text: '今天海淀的天气要说完整，不要砍掉后半句', at: 50 },
];

describe('brain/context', () => {
  test('线程按桌宠分开', () => {
    assert.equal(threadFor('main'), 'pet:main');
  });

  test('连续碎碎念合成一条，对话原句不截断', async () => {
    const context = memoryContext();
    await recordLine(context, line('whisper', '在呢'), 1);
    await recordLine(context, line('generated', '水记得喝一口哦'), 2);
    await recordUser(context, '今天海淀的天气要说完整，不要砍掉后半句', 3);
    await recordLine(context, line('reply', '傍晚会下雨，出门带伞。'), 4);
    await recordLine(context, line('whisper', '我在旁边盯着呢'), 5);
    assert.deepEqual(shown((await context.view()).messages), [
      'assistant:碎碎念：\n在呢\n水记得喝一口哦',
      'user:今天海淀的天气要说完整，不要砍掉后半句',
      'assistant:傍晚会下雨，出门带伞。',
      'assistant:碎碎念：\n我在旁边盯着呢',
    ]);
  });

  test('回复、提醒、天气记成助手消息，碎碎念和现写的句子记成碎碎念事件，时间照给的记', async () => {
    const context = memoryContext();
    for (const [at, kind] of (['whisper', 'generated', 'reply', 'reminder', 'weather'] as const).entries()) {
      await recordLine(context, line(kind, kind), 100 + at);
    }
    const entries = await context.entries();
    assert.deepEqual(shapes(entries), [
      'whisper:whisper',
      'whisper:generated',
      'assistant:reply',
      'assistant:reminder',
      'assistant:weather',
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.at),
      [100, 101, 102, 103, 104],
    );
  });

  test('桌宠对话并进来，同一条不重复，旧句还在', async () => {
    const context = memoryContext();
    assert.equal(await storePetChat(context, [{ role: 'user', content: '在吗', ts: 1 }]), 1);
    const written = await storePetChat(context, [
      { role: 'user', content: '在吗', ts: 1 },
      { role: 'assistant', content: '在的', ts: 2 },
    ]);
    assert.equal(written, 1);
    assert.deepEqual(shown((await context.view()).messages), ['user:在吗', 'assistant:在的']);
    assert.equal(await storePetChat(context, []), 0);
  });

  test('桌宠对话的幂等键和旧代码一字不差；别的角色、空话和同批重复都跳过', () => {
    const before = Date.now();
    const entries = petChatEntries([
      { role: 'user', content: '在吗', ts: 1_700_000_000_000 },
      { role: 'assistant', content: '在的\n有事吗', ts: 1_700_000_000_500 },
      { role: 'user', content: '在吗', ts: 1_700_000_000_000 },
      { role: 'system', content: '不要', ts: 3 } as unknown as PetChatMessage,
      { role: 'user', content: '', ts: 4 },
      { role: 'user', content: '没有时间', ts: 0 },
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['pet:1700000000000:user:在吗', 'pet:1700000000500:assistant:在的\n有事吗', 'pet:0:user:没有时间'],
    );
    assert.deepEqual(
      entries.map((entry) => entry.type === 'message' && entry.message.role),
      ['user', 'assistant', 'user'],
    );
    assert.equal(entries[0]?.at, 1_700_000_000_000);
    assert.ok((entries[2]?.at ?? 0) >= before, '没有时间就用现在');
    assert.ok(entries.every((entry) => entry.source === 'dsh-pet'));
  });

  test('旧表 context_items 迁进 ctx：碎碎念照样合并，键还在，表改名，只迁一次', async () => {
    const db = new DatabaseSync(':memory:');
    legacyTable(db, 'context_items', LEGACY);
    const context = await createYoyoContext({ db, petId: 'main' });
    assert.deepEqual(tables(db), ['context_items_migrated']);
    assert.deepEqual(shown((await context.view()).messages), [
      'assistant:碎碎念：\n在呢\n水记得喝一口哦',
      'user:在吗',
      'assistant:在的',
      'user:今天海淀的天气要说完整，不要砍掉后半句',
    ]);
    const entries = await context.entries();
    assert.deepEqual(
      entries.map((entry) => entry.at),
      [10, 20, 30, 40, 50],
    );
    assert.deepEqual(
      entries.map((entry) => entry.key),
      [undefined, undefined, 'pet:30:user:在吗', 'pet:40:assistant:在的', undefined],
    );

    const store = createSqliteStore({ database: db, prefix: 'ctx_' });
    assert.equal(await migrateLegacyContext(db, store, threadFor('main')), 0);
    assert.equal(await storePetChat(context, [{ role: 'user', content: '在吗', ts: 30 }]), 0, '迁过来的键照样去重');

    const again = await createYoyoContext({ db, petId: 'main' });
    assert.equal((await again.entries()).length, 5);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM context_items_migrated').get() as { n: number }).n, 7);
  });

  test('迁移失败就回滚，旧表留着下次再试', async () => {
    const db = new DatabaseSync(':memory:');
    legacyTable(db, 'context_items', LEGACY);
    const store = createSqliteStore({ database: db, prefix: 'ctx_' });
    const broken = {
      ...store,
      append: async () => {
        throw new Error('磁盘满了');
      },
    };
    await assert.rejects(migrateLegacyContext(db, broken, 'pet:main'), /磁盘满了/);
    assert.deepEqual(tables(db), ['context_items']);
    assert.equal(db.isTransaction, false);
    assert.equal(await migrateLegacyContext(db, store, 'pet:main'), 5);
    assert.deepEqual(tables(db), ['context_items_migrated']);
  });

  test('旧版本又建了 context_items：再迁一次，并进已有的备份表', async () => {
    const db = new DatabaseSync(':memory:');
    legacyTable(db, 'context_items_migrated', LEGACY);
    legacyTable(db, 'context_items', [{ role: 'user', text: '降级以后说的', at: 60 }]);
    const store = createSqliteStore({ database: db, prefix: 'ctx_' });
    assert.equal(await migrateLegacyContext(db, store, 'pet:main'), 1);
    assert.deepEqual(tables(db), ['context_items_migrated']);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM context_items_migrated').get() as { n: number }).n, 8);
  });

  test('没有旧表就什么也不做；新库照样能写能读', async () => {
    const db = new DatabaseSync(':memory:');
    const context = await createYoyoContext({ db, petId: 'main' });
    assert.deepEqual(tables(db), []);
    await recordUser(context, '你好', 1);
    const reopened = await createYoyoContext({ db, petId: 'main' });
    assert.deepEqual(shown((await reopened.view()).messages), ['user:你好']);
    assert.equal((await reopened.entries())[0]?.source, 'yoyo');
    const other = await createYoyoContext({ db, petId: 'other' });
    assert.equal((await other.entries()).length, 0, '别的桌宠是另一条线程');
  });

  test('配了 maxTokens 就从最旧的开始裁，不配就整段带上', async () => {
    const db = new DatabaseSync(':memory:');
    const full = await createYoyoContext({ db, petId: 'main' });
    for (let i = 0; i < 10; i += 1) await recordUser(full, `第${i}句话说得长一点，好占一些预算`, i + 1);
    assert.equal((await full.view()).messages.length, 10);
    const trimmed = await createYoyoContext({ db, petId: 'main', maxTokens: 60 });
    const view = await trimmed.view();
    assert.ok(view.messages.length < 10 && view.messages.length > 0);
    assert.equal(view.messages.at(-1)?.content, '第9句话说得长一点，好占一些预算');
  });

  test('摘要放在最前面，用中文说明', async () => {
    const context = memoryContext();
    await recordUser(context, '很早的问题', 1);
    await recordUser(context, '新问题', 3);
    await context.append({ type: 'summary', text: '主人每天下午喝水', covers: { at: 1, seq: 1 } });
    assert.deepEqual(shown((await context.view()).messages), [
      'user:前面对话的摘要：\n主人每天下午喝水',
      'user:新问题',
    ]);
  });
});
