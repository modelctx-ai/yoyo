import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import type { ActivityEvent, ScheduleItem } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';
import {
  GRACE_MS,
  addSchedule,
  dueItems,
  isDue,
  occurrenceKey,
  reminderLine,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  saveFired,
  updateSchedule,
} from './schedule.ts';

function item(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: 's_test',
    title: '喝水',
    kind: 'alarm',
    time: '18:00',
    date: null,
    repeat: 'daily',
    weekday: null,
    enabled: true,
    lastFired: null,
    ...overrides,
  };
}

/** 内存里的日程表和行为记录。 */
function memoryRepos() {
  const items: ScheduleItem[] = [];
  const fired: [string, string][] = [];
  const events: ActivityEvent[] = [];
  const repos: Pick<Repos, 'schedule' | 'activity'> = {
    schedule: {
      list: () => items.toSorted((a, b) => a.time.localeCompare(b.time)),
      insert: (entry) => {
        items.push(entry);
      },
      markFired: (id, occurrence) => {
        fired.push([id, occurrence]);
      },
      update: (next) => {
        const index = items.findIndex((entry) => entry.id === next.id);
        if (index < 0) return false;
        items[index] = next;
        return true;
      },
      remove: (id) => {
        const index = items.findIndex((entry) => entry.id === id);
        if (index < 0) return false;
        items.splice(index, 1);
        return true;
      },
    },
    activity: {
      record: (event) => {
        events.push(event);
      },
      list: () => events.map((event) => ({ ...event, at: new Date(0).toISOString() })),
    },
  };
  return { repos, items, fired, events };
}

const friday = new Date(2026, 9, 23, 18, 1, 0);
const saturday = new Date(2026, 9, 24, 18, 1, 0);

