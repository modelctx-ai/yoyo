import type { Line, MemePack } from '../../kernel/types.ts';
import type { Repos, WebSearch } from '../../ports/index.ts';

export const MEME_QUERY = '可爱表情包 png';

const IMAGE = /https:\/\/[^\s)'"<>]+\.(?:png|jpe?g|gif|webp)/gi;
const HOUR_MS = 60 * 60 * 1000;

/** 搜索结果里的图片地址，去重，最多 12 个。 */
export function extractImageUrls(text: string): string[] {
  const found = String(text ?? '').match(IMAGE) ?? [];
  const urls: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[),.;]+$/, '');
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= 12) break;
  }
  return urls;
}

/** 空套餐过 1 小时再找，有图的套餐过 6 小时再换。 */
export function packIsStale(
  pack: MemePack | null,
  now: number,
  emptyWaitMs = HOUR_MS,
  fullWaitMs = 6 * HOUR_MS,
): boolean {
  const fetched = Date.parse(pack?.fetchedAt ?? '');
  const age = Number.isNaN(fetched) ? Infinity : now - fetched;
  if (!pack?.items?.length) return age > emptyWaitMs;
  return age > fullWaitMs;
}

/** 大约四成的碎碎念带一张图。天气和闹钟不带。 */
export function decorateMeme(line: Line, pack: MemePack | null, rand: () => number = Math.random): Line {
  if (line.kind === 'weather' || line.kind === 'reminder') return line;
  if (rand() >= 0.4) return line;
  const items = pack?.items ?? [];
  if (items.length === 0) return line;
  const meme = items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
  if (!meme?.url) return line;
  return { ...line, imageUrl: meme.url };
}

/** 没有搜索就返回现有的；不强制且没过期也返回现有的；否则搜 5 条，写库并记 'meme-pack'。 */
export async function refreshMemes(
  deps: { readonly repos: Pick<Repos, 'memes' | 'activity'>; readonly search: WebSearch | null },
  now: Date,
  options: { readonly force?: boolean } = {},
): Promise<MemePack | null> {
  const current = deps.repos.memes.read();
  if (!deps.search) return current;
  if (!options.force && !packIsStale(current, now.getTime())) return current;
  const text = await deps.search.search(MEME_QUERY, { maxResults: 5 });
  const pack: MemePack = {
    fetchedAt: now.toISOString(),
    query: MEME_QUERY,
    items: extractImageUrls(text).map((url) => ({ url })),
  };
  deps.repos.memes.write(pack);
  deps.repos.activity.record({ type: 'meme-pack', count: pack.items.length, query: pack.query });
  return pack;
}
