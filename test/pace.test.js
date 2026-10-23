import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addContact, listContacts } from '../src/contacts.js';
import { nextWhisperAt } from '../src/pace.js';
import { addSchedule, dueItems, isDue, listSchedule } from '../src/schedule.js';
import { decorateMeme, extractImageUrls, packIsStale } from '../src/memes.js';
import { sceneFor } from '../src/sfx.js';

describe('pace, schedule, contacts, sfx', () => {
  test('对话一出现，碎碎念就顺延到结束后 30 秒，再说话就再顺延', () => {
    const scheduled = 1_000;
    assert.equal(nextWhisperAt(scheduled, 900, 1_000), 900 + 30_000);
    assert.equal(nextWhisperAt(900 + 30_000, 20_000, 20_000), 20_000 + 30_000);
    assert.equal(nextWhisperAt(80_000, 1_000, 80_000), 80_000);
  });

  test('每天、工作日、一次性闹钟按日期判断', () => {
    const friday = new Date(2026, 9, 23, 18, 1, 0);
    const daily = { enabled: true, time: '18:00', repeat: 'daily', lastFired: null };
    const weekdays = { enabled: true, time: '18:00', repeat: 'weekdays', lastFired: null };
    const once = { enabled: true, time: '18:00', date: '2026-10-23', repeat: null, lastFired: null };
    const saturday = new Date(2026, 9, 24, 18, 1, 0);
    assert.equal(isDue(daily, friday), true);
    assert.equal(isDue(weekdays, friday), true);
    assert.equal(isDue(weekdays, saturday), false);
    assert.equal(isDue(once, friday), true);
    assert.equal(isDue({ ...once, lastFired: '2026-10-23T18:00' }, friday), false);
    assert.equal(dueItems([daily, weekdays], saturday).length, 1);
  });

  test('联系人和日程能写进目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-'));
    const contact = addContact(dir, { name: '小王', yoyo: 'yoyo://xiaowang@example', note: '同事' });
    assert.equal(listContacts(dir)[0].id, contact.id);
    const alarm = addSchedule(dir, { title: '喝水', time: '15:30', repeat: 'daily', kind: 'alarm' });
    assert.equal(listSchedule(dir)[0].title, alarm.title);
  });

  test('没事干时记下的图，有时配上碎碎念', () => {
    const text = '看这张 https://example.com/a.png 还有 https://example.com/a.png 和 https://example.com/b.jpg';
    assert.deepEqual(extractImageUrls(text), ['https://example.com/a.png', 'https://example.com/b.jpg']);
    const pack = { items: [{ url: 'https://example.com/a.png' }] };
    const line = { text: '在呢', action: '照镜子' };
    assert.equal(decorateMeme(line, pack, () => 0).imageUrl, 'https://example.com/a.png');
    assert.equal(decorateMeme({ ...line, kind: 'weather' }, pack, () => 0).imageUrl, undefined);
    assert.equal(decorateMeme(line, pack, () => 0.9).imageUrl, undefined);
    assert.equal(packIsStale(null, 1_000), true);
    assert.equal(packIsStale({ fetchedAt: new Date(0).toISOString(), items: pack.items }, 60_000), false);
  });

  test('动作配上对应的轻声场景', () => {
    assert.equal(sceneFor('写代码'), 'keys');
    assert.equal(sceneFor('超大伸懒腰'), 'stretch');
    assert.equal(sceneFor('碎碎念-发呆碎碎念'), 'rest');
    assert.equal(sceneFor('碎碎念-对屏碎碎念'), 'murmur');
  });
});
