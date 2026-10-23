import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ActivityEvent, ClipEntry } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';
import { MAX_CHARS, latestClip, notePaste } from './clipboard.ts';

/** 内存里的复制历史（新的在前，最多 50 条）和行为记录。 */
function memoryRepos() {
  const clips: ClipEntry[] = [];
  const events: ActivityEvent[] = [];
  const repos: Pick<Repos, 'clipboard' | 'activity'> = {
    clipboard: {
      list: (limit = 50) => clips.slice(0, Math.min(limit, 50)),
      insert: (entry) => {
        clips.unshift(entry);
        clips.splice(50);
      },
    },
    activity: {
      record: (event) => {
        events.push(event);
      },
      list: () => events.map((event) => ({ ...event, at: new Date(0).toISOString() })),
    },
  };
  return { repos, clips, events };
}

describe('clipboard', () => {
  test('粘贴板内容变了才记一条', () => {
    const { repos } = memoryRepos();
    assert.ok(notePaste(repos, '第一段'));
    assert.equal(notePaste(repos, '第一段'), null);
    assert.ok(notePaste(repos, '第二段'));
    assert.ok(notePaste(repos, '第一段'));
  });

  test('空白不记，尾部空白去掉，太长的截到 2000 字', () => {
    const { repos, clips, events } = memoryRepos();
    const now = new Date('2026-10-23T09:30:00.000Z');
    assert.equal(notePaste(repos, ' \n\t ', now), null);
    assert.equal(notePaste(repos, '', now), null);
    assert.deepEqual(notePaste(repos, '  一段话 \n\n', now), { text: '  一段话', at: '2026-10-23T09:30:00.000Z' });
    assert.equal(notePaste(repos, '  一段话\n', now), null);
    const long = notePaste(repos, '字'.repeat(MAX_CHARS + 10), now);
    assert.equal(MAX_CHARS, 2000);
    assert.equal(long?.text.length, MAX_CHARS);
    assert.equal(clips.length, 2);
    assert.deepEqual(events, [
      { type: 'clipboard', chars: 5 },
      { type: 'clipboard', chars: 2000 },
    ]);
  });

  test('最新一条复制内容，没有就是空字符串', () => {
    const { repos } = memoryRepos();
    assert.equal(latestClip(repos), '');
    notePaste(repos, '第一段');
    notePaste(repos, '第二段');
    assert.equal(latestClip(repos), '第二段');
  });
});
