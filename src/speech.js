import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 缺省开启。只有明确写成 false 才不把对话回复念出来。 */
export function speechAutoplay(speech) {
  return speech?.autoplay !== false;
}

export function spokenText(text, cue) {
  const body = text.trim();
  if (!body) return '';
  if (/^\[[^\]\n]+\]/.test(body)) return body;
  return `${cue} ${body}`;
}

export function ttsEndpoint(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1/tts') ? trimmed : `${trimmed}/v1/tts`;
}

/** 桌宠自己说出的新句子。yoyo 刚投喂过的原文不算。 */
export function foreignLine(state, petId, owned) {
  const leaf = state?.pets?.[petId]?.say;
  if (!leaf || typeof leaf.counter !== 'number') return null;
  const data = leaf.data;
  if (!data || data.clear === true || typeof data.text !== 'string') return null;
  const text = data.text.trim();
  if (!text || owned.has(text)) return null;
  return { counter: leaf.counter, text };
}

export function cacheFile(dir, settings, text, cue) {
  const spoken = spokenText(text, cue);
  const hash = createHash('sha256')
    .update(`${settings.model}\n${cue}\n${settings.referenceId}\n${spoken}`)
    .digest('hex');
  return join(dir, `${hash}.mp3`);
}

export async function synthesize(settings, text, cue, fetcher) {
  const request = fetcher ?? fetch;
  const spoken = spokenText(text, cue);
  if (!spoken) throw new Error('没有可朗读的文字');
  const response = await request(ttsEndpoint(settings.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      model: settings.model,
    },
    body: JSON.stringify({
      text: spoken,
      reference_id: settings.referenceId,
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'balanced',
      normalize: true,
      chunk_length: 100,
      temperature: 0.7,
      top_p: 0.7,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replaceAll(settings.apiKey, '').slice(0, 180);
    throw new Error(`语音接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 128) throw new Error('语音接口没有返回音频');
  const temporary = join(tmpdir(), `yoyo-${createHash('sha256').update(spoken).digest('hex').slice(0, 12)}.mp3`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  return temporary;
}

/** 有缓存就直接用。没有才请求 Fish，并把 mp3 留在 cacheDir。 */
export async function resolveSpeech(cacheDir, settings, text, cue, fetcher) {
  const dest = cacheFile(cacheDir, settings, text, cue);
  if (existsSync(dest)) return dest;
  const temporary = await synthesize(settings, text, cue, fetcher);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  copyFileSync(temporary, dest);
  chmodSync(dest, 0o600);
  try {
    unlinkSync(temporary);
  } catch {
    /* 临时文件留在系统临时目录，不影响播放 */
  }
  return dest;
}
