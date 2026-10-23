/** 本地日期 `YYYY-MM-DD`。 */
export function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `HH:MM` 换成当天的第几分钟；写得不对返回 null。 */
export function minutesOf(time: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
