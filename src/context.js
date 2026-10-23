import { loadContext as readContext, saveContext as writeContext } from './db.js';

export function loadContext(dataDir) {
  return readContext(dataDir);
}

function saveContext(dataDir, items) {
  writeContext(dataDir, items);
}

/** 只追加，不删。压缩以后再做。 */
export function appendContext(dataDir, event) {
  const items = loadContext(dataDir);
  items.push({
    role: event.role,
    text: event.text,
    at: event.at ?? Date.now(),
    key: event.key,
  });
  saveContext(dataDir, items);
  return items;
}

/**
 * 连续的碎碎念合成一条 assistant 消息。
 * 用户或回复一出现就先把前面的碎碎念收起来，对话原句不合并、不截断。
 */
export function toMessages(items) {
  const messages = [];
  let whispers = [];
  const flush = () => {
    if (whispers.length === 0) return;
    messages.push({ role: 'assistant', content: `碎碎念：\n${whispers.join('\n')}` });
    whispers = [];
  };
  for (const item of items) {
    if (!item?.text) continue;
    if (item.role === 'whisper') {
      whispers.push(item.text);
      continue;
    }
    flush();
    if (item.role === 'user' || item.role === 'assistant') {
      messages.push({ role: item.role, content: item.text });
    }
  }
  flush();
  return messages;
}

/** 把桌宠对话记忆并进来。同一条（时间、角色、原文）不重复记。 */
export function mergePetChat(items, petMessages) {
  const seen = new Set(items.map((item) => item.key).filter(Boolean));
  const next = items.slice();
  for (const message of petMessages ?? []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = String(message.content ?? '');
    if (!text) continue;
    const key = `pet:${message.ts}:${message.role}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ role: message.role, text, at: Number(message.ts) || Date.now(), key });
  }
  next.sort((a, b) => (a.at || 0) - (b.at || 0));
  return next;
}

export function storePetChat(dataDir, petMessages) {
  const items = loadContext(dataDir);
  const merged = mergePetChat(items, petMessages);
  if (merged.length !== items.length) saveContext(dataDir, merged);
  return merged;
}
