import { record } from './activity.js';
import { readPack as readPackRow, writePack as writePackRow } from './db.js';

const IMAGE = /https:\/\/[^\s)'"<>]+\.(?:png|jpe?g|gif|webp)/gi;

export function extractImageUrls(text) {
  const found = String(text ?? '').match(IMAGE) ?? [];
  const urls = [];
  for (const raw of found) {
    const url = raw.replace(/[),.;]+$/, '');
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= 12) break;
  }
  return urls;
}

export function packIsStale(pack, now, emptyWaitMs = 60 * 60 * 1000, fullWaitMs = 6 * 60 * 60 * 1000) {
  const fetched = Date.parse(pack?.fetchedAt ?? '');
  const age = Number.isNaN(fetched) ? Infinity : now - fetched;
  if (!pack?.items?.length) return age > emptyWaitMs;
  return age > fullWaitMs;
}

/** 大约四成的碎碎念带一张图。天气和闹钟不带。 */
export function decorateMeme(line, pack, rand = Math.random) {
  if (!line || line.kind === 'weather' || line.kind === 'reminder') return line;
  if (rand() >= 0.4) return line;
  const items = Array.isArray(pack?.items) ? pack.items : [];
  if (items.length === 0) return line;
  const meme = items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
  if (!meme?.url) return line;
  return { ...line, imageUrl: meme.url };
}

export function readPack(dataDir) {
  return readPackRow(dataDir);
}

export function writePack(dataDir, pack) {
  writePackRow(dataDir, pack);
  record(dataDir, { type: 'meme-pack', count: pack.items.length, query: pack.query });
  return pack;
}
