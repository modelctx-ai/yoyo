import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 动作名对应一种很轻的配音，不盖过说话。 */
export function sceneFor(action) {
  const name = String(action ?? '');
  if (name.includes('写代码')) return 'keys';
  if (name.includes('伸懒腰') || name.includes('哈欠')) return 'stretch';
  if (name.includes('小憩') || name.includes('发呆') || name.includes('呼吸')) return 'rest';
  if (name.includes('雀跃') || name.includes('挥手')) return 'cheer';
  if (name.includes('冰淇淋') || name.includes('吃')) return 'clink';
  if (name.includes('照镜子') || name.includes('礼仪')) return 'chime';
  if (name.includes('东张')) return 'look';
  return 'murmur';
}

function tone(rate, seconds, freq, amp, slide = 0) {
  const samples = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    const env = Math.sin(Math.PI * Math.min(1, t / seconds)) * (1 - t / seconds);
    samples[i] = Math.sin(2 * Math.PI * (freq + slide * t) * t) * amp * env;
  }
  return samples;
}

function mix(parts, rate) {
  const length = Math.max(...parts.map((part) => part.length));
  const out = new Float32Array(length);
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) out[i] += part[i];
  }
  return { samples: out, rate };
}

function render(scene) {
  const rate = 22050;
  if (scene === 'keys') {
    return mix([tone(rate, 0.05, 1800, 0.15), tone(rate, 0.05, 1400, 0.1)], rate);
  }
  if (scene === 'stretch') return { samples: tone(rate, 0.7, 180, 0.12, 80), rate };
  if (scene === 'rest') return { samples: tone(rate, 0.9, 140, 0.06), rate };
  if (scene === 'cheer') return mix([tone(rate, 0.18, 660, 0.1), tone(rate, 0.18, 880, 0.08)], rate);
  if (scene === 'clink') return { samples: tone(rate, 0.2, 2400, 0.1, -800), rate };
  if (scene === 'chime') return { samples: tone(rate, 0.45, 880, 0.08), rate };
  if (scene === 'look') return mix([tone(rate, 0.12, 420, 0.08), tone(rate, 0.12, 520, 0.06)], rate);
  return { samples: tone(rate, 0.35, 240, 0.07), rate };
}

function wavBytes(samples, rate) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return data;
}

export function ensureSfx(dir, action) {
  const scene = sceneFor(action);
  const file = join(dir, `${scene}.wav`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { samples, rate } = render(scene);
    writeFileSync(file, wavBytes(samples, rate));
  }
  return file;
}

/** 和说话一起响，音量压低。失败不影响台词。 */
export function playSfx(dir, action) {
  try {
    const file = ensureSfx(dir, action);
    const child = spawn('afplay', ['-v', '0.18', file], { stdio: 'ignore' });
    child.unref();
  } catch {
    /* 配音是附带的 */
  }
}
