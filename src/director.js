import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { LINES, bubbleMs, pickLine, toneForHour } from './catalog.js';
import { createPet } from './pet.js';
import { resolveSpeech } from './speech.js';
import { buildOffWorkWeather, localDateKey, offWorkWeatherDue, readWeatherStamp, writeWeatherStamp } from './weather.js';

function play(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('afplay', [file], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`afplay 退出 ${code}`));
    });
  });
}

export function createDirector(config, dataDir, log = console.log) {
  const pet = createPet(config.pet);
  const cacheDir = join(dataDir, 'speech-cache');
  const stampPath = join(dataDir, 'weather-reported.json');
  let previous = '';

  async function choose(now) {
    if (offWorkWeatherDue(now, readWeatherStamp(stampPath))) {
      try {
        const report = await buildOffWorkWeather(dataDir, now);
        if (report) return report;
        log('天气没查到，改说一句预制台词');
      } catch (error) {
        log(`天气没查到：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const line = pickLine(LINES, toneForHour(now.getHours()), previous);
    if (!line) throw new Error('当前语气没有台词');
    return line;
  }

  async function perform(now = new Date()) {
    const line = await choose(now);
    previous = line.text;
    const file = await resolveSpeech(cacheDir, config.speech, line.text, line.cue);
    const duration = bubbleMs(line.text);
    const lockId = await pet.lock();
    try {
      await pet.broadcast(lockId, line.text, duration);
      try {
        await pet.anim(lockId, line.action);
      } catch (error) {
        log(`动作没播成（${line.action}）：${error instanceof Error ? error.message : String(error)}`);
      }
      log(`${line.kind === 'weather' ? 'weather' : line.tone} ${line.action} ${line.text.length}字`);
      await play(file);
      if (line.kind === 'weather') writeWeatherStamp(stampPath, localDateKey(now));
    } finally {
      await pet.release(lockId);
    }
    return line;
  }

  async function bake(fetcher) {
    for (const line of LINES) {
      const existed = await resolveSpeech(cacheDir, config.speech, line.text, line.cue, fetcher);
      log(`bake ${line.tone} ${line.text.length}字 ${existed}`);
    }
  }

  return { perform, bake, choose };
}
