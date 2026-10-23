import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { InboxMessage, InboxRequest } from '../kernel/types.ts';

/** 按键和命令把请求交给正在运行的导演，避免两个进程同时抢桌宠。 */
export function enqueue(inboxFile: string, type: InboxRequest): void {
  mkdirSync(dirname(inboxFile), { recursive: true, mode: 0o700 });
  appendFileSync(inboxFile, `${JSON.stringify({ type, at: Date.now() })}\n`, { mode: 0o600 });
}

function messageOf(raw: unknown): InboxMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, at } = raw as { type?: unknown; at?: unknown };
  if (type !== 'listen' && type !== 'whisper') return null;
  return typeof at === 'number' ? { type, at } : { type };
}

/** 一次取走全部请求。先改名再读，取的时候新写进来的留给下一轮。 */
export function drain(inboxFile: string): InboxMessage[] {
  if (!existsSync(inboxFile)) return [];
  const taken = `${inboxFile}.taken`;
  try {
    renameSync(inboxFile, taken);
  } catch {
    return [];
  }
  let raw = '';
  try {
    raw = readFileSync(taken, 'utf8');
  } catch {
    raw = '';
  }
  try {
    unlinkSync(taken);
  } catch {
    /* 取走后删不掉，下一轮也不会再读它 */
  }
  const items: InboxMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = messageOf(JSON.parse(line));
      if (message) items.push(message);
    } catch {
      /* 坏行跳过 */
    }
  }
  return items;
}

export function writePid(pidFile: string): void {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
}

/** pid 文件里的进程还活着，就当导演在跑。 */
export function directorAlive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  let pid = 0;
  try {
    pid = Number(readFileSync(pidFile, 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
