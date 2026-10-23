import { randomUUID } from 'node:crypto';

import { localDateKey, minutesOf } from '../../kernel/time.ts';
import { TONE_CUES, toneForHour } from '../../kernel/tone.ts';
import type { Line, Repeat, ScheduleInput, ScheduleItem } from '../../kernel/types.ts';
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

/** 校验后写进库，并记一条 'schedule-add'。`_now` 和 addContact 同形，日程本身不记创建时间。 */
export function addSchedule(
  repos: Pick<Repos, 'schedule' | 'activity'>,
  input: ScheduleInput,
  _now?: Date,
): ScheduleItem {
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
  const item: ScheduleItem = {
    id: `s_${randomUUID().slice(0, 8)}`,
    title,
    kind: input.kind === 'task' ? 'task' : 'alarm',
    time,
    date,
    repeat,
    weekday: repeat === 'weekly' ? (weekday ?? null) : null,
    enabled: true,
    lastFired: null,
  };
  repos.schedule.insert(item);
  repos.activity.record({ type: 'schedule-add', id: item.id, title, kind: item.kind, time, repeat });
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