describe('schedule', () => {
  test('每天、工作日、一次性闹钟按日期判断', () => {
    const daily = item({ repeat: 'daily' });
    const weekdays = item({ repeat: 'weekdays' });
    const once = item({ date: '2026-10-23', repeat: null });
    assert.equal(isDue(daily, friday), true);
    assert.equal(isDue(weekdays, friday), true);
    assert.equal(isDue(weekdays, saturday), false);
    assert.equal(isDue(once, friday), true);
    assert.equal(isDue(once, saturday), false);
    assert.equal(isDue({ ...once, lastFired: '2026-10-23T18:00' }, friday), false);
    assert.equal(dueItems([daily, weekdays], saturday).length, 1);
  });

  test('每周闹钟只在指定的那天响', () => {
    const weekly = item({ repeat: 'weekly', weekday: 5 });
    assert.equal(isDue(weekly, friday), true);
    assert.equal(isDue(weekly, saturday), false);
    assert.equal(isDue({ ...weekly, weekday: 6 }, saturday), true);
  });

  test('到点后 15 分钟内算这一次，早了、晚了、关掉了都不响', () => {
    const daily = item();
    assert.equal(GRACE_MS, 15 * 60 * 1000);
    assert.equal(isDue(daily, new Date(2026, 9, 23, 17, 59, 59)), false);
    assert.equal(isDue(daily, new Date(2026, 9, 23, 18, 0, 0)), true);
    assert.equal(isDue(daily, new Date(2026, 9, 23, 18, 15, 0)), true);
    assert.equal(isDue(daily, new Date(2026, 9, 23, 18, 15, 1)), false);
    assert.equal(isDue(daily, new Date(2026, 9, 23, 18, 20, 0), 30 * 60 * 1000), true);
    assert.equal(isDue({ ...daily, enabled: false }, friday), false);
    assert.equal(isDue({ ...daily, time: '25:00' }, friday), false);
    assert.equal(isDue({ ...daily, lastFired: '2026-10-22T18:00' }, friday), true);
    assert.equal(occurrenceKey(daily, friday), '2026-10-23T18:00');
  });

  test('新增日程的校验文案和旧代码一致', () => {
    const { repos, items, events } = memoryRepos();
    const cases: [Parameters<typeof addSchedule>[1], string][] = [
      [{}, '日程要有标题'],
      [{ title: '  ', time: '15:30' }, '日程要有标题'],
      [{ title: '喝水', time: '3点' }, '时间要写成 HH:MM'],
      [{ title: '喝水', time: '15:30', repeat: 'monthly' }, '重复只能是 daily、weekdays 或 weekly'],
      [{ title: '喝水', time: '15:30', repeat: 'weekly' }, 'weekly 要指定 weekday，0 是周日'],
      [{ title: '喝水', time: '15:30', repeat: 'weekly', weekday: 7 }, 'weekly 要指定 weekday，0 是周日'],
      [{ title: '喝水', time: '15:30', repeat: 'weekly', weekday: 1.5 }, 'weekly 要指定 weekday，0 是周日'],
      [{ title: '喝水', time: '15:30' }, '一次性日程要有日期 YYYY-MM-DD'],
      [{ title: '喝水', time: '15:30', repeat: '', date: '2026/10/23' }, '一次性日程要有日期 YYYY-MM-DD'],
    ];
    for (const [input, message] of cases) {
      assert.throws(() => addSchedule(repos, input), { message }, JSON.stringify(input));
    }
    assert.equal(items.length, 0);
    assert.equal(events.length, 0);
  });

  test('新增日程写进库，并记一条 schedule-add', () => {
    const { repos, events } = memoryRepos();
    const alarm = addSchedule(repos, { title: ' 喝水 ', time: ' 15:30 ', repeat: 'daily', kind: 'alarm' });
    assert.match(alarm.id, /^s_[0-9a-f]{8}$/);
    assert.deepEqual(alarm, {
      id: alarm.id,
      title: '喝水',
      kind: 'alarm',
      time: '15:30',
      date: null,
      repeat: 'daily',
      weekday: null,
      enabled: true,
      lastFired: null,
    });
    assert.deepEqual(repos.schedule.list(), [alarm]);
    assert.deepEqual(events, [
      { type: 'schedule-add', id: alarm.id, title: '喝水', kind: 'alarm', time: '15:30', repeat: 'daily' },
    ]);

    const task = addSchedule(repos, { title: '交周报', time: '9:00', date: '2026-10-23', kind: 'task' });
    assert.equal(task.kind, 'task');
    assert.equal(task.date, '2026-10-23');
    assert.equal(task.repeat, null);
    assert.equal(events[1]?.['repeat'], null);

    const weekly = addSchedule(repos, {
      title: '倒垃圾',
      time: '20:00',
      repeat: 'weekly',
      weekday: 0,
      date: '2026-10-23',
    });
    assert.equal(weekly.weekday, 0);
    assert.equal(weekly.date, null);
    assert.equal(weekly.kind, 'alarm');
    assert.notEqual(weekly.id, alarm.id);
    assert.deepEqual(
      repos.schedule.list().map((entry) => entry.title),
      ['喝水', '倒垃圾', '交周报'],
    );
  });

  test('一模一样的已经有了就交回那条，不重复加；差一点的照加', () => {
    const { repos, events } = memoryRepos();
    const first = addSchedule(repos, { title: '开周会', time: '10:00', repeat: 'weekly', weekday: 1 });
    assert.equal(addSchedule(repos, { title: ' 开周会', time: '10:00', repeat: 'weekly', weekday: 1 }), first);
    assert.equal(events.length, 1, '没加就不记');
    assert.notEqual(addSchedule(repos, { title: '开周会', time: '10:00', repeat: 'weekly', weekday: 2 }).id, first.id);
    assert.notEqual(
      addSchedule(repos, { title: '开周会', time: '10:00', repeat: 'weekly', weekday: 1, kind: 'task' }).id,
      first.id,
    );
    assert.equal(repos.schedule.list().length, 3);
  });

  test('删掉日程记一条 schedule-remove；没有这条就是 null', () => {
    const { repos, events } = memoryRepos();
    const alarm = addSchedule(repos, { title: '喝水', time: '15:30', repeat: 'daily' });
    assert.deepEqual(removeSchedule(repos, alarm.id), alarm);
    assert.deepEqual(repos.schedule.list(), []);
    assert.deepEqual(events.at(-1), { type: 'schedule-remove', id: alarm.id, title: '喝水' });
    assert.equal(removeSchedule(repos, alarm.id), null);
    assert.equal(events.length, 2);
  });

  test('改日程：只改写了的项，校验和新增一样，改了时间点清掉 lastFired', () => {
    const { repos, events } = memoryRepos();
    const alarm = addSchedule(repos, { title: '喝水', time: '15:30', repeat: 'daily' });
    repos.schedule.update({ ...alarm, lastFired: '2026-10-23T15:30' });

    const renamed = updateSchedule(repos, alarm.id, { title: ' 喝温水 ' });
    assert.equal(renamed?.title, '喝温水');
    assert.equal(renamed?.lastFired, '2026-10-23T15:30', '只改标题，今天响过了还是响过了');
    assert.deepEqual(events.at(-1), { type: 'schedule-edit', id: alarm.id, title: '喝温水', fields: 'title' });

    const moved = updateSchedule(repos, alarm.id, { time: '16:00', kind: 'task' });
    assert.equal(moved?.time, '16:00');
    assert.equal(moved?.kind, 'task');
    assert.equal(moved?.lastFired, null, '改了时间，新时间当天要响');
    assert.equal(events.at(-1)?.['fields'], 'kind time');
    assert.deepEqual(repos.schedule.list(), [moved]);

    // 每天改成每周要给星期几；改成每周以外的，星期几不留
    assert.throws(() => updateSchedule(repos, alarm.id, { repeat: 'weekly' }), {
      message: 'weekly 要指定 weekday，0 是周日',
    });
    const weekly = updateSchedule(repos, alarm.id, { repeat: 'weekly', weekday: 3 });
    assert.deepEqual([weekly?.repeat, weekly?.weekday, weekly?.date], ['weekly', 3, null]);
    const daily = updateSchedule(repos, alarm.id, { repeat: 'daily' });
    assert.deepEqual([daily?.repeat, daily?.weekday], ['daily', null]);

    // 改成一次性要有日期
    assert.throws(() => updateSchedule(repos, alarm.id, { repeat: null }), {
      message: '一次性日程要有日期 YYYY-MM-DD',
    });
    const once = updateSchedule(repos, alarm.id, { repeat: '', date: '2026-11-01' });
    assert.deepEqual([once?.repeat, once?.date], [null, '2026-11-01']);
    assert.throws(() => updateSchedule(repos, alarm.id, { date: '明天' }), {
      message: '一次性日程要有日期 YYYY-MM-DD',
    });
  });

  test('改日程写错了：库一个字不动，不记；没有这条是 null；没变也不记', () => {
    const { repos, events } = memoryRepos();
    const alarm = addSchedule(repos, { title: '喝水', time: '15:30', repeat: 'daily' });
    const cases: [Parameters<typeof updateSchedule>[2], string][] = [
      [{ title: ' ' }, '日程要有标题'],
      [{ time: '3点' }, '时间要写成 HH:MM'],
      [{ repeat: 'monthly' }, '重复只能是 daily、weekdays 或 weekly'],
      [{ kind: 'noise' }, '类型只能是 alarm 或 task'],
      [{ enabled: 'yes' as unknown as boolean }, 'enabled 只能是 true 或 false'],
    ];
    for (const [patch, message] of cases) {
      assert.throws(() => updateSchedule(repos, alarm.id, patch), { message }, JSON.stringify(patch));
    }
    assert.deepEqual(repos.schedule.list(), [alarm]);
    assert.equal(updateSchedule(repos, 's_nope', { title: '喝水' }), null);
    assert.equal(updateSchedule(repos, alarm.id, { title: '喝水', time: '15:30', enabled: true }), alarm);
    assert.equal(events.length, 1, '只有加的那一条');
  });

  test('暂停和恢复：记 schedule-pause、schedule-resume；暂停的到点不响，恢复了又响；已经是那样就不记', () => {
    const { repos, events } = memoryRepos();
    const alarm = addSchedule(repos, { title: '喝水', time: '18:00', repeat: 'daily' });
    const paused = pauseSchedule(repos, alarm.id);
    assert.equal(paused?.enabled, false);
    assert.deepEqual(events.at(-1), { type: 'schedule-pause', id: alarm.id, title: '喝水' });
    assert.equal(dueItems(repos.schedule.list(), friday).length, 0, '暂停的不响');
    assert.equal(pauseSchedule(repos, alarm.id), paused);
    assert.equal(events.length, 2, '已经暂停了，再暂停不记');

    // 暂停的也能改，改完还是暂停
    assert.equal(updateSchedule(repos, alarm.id, { title: '喝水啦' })?.enabled, false);
    assert.equal(events.at(-1)?.['type'], 'schedule-edit');

    const resumed = resumeSchedule(repos, alarm.id);
    assert.equal(resumed?.enabled, true);
    assert.deepEqual(events.at(-1), { type: 'schedule-resume', id: alarm.id, title: '喝水啦' });
    assert.equal(dueItems(repos.schedule.list(), friday).length, 1, '恢复了又响');
    assert.equal(pauseSchedule(repos, 's_nope'), null);
    assert.equal(resumeSchedule(repos, 's_nope'), null);

    // 一次改字段又暂停：各记一条
    updateSchedule(repos, alarm.id, { time: '19:00', enabled: false });
    assert.deepEqual(
      events.slice(-2).map((event) => event.type),
      ['schedule-edit', 'schedule-pause'],
    );
  });

  test('响过以后只标记这一次', () => {
    const { repos, fired } = memoryRepos();
    saveFired(repos, item({ id: 's_a1b2c3d4' }), friday);
    assert.deepEqual(fired, [['s_a1b2c3d4', '2026-10-23T18:00']]);
  });

  test('提醒台词：任务前面加「到点了。」，闹钟原样念', () => {
    assert.deepEqual(reminderLine(item({ kind: 'task', title: '交周报' }), friday), {
      text: '到点了。交周报',
      tone: 'warm',
      cue: '[relaxed]',
      action: '碎碎念-对屏碎碎念',
      kind: 'reminder',
    });
    assert.deepEqual(reminderLine(item({ title: '喝水', time: '10:00' }), new Date(2026, 9, 23, 10, 0)), {
      text: '喝水',
      tone: 'brisk',
      cue: '[confident]',
      action: '碎碎念-对屏碎碎念',
      kind: 'reminder',
    });
  });
});
