import { randomUUID } from 'node:crypto';

import { record } from './activity.js';
import { listSchedule as readSchedule, replaceSchedule } from './db.js';

const GRACE_MS = 15 * 60 * 1000;

export function listSchedule(dataDir) {
  return readSchedule(dataDir);
}

function writeSchedule(dataDir, items) {
  replaceSchedule(dataDir, items);
}

export function localDateKey(now) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function minutesOf(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function onThisDay(item, now) {
  if (item.repeat === 'daily') return true;
  if (item.repeat === 'weekdays') return now.getDay() >= 1 && now.getDay() <= 5;
  if (item.repeat === 'weekly') return now.getDay() === item.weekday;
  return item.date === localDateKey(now);
}

export function occurrenceKey(item, now) {
  return `${localDateKey(now)}T${item.time}`;
}

/** 到点后 15 分钟内还没响过，就算这次该响。过了窗口就不再补。 */
export function isDue(item, now, graceMs = GRACE_MS) {
  if (!item?.enabled) return false;
  if (minutesOf(item.time) === null) return false;
  if (!onThisDay(item, now)) return false;
  const fire = new Date(now);
  const minutes = minutesOf(item.time);
  fire.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (now < fire || now - fire > graceMs) return false;
  return item.lastFired !== occurrenceKey(item, now);
}

export function dueItems(items, now) {
  return items.filter((item) => isDue(item, now));
}

export function markFired(items, item, now) {
  const key = occurrenceKey(item, now);
  return items.map((current) => (current.id === item.id ? { ...current, lastFired: key } : current));
}

export function addSchedule(dataDir, input, now = new Date()) {
  const title = String(input.title ?? '').trim();
  const time = String(input.time ?? '').trim();
  if (!title) throw new Error('日程要有标题');
  if (minutesOf(time) === null) throw new Error('时间要写成 HH:MM');
  const repeat = input.repeat || null;
  if (repeat && !['daily', 'weekdays', 'weekly'].includes(repeat)) throw new Error('重复只能是 daily、weekdays 或 weekly');
  if (repeat === 'weekly' && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) {
    throw new Error('weekly 要指定 weekday，0 是周日');
  }
  if (!repeat && !/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('一次性日程要有日期 YYYY-MM-DD');
  const item = {
    id: `s_${randomUUID().slice(0, 8)}`,
    title,
    kind: input.kind === 'task' ? 'task' : 'alarm',
    time,
    date: repeat ? null : input.date,
    repeat,
    weekday: repeat === 'weekly' ? input.weekday : null,
    enabled: true,
    lastFired: null,
  };
  writeSchedule(dataDir, [...listSchedule(dataDir), item]);
  record(dataDir, { type: 'schedule-add', id: item.id, title, kind: item.kind, time, repeat });
  return item;
}

export function saveFired(dataDir, item, now) {
  writeSchedule(dataDir, markFired(listSchedule(dataDir), item, now));
}
