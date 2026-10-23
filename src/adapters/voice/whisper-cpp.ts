import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Transcriber } from '../../ports/index.ts';

const MODELS: ReadonlyMap<string, string> = new Map([
  ['tiny', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'],
]);

/** 本地只放轻量模型。第一次用的时候下载到 modelDir，返回模型文件路径。 */
export async function ensureAsrModel(modelDir: string, name = 'tiny', fetcher: typeof fetch = fetch): Promise<string> {
  const url = MODELS.get(name);
  if (!url) throw new Error(`不支持的语音识别模型：${name}`);
  const file = join(modelDir, `ggml-${name}.bin`);
  if (existsSync(file) && statSync(file).size > 1_000_000) return file;
  mkdirSync(modelDir, { recursive: true, mode: 0o700 });
  const response = await fetcher(url);
  if (!response.ok || !response.body) throw new Error(`模型下载失败 ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { mode: 0o644 }));
  return file;
}

const HALLUCINATION = /^(谢谢|谢谢观看|字幕由\S*制作|各位观众|请不吝点赞|你|嗯|啊|哦)+[。.!！]?$/;

/** 丢掉静音时 tiny 模型常冒出来的套话。 */
export function cleanTranscript(raw: string): string {
  const text = (raw ?? '')
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('read_audio'))
    .join('')
    .replace(/\s+/g, '');
  if (text.length < 2 || HALLUCINATION.test(text)) return '';
  return text;
}

function whisper(bin: string, wavPath: string, modelPath: string): Promise<string> {
  const base = wavPath.replace(/\.wav$/i, '');
  const txt = `${base}.txt`;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-m', modelPath, '-f', wavPath, '-l', 'zh', '-nt', '-otxt', '-of', base, '--no-prints'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new Error('找不到 whisper-cli，先安装 whisper.cpp'));
      else reject(error);
    });
    // 等 stderr 读完再判断，报错文字才完整
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `whisper-cli 退出 ${code}`));
        return;
      }
      let raw = '';
      try {
        raw = readFileSync(txt, 'utf8');
      } catch {
        raw = '';
      }
      try {
        unlinkSync(txt);
      } catch {
        /* 识别结果文件删不掉不影响下一轮 */
      }
      resolve(cleanTranscript(raw));
    });
  });
}

export interface WhisperTranscriberOptions {
  readonly modelDir: string;
  /** 模型名，目前只有 tiny。 */
  readonly model: string;
  /** whisper.cpp 命令行，缺省 `YOYO_WHISPER` 或 whisper-cli。 */
  readonly bin?: string;
  readonly fetch?: typeof fetch;
}

/** 本机 whisper.cpp 识别。第一次会先下载模型。 */
export function createWhisperTranscriber(options: WhisperTranscriberOptions): Transcriber {
  return {
    async transcribe(file) {
      const model = await ensureAsrModel(options.modelDir, options.model || 'tiny', options.fetch);
      return whisper(options.bin || process.env['YOYO_WHISPER'] || 'whisper-cli', file, model);
    },
  };
}
