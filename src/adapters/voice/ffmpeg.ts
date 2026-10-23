import { spawn } from 'node:child_process';

import type { Recorder } from '../../ports/index.ts';

export interface FfmpegRecorderOptions {
  /** ffmpeg 的 AVFoundation 音频设备，形如 ":0"。 */
  readonly device: string;
  /** 录音程序，缺省 ffmpeg。测试时换成假的。 */
  readonly bin?: string;
}

/** 用本机麦克风录一段 16 kHz 单声道 wav。 */
export function createFfmpegRecorder(options: FfmpegRecorderOptions): Recorder {
  const bin = options.bin ?? 'ffmpeg';
  return {
    record(file, seconds) {
      const device = options.device || ':0';
      return new Promise((resolve, reject) => {
        const child = spawn(
          bin,
          ['-y', '-f', 'avfoundation', '-i', device, '-t', String(seconds), '-ac', '1', '-ar', '16000', file],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let errorText = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          errorText += chunk;
        });
        child.once('error', reject);
        // 等 stderr 读完再判断，报错文字才完整
        child.once('close', (code) => {
          if (code === 0) resolve(file);
          else reject(new Error(errorText.trim().split('\n').slice(-3).join(' ') || `ffmpeg 退出 ${code}`));
        });
      });
    },
  };
}
