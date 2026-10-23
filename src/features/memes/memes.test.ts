import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import type { ActivityEvent, Line, MemePack } from '../../kernel/types.ts';
import type { Repos, WebSearch } from '../../ports/index.ts';
import { MEME_QUERY, decorateMeme, extractImageUrls, packIsStale, refreshMemes } from './memes.ts';

const HOUR = 60 * 60 * 1000;

/** 内存里的表情包套餐和行为记录。 */
function memoryRepos(initial: MemePack | null = null) {
  let pack = initial;
  const writes: MemePack[] = [];
  const events: ActivityEvent[] = [];
  const repos: Pick<Repos, 'memes' | 'activity'> = {
    memes: {
      read: () => pack,
      write: (next) => {
        pack = next;
        writes.push(next);
      },
    },
    activity: {
      record: (event) => {
        events.push(event);
      },
      list: () => events.map((event) => ({ ...event, at: new Date(0).toISOString() })),
    },
  };
  return { repos, writes, events };
}

/** 假的搜索：记下每次查询，回一段带图的文字。 */
function fakeSearch(text: string) {
  const calls: [string, { readonly maxResults?: number } | undefined][] = [];
  const search: WebSearch = {
    search: async (query, options) => {
      calls.push([query, options]);
      return text;
    },
  };
  return { search, calls };
}

const whisper: Line = { text: '在呢', tone: 'lively', cue: '[happy]', action: '照镜子', kind: 'whisper' };

describe('memes', () => {
  test('没事干时记下的图，有时配上碎碎念', () => {
    const text = '看这张 https://example.com/a.png 还有 https://example.com/a.png 和 https://example.com/b.jpg';
    assert.deepEqual(extractImageUrls(text), ['https://example.com/a.png', 'https://example.com/b.jpg']);
    const pack: MemePack = {
      fetchedAt: new Date(0).toISOString(),
      query: MEME_QUERY,
      items: [{ url: 'https://example.com/a.png' }],
    };
    assert.equal(decorateMeme(whisper, pack, () => 0).imageUrl, 'https://example.com/a.png');
    assert.equal(decorateMeme({ ...whisper, kind: 'weather' }, pack, () => 0).imageUrl, undefined);
    assert.equal(decorateMeme(whisper, pack, () => 0.9).imageUrl, undefined);
    assert.equal(packIsStale(null, 1_000), true);
    assert.equal(packIsStale(pack, 60_000), false);
  });

  test('图片地址去重，最多 12 个，只认 https 图片', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://img.example/${i}.webp`).join(' ');
    assert.equal(extractImageUrls(many).length, 12);
    assert.deepEqual(extractImageUrls('http://a.example/x.png ![](https://b.example/y.GIF) https://c.example/z.txt'), [
      'https://b.example/y.GIF',
    ]);
    assert.deepEqual(extractImageUrls(''), []);
  });

  test('空套餐 1 小时后再找，有图的套餐 6 小时后再换', () => {
    const empty: MemePack = { fetchedAt: new Date(0).toISOString(), query: MEME_QUERY, items: [] };
    const full: MemePack = { ...empty, items: [{ url: 'https://example.com/a.png' }] };
    assert.equal(packIsStale(empty, HOUR), false);
    assert.equal(packIsStale(empty, HOUR + 1), true);
    assert.equal(packIsStale(full, HOUR + 1), false);
    assert.equal(packIsStale(full, 6 * HOUR + 1), true);
    assert.equal(packIsStale({ ...full, fetchedAt: '不是时间' }, 0), true);
    assert.equal(packIsStale(full, 2 * HOUR, HOUR, HOUR), true);
  });

  test('提醒和天气不带图，没有图也不带', () => {
    const pack: MemePack = {
      fetchedAt: new Date(0).toISOString(),
      query: MEME_QUERY,
      items: [{ url: 'https://example.com/a.png' }],
    };
    const reminder: Line = { ...whisper, kind: 'reminder' };
    assert.equal(
      decorateMeme(reminder, pack, () => 0),
      reminder,
    );
    assert.equal(decorateMeme({ ...whisper, kind: 'generated' }, pack, () => 0).imageUrl, 'https://example.com/a.png');
    assert.equal(
      decorateMeme(whisper, null, () => 0),
      whisper,
    );
    assert.equal(
      decorateMeme(whisper, { ...pack, items: [] }, () => 0),
      whisper,
    );
  });

  test('没有搜索就用现有的套餐', async () => {
    const current: MemePack = { fetchedAt: new Date(0).toISOString(), query: MEME_QUERY, items: [] };
    const { repos, writes } = memoryRepos(current);
    assert.equal(await refreshMemes({ repos, search: null }, new Date(10 * HOUR), { force: true }), current);
    assert.equal(writes.length, 0);
  });

  test('没过期不搜；过期或强制就搜 5 条，写库并记 meme-pack', async () => {
    const fresh: MemePack = {
      fetchedAt: new Date(0).toISOString(),
      query: MEME_QUERY,
      items: [{ url: 'https://example.com/old.png' }],
    };
    const { repos, writes, events } = memoryRepos(fresh);
    const { search, calls } = fakeSearch('找到了 https://example.com/a.png\nhttps://example.com/b.gif');

    assert.equal(await refreshMemes({ repos, search }, new Date(HOUR)), fresh);
    assert.equal(calls.length, 0);

    const forced = await refreshMemes({ repos, search }, new Date(HOUR), { force: true });
    assert.deepEqual(forced, {
      fetchedAt: new Date(HOUR).toISOString(),
      query: '可爱表情包 png',
      items: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.gif' }],
    });
    assert.deepEqual(calls, [['可爱表情包 png', { maxResults: 5 }]]);
    assert.deepEqual(writes, [forced]);
    assert.deepEqual(events, [{ type: 'meme-pack', count: 2, query: '可爱表情包 png' }]);

    const later = await refreshMemes({ repos, search }, new Date(8 * HOUR));
    assert.equal(calls.length, 2);
    assert.equal(later?.fetchedAt, new Date(8 * HOUR).toISOString());
    assert.equal(writes.length, 2);
  });

  test('还没有套餐时直接去搜', async () => {
    const { repos, events } = memoryRepos(null);
    const { search } = fakeSearch('什么图都没有');
    const pack = await refreshMemes({ repos, search }, new Date(HOUR));
    assert.deepEqual(pack?.items, []);
    assert.deepEqual(events, [{ type: 'meme-pack', count: 0, query: MEME_QUERY }]);
  });
});
