import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SpeechConfig } from '../../app/config.ts';
import type { Synthesizer } from '../../ports/index.ts';

/** 合成要用到的那几项。 */
export type FishSettings = Pick<SpeechConfig, 'baseUrl' | 'apiKey' | 'model' | 'referenceId'>;

export interface FishSynthesizerOptions {
  readonly speech: FishSettings;
  readonly cacheDir: string;
  readonly fetch?: typeof fetch;
}

/** 句首没有情绪标签就补上 cue。空句返回空字符串。 */
export function spokenText(text: string, cue: string): string {
  const body = text.trim();
  if (!body) return '';
  if (/^\[[^\]\n]+\]/.test(body)) return body;
  return `${cue} ${body}`;
}

export function ttsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1/tts') ? trimmed : `${trimmed}/v1/tts`;
}

/** 缓存文件名和旧版一字不差，已有的 speech-cache 继续可用。 */
export function cacheFile(
  dir: string,
  speech: Pick<SpeechConfig, 'model' | 'referenceId'>,
  text: string,
  cue: string,
): string {
  const spoken = spokenText(text, cue);
  const hash = createHash('sha256').update(`${speech.model}\n${cue}\n${speech.referenceId}\n${spoken}`).digest('hex');
  return join(dir, `${hash}.mp3`);
}

/** 请求 Fish，把 mp3 写到系统临时目录，返回临时文件路径。 */
async function request(speech: FishSettings, text: string, cue: string, fetcher: typeof fetch): Promise<string> {
  const spoken = spokenText(text, cue);
  if (!spoken) throw new Error('没有可朗读的文字');
  const response = await fetcher(ttsEndpoint(speech.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${speech.apiKey}`,
      'Content-Type': 'application/json',
      model: speech.model,
    },
    body: JSON.stringify({
      text: spoken,
      reference_id: speech.referenceId,
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
    const detail = (await response.text().catch(() => '')).replaceAll(speech.apiKey, '').slice(0, 180);
    throw new Error(`语音接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 128) throw new Error('语音接口没有返回音频');
  const temporary = join(tmpdir(), `yoyo-${createHash('sha256').update(spoken).digest('hex').slice(0, 12)}.mp3`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  return temporary;
}

/** Fish Audio 语音。有缓存就直接用；没有才请求，并把 mp3 留在 cacheDir。 */
export function createFishSynthesizer(options: FishSynthesizerOptions): Synthesizer {
  return {
    async synthesize(text, cue) {
      const dest = cacheFile(options.cacheDir, options.speech, text, cue);
      if (existsSync(dest)) return dest;
      const temporary = await request(options.speech, text, cue, options.fetch ?? fetch);
      mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
      copyFileSync(temporary, dest);
      chmodSync(dest, 0o600);
      try {
        unlinkSync(temporary);
      } catch {
        /* 临时文件留在系统临时目录，不影响播放 */
      }
      return dest;
    },
  };
}
