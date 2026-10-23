import { execFileSync } from 'node:child_process';

import { record } from './activity.js';
import { insertClip, listClips as readClips } from './db.js';

const MAX_CHARS = 2000;

export function readPaste() {
  try {
    return execFileSync('pbpaste', [], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
  } catch {
    return '';
  }
}

export function listClips(dataDir) {
  return readClips(dataDir);
}

/** 和上次不同才记一条。空粘贴板不记。 */
export function notePaste(dataDir, text, now = new Date()) {
  const value = String(text ?? '').replace(/\s+$/g, '');
  if (!value.trim()) return null;
  const clipped = value.slice(0, MAX_CHARS);
  const items = listClips(dataDir);
  if (items[0]?.text === clipped) return null;
  const entry = { text: clipped, at: now.toISOString() };
  insertClip(dataDir, entry);
  record(dataDir, { type: 'clipboard', chars: clipped.length });
  return entry;
}

export function latestClip(dataDir) {
  return listClips(dataDir)[0]?.text ?? '';
}
