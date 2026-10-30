import { randomUUID } from 'node:crypto';

import { localDateKey, minutesOf } from '../../kernel/time.ts';
import { TONE_CUES, toneForHour } from '../../kernel/tone.ts';
import type { Line, Repeat, ScheduleInput, ScheduleItem, ScheduleKind, SchedulePatch } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';

/** 到点以后多久之内还算这一次。 */
export const GRACE_MS = 15 * 60 * 1000;

function onThisDay(item: ScheduleItem, now: Date): boolean {
  if (item.repeat === 'daily') return true;
  if (item.repeat === 'weekdays') return now.getDay() >= 1 && now.getDay() <= 5;
  if (item.repeat === 'weekly') return now.getDay() === item.weekday;
  return item.date === localDateKey(now);
}

export function occurrenceKey(item: ScheduleItem, now: Date): string {
  return `${localDateKey(now)}T${item.time}`;
}

/** 到点后 15 分钟内还没响过，就算这次该响。过了窗口就不再补。 */
export function isDue(item: ScheduleItem, now: Date, graceMs = GRACE_MS): boolean {
  if (!item.enabled) return false;
  const minutes = minutesOf(item.time);
  if (minutes === null) return false;
  if (!onThisDay(item, now)) return false;
  const fire = new Date(now);
  fire.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  const late = now.getTime() - fire.getTime();
  if (late < 0 || late > graceMs) return false;
  return item.lastFired !== occurrenceKey(item, now);
}

export function dueItems(items: readonly ScheduleItem[], now: Date): ScheduleItem[] {
  return items.filter((item) => isDue(item, now));
}

function repeatOf(value: string | null | undefined): Repeat | null {
  if (!value) return null;
  if (value === 'daily' || value === 'weekdays' || value === 'weekly') return value;
  throw new Error('重复只能是 daily、weekdays 或 weekly');
}

interface Fields {
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly time: string;
  readonly date: string | null;
  readonly repeat: Repeat | null;
  readonly weekday: number | null;
}

