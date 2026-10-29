import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vite-plus/test';

import type { ScheduleItem } from '../kernel/types.ts';
import { openDatabase } from './db.ts';
import { createRepos } from './repos.ts';

function fresh(clock?: () => Date) {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'yoyo.db'));
  return { db, repos: createRepos(db, clock) };
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

describe('createRepos', () => {
  test('联系人按创建时间排序', () => {
    const { repos } = fresh();
    const later = {
      id: 'c_2',
      name: '小李',
      yoyo: 'yoyo://xiaoli@example',
      note: '',
      createdAt: '2026-02-01T00:00:00.000Z',
    };
    const earlier = {
      id: 'c_1',
      name: '小王',
      yoyo: 'yoyo://xiaowang@example',
      note: '同事',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    repos.contacts.insert(later);
    repos.contacts.insert(earlier);
    assert.deepEqual(repos.contacts.list(), [earlier, later]);
    assert.equal(repos.contacts.remove(later.id), true);
    assert.equal(repos.contacts.remove(later.id), false);
    assert.deepEqual(repos.contacts.list(), [earlier]);
  });

  test('日程按时间排序，响过以后只改那一条的 lastFired', () => {
    const { repos } = fresh();
    const daily: ScheduleItem = {
      id: 's_1',
      title: '下班',
      kind: 'alarm',
      time: '18:00',
      date: null,
      repeat: 'daily',
      weekday: null,
      enabled: true,
      lastFired: null,
    };
    const once: ScheduleItem = {
      id: 's_2',
      title: '交周报',
      kind: 'task',
      time: '09:30',
      date: '2026-10-23',
      repeat: null,
      weekday: null,
      enabled: false,
      lastFired: null,
    };
    const weekly: ScheduleItem = { ...daily, id: 's_3', title: '周会', time: '10:00', repeat: 'weekly', weekday: 1 };
    repos.schedule.insert(daily);
    repos.schedule.insert(once);
    repos.schedule.insert(weekly);
    assert.deepEqual(repos.schedule.list(), [once, weekly, daily]);

    repos.schedule.markFired('s_1', '2026-10-23T18:00');
    assert.deepEqual(repos.schedule.list(), [once, weekly, { ...daily, lastFired: '2026-10-23T18:00' }]);

    assert.equal(repos.schedule.remove('s_3'), true);
    assert.equal(repos.schedule.remove('s_3'), false);
    assert.deepEqual(
      repos.schedule.list().map((item) => item.id),
      ['s_2', 's_1'],
    );
  });

  test('粘贴板最新的在前，只留最近 50 条', () => {
    const { db, repos } = fresh();
    for (let i = 1; i <= 55; i += 1) {
      repos.clipboard.insert({ text: `第${i}条`, at: new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString() });
    }
    const all = repos.clipboard.list();
    assert.equal(all.length, 50);
    assert.deepEqual(all[0], { text: '第55条', at: '2026-10-23T00:55:00.000Z' });
    assert.equal(all.at(-1)?.text, '第6条');
    assert.deepEqual(
      repos.clipboard.list(3).map((entry) => entry.text),
      ['第55条', '第54条', '第53条'],
    );
    assert.equal(count(db, 'clipboard'), 50);
  });

  test('表情包整包写入、整包替换，顺序照写入的来', () => {
    const { repos } = fresh();
    assert.equal(repos.memes.read(), null);
    const first = {
      fetchedAt: '2026-10-23T01:00:00.000Z',
      query: '可爱表情包 png',
      items: [{ url: 'https://example.com/z.png' }, { url: 'https://example.com/a.png' }],
    };
    repos.memes.write(first);
    assert.deepEqual(repos.memes.read(), first);
    const second = {
      fetchedAt: '2026-10-23T07:00:00.000Z',
      query: '可爱表情包 png',
      items: [{ url: 'https://example.com/b.gif' }],
    };
    repos.memes.write(second);
    assert.deepEqual(repos.memes.read(), second);
    const empty = { fetchedAt: '2026-10-23T08:00:00.000Z', query: '可爱表情包 png', items: [] };
    repos.memes.write(empty);
    assert.deepEqual(repos.memes.read(), empty);
  });

  test('行为记录按时间从旧到新，type 以外的字段进 payload，undefined 不写', () => {
    let minute = 0;
    const { db, repos } = fresh(() => new Date(Date.UTC(2026, 9, 23, 9, minute++)));
    repos.activity.record({ type: 'lively', action: '写代码', text: '在呢', meme: undefined });
    repos.activity.record({ type: 'sfx', action: '写代码' });
    repos.activity.record({ type: 'listen', text: '今天下雨吗', chars: 5, ok: true, none: null });

    assert.deepEqual(repos.activity.list(), [
      { at: '2026-10-23T09:00:00.000Z', type: 'lively', action: '写代码', text: '在呢' },
      { at: '2026-10-23T09:01:00.000Z', type: 'sfx', action: '写代码' },
      { at: '2026-10-23T09:02:00.000Z', type: 'listen', text: '今天下雨吗', chars: 5, ok: true, none: null },
    ]);
    assert.deepEqual(
      repos.activity.list(2).map((event) => event.type),
      ['sfx', 'listen'],
    );
    const raw = db.prepare('SELECT type, payload FROM activity ORDER BY id LIMIT 1').get();
    assert.equal(raw?.type, 'lively');
    assert.equal(raw?.payload, '{"action":"写代码","text":"在呢"}');
  });

  test('行为记录缺省只取最近 20 条', () => {
    const { repos } = fresh();
    for (let i = 0; i < 25; i += 1) repos.activity.record({ type: 'tick', n: i });
    const recent = repos.activity.list();
    assert.equal(recent.length, 20);
    assert.equal(recent[0]?.n, 5);
    assert.equal(recent.at(-1)?.n, 24);
  });

  test('说过的句子只留窗口内的，同一句记最新的时间', () => {
    const { db, repos } = fresh();
    const windowMs = 10_000;
    repos.spoken.remember('早', 0, windowMs);
    repos.spoken.remember('喝水', 5_000, windowMs);
    assert.deepEqual(repos.spoken.recent(9_999, windowMs), [
      { text: '早', at: 0 },
      { text: '喝水', at: 5_000 },
    ]);
    assert.deepEqual(repos.spoken.recent(10_000, windowMs), [{ text: '喝水', at: 5_000 }]);

    repos.spoken.remember('伸个懒腰', 12_000, windowMs);
    assert.equal(count(db, 'spoken'), 2, '窗口外的「早」已经删掉');
    repos.spoken.remember('喝水', 13_000, windowMs);
    assert.deepEqual(repos.spoken.recent(13_000, windowMs), [
      { text: '伸个懒腰', at: 12_000 },
      { text: '喝水', at: 13_000 },
    ]);
  });

  test('kv 读写，没有的键返回 null', () => {
    const { repos } = fresh();
    assert.equal(repos.kv.get('place'), null);
    repos.kv.set('place', '{"name":"北京"}');
    repos.kv.set('place', '{"name":"上海"}');
    assert.equal(repos.kv.get('place'), '{"name":"上海"}');
  });

  test('本地任务按写入顺序', () => {
    const { db, repos } = fresh();
    assert.deepEqual(repos.tasks.list(), []);
    const insert = db.prepare('INSERT INTO tasks (text) VALUES (?)');
    insert.run('修天气地点');
    insert.run('写测试');
    assert.deepEqual(repos.tasks.list(), ['修天气地点', '写测试']);
  });

  test('没建表的库也能直接用', () => {
    const repos = createRepos(new DatabaseSync(':memory:'));
    repos.kv.set('channel-base', 'http://127.0.0.1:4000/v1');
    assert.equal(repos.kv.get('channel-base'), 'http://127.0.0.1:4000/v1');
    assert.deepEqual(repos.clipboard.list(), []);
  });
});
