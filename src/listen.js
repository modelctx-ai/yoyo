import { spawn } from 'node:child_process';

/** 碎碎念和模型现写的话可以听回应。天气播报不听。 */
export function wantsReply(line, listen) {
  if (!listen?.enabled) return false;
  if (!line || line.kind === 'weather' || line.kind === 'reminder') return false;
  return true;
}

export function listenSeconds(listen) {
  const seconds = Number(listen?.seconds);
  if (!Number.isFinite(seconds)) return 5;
  return Math.min(10, Math.max(1, Math.round(seconds)));
}

/** 用本机麦克风录一段 wav。device 形如 ":0"，对应 ffmpeg 的 AVFoundation 音频设备。 */
export function recordWav(path, { seconds = 5, device = ':0' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-f', 'avfoundation', '-i', device, '-t', String(seconds), '-ac', '1', '-ar', '16000', path],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(path);
      else reject(new Error(errorText.trim().split('\n').slice(-3).join(' ') || `ffmpeg 退出 ${code}`));
    });
  });
}
