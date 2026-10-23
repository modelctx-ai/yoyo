import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function pathOf(dataDir) {
  return join(dataDir, 'inbox.jsonl');
}

/** 按键和命令把请求交给正在运行的导演，避免两个进程同时抢桌宠。 */
export function enqueue(dataDir, type) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  appendFileSync(pathOf(dataDir), `${JSON.stringify({ type, at: Date.now() })}\n`, { mode: 0o600 });
}

export function drain(dataDir) {
  const path = pathOf(dataDir);
  if (!existsSync(path)) return [];
  const taken = `${path}.taken`;
  try {
    renameSync(path, taken);
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
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return items;
}
