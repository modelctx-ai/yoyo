import type { ClipEntry } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';

/** 一条最多记这么多字。 */
export const MAX_CHARS = 2000;

/** 和上次不同才记一条。空粘贴板不记。 */
export function notePaste(
  repos: Pick<Repos, 'clipboard' | 'activity'>,
  text: string,
  now: Date = new Date(),
): ClipEntry | null {
  // trimEnd 去掉的字符和 /\s+$/ 一样，但长空白不会回溯
  const value = String(text ?? '').trimEnd();
  if (!value) return null;
  const clipped = value.slice(0, MAX_CHARS);
  if (repos.clipboard.list(1)[0]?.text === clipped) return null;
  const entry: ClipEntry = { text: clipped, at: now.toISOString() };
  repos.clipboard.insert(entry);
  repos.activity.record({ type: 'clipboard', chars: clipped.length });
  return entry;
}

export function latestClip(repos: Pick<Repos, 'clipboard'>): string {
  return repos.clipboard.list(1)[0]?.text ?? '';
}