/** 加和改共用的校验：去空白、查时间和日期，重复的日程不留日期，每周以外的不留星期几。 */
function checked(input: ScheduleInput): Fields {
  const title = (input.title ?? '').trim();
  const time = (input.time ?? '').trim();
  if (!title) throw new Error('日程要有标题');
  if (minutesOf(time) === null) throw new Error('时间要写成 HH:MM');
  const repeat = repeatOf(input.repeat);
  const weekday = input.weekday;
  if (repeat === 'weekly' && (weekday === undefined || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
    throw new Error('weekly 要指定 weekday，0 是周日');
  }
  const date = repeat ? null : (input.date ?? '');
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('一次性日程要有日期 YYYY-MM-DD');
  const kind = input.kind === 'task' ? 'task' : 'alarm';
  return { title, kind, time, date, repeat, weekday: repeat === 'weekly' ? (weekday ?? null) : null };
}

/** 校验后写进库，并记一条 'schedule-add'；一模一样的已经有了就交回那条，不重复加。`_now` 和 addContact 同形，日程本身不记创建时间。 */
export function addSchedule(
  repos: Pick<Repos, 'schedule' | 'activity'>,
  input: ScheduleInput,
  _now?: Date,
): ScheduleItem {
  const fields = checked(input);
  // 同一条已经有了（例如两个子任务同时加）：不重复加，交回原来那条
  const same = repos.schedule
    .list()
    .find((entry) => entry.enabled && FIELD_NAMES.every((name) => entry[name] === fields[name]));
  if (same) return same;
  const item: ScheduleItem = { id: `s_${randomUUID().slice(0, 8)}`, ...fields, enabled: true, lastFired: null };
  repos.schedule.insert(item);
  repos.activity.record({
    type: 'schedule-add',
    id: item.id,
    title: item.title,
    kind: item.kind,
    time: item.time,
    repeat: item.repeat,
  });
  return item;
}

const FIELD_NAMES = ['title', 'kind', 'time', 'date', 'repeat', 'weekday'] as const;

/** 这几项变了，新的时间点当天才该响：清掉「最近响过」的记号。 */
const WHEN_FIELDS = ['time', 'date', 'repeat', 'weekday'] as const;

/**
 * 改一条日程：没写的项不动，校验和 `addSchedule` 一样。改了时间点（时间、日期、重复、星期几）的清掉 `lastFired`，
 * 免得新时间当天不响。改了字段记 'schedule-edit'（带改了哪几项），`enabled` 变了记 'schedule-pause' 或 'schedule-resume'；
 * 什么都没变就原样交回，不记。没有这条返回 null，写得不对抛带中文说明的错，库一个字不动。
 */
export function updateSchedule(
  repos: Pick<Repos, 'schedule' | 'activity'>,
  id: string,
  patch: SchedulePatch,
): ScheduleItem | null {
  const item = repos.schedule.list().find((entry) => entry.id === id);
  if (!item) return null;
  if (patch.kind !== undefined && patch.kind !== 'alarm' && patch.kind !== 'task') {
    throw new Error('类型只能是 alarm 或 task');
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
    throw new Error('enabled 只能是 true 或 false');
  const fields = checked({
    title: patch.title ?? item.title,
    time: patch.time ?? item.time,
    date: patch.date === undefined ? item.date : patch.date,
    repeat: patch.repeat === undefined ? item.repeat : patch.repeat,
    weekday: (patch.weekday === undefined ? item.weekday : patch.weekday) ?? undefined,
    kind: patch.kind ?? item.kind,
  });
  const changed = FIELD_NAMES.filter((name) => item[name] !== fields[name]);
  const enabled = patch.enabled ?? item.enabled;
  if (changed.length === 0 && enabled === item.enabled) return item;
  const next: ScheduleItem = {
    ...item,
    ...fields,
    enabled,
    lastFired: WHEN_FIELDS.some((name) => changed.includes(name)) ? null : item.lastFired,
  };
  repos.schedule.update(next);
  if (changed.length > 0)
    repos.activity.record({ type: 'schedule-edit', id, title: next.title, fields: changed.join(' ') });
  if (enabled !== item.enabled) {
    repos.activity.record({ type: enabled ? 'schedule-resume' : 'schedule-pause', id, title: next.title });
  }
  return next;
}

/** 暂停：到点不响，日程还留着。已经是暂停的原样交回。没有这条返回 null。 */
export function pauseSchedule(repos: Pick<Repos, 'schedule' | 'activity'>, id: string): ScheduleItem | null {
  return updateSchedule(repos, id, { enabled: false });
}

/** 恢复暂停的日程。没有这条返回 null。 */
export function resumeSchedule(repos: Pick<Repos, 'schedule' | 'activity'>, id: string): ScheduleItem | null {
  return updateSchedule(repos, id, { enabled: true });
}

/** 删掉一条日程，记一条 'schedule-remove'。没有这条返回 null。 */
export function removeSchedule(repos: Pick<Repos, 'schedule' | 'activity'>, id: string): ScheduleItem | null {
  const item = repos.schedule.list().find((entry) => entry.id === id);
  if (!item || !repos.schedule.remove(id)) return null;
  repos.activity.record({ type: 'schedule-remove', id, title: item.title });
  return item;
}

export function saveFired(repos: Pick<Repos, 'schedule'>, item: ScheduleItem, now: Date): void {
  repos.schedule.markFired(item.id, occurrenceKey(item, now));
}

/** kind 'reminder'；task 前面加「到点了。」；action '碎碎念-对屏碎碎念'；tone 按钟点；cue = TONE_CUES[tone]。 */
export function reminderLine(item: ScheduleItem, now: Date): Line {
  const tone = toneForHour(now.getHours());
  return {
    text: item.kind === 'task' ? `到点了。${item.title}` : item.title,
    tone,
    cue: TONE_CUES[tone],
    action: '碎碎念-对屏碎碎念',
    kind: 'reminder',
  };
}
