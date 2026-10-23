import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDirector } from './director.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function loadConfig() {
  const path = join(root, 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const speech = raw.speech ?? {};
  for (const key of ['baseUrl', 'apiKey', 'model', 'referenceId']) {
    if (!String(speech[key] ?? '').trim()) throw new Error(`config.json 的 speech.${key} 还空着`);
  }
  if (!raw.pet?.baseUrl || !raw.pet?.id || !raw.pet?.surface) throw new Error('config.json 的 pet 不完整');
  return raw;
}

const dataDir = join(homedir(), '.yoyo');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const once = process.argv.includes('--once');
const bakeOnly = process.argv.includes('--bake');
const config = loadConfig();
const director = createDirector(config, dataDir);

if (bakeOnly) {
  await director.bake();
} else if (once) {
  await director.perform();
} else {
  const intervalMs = Math.max(60, Number(config.intervalSec) || 300) * 1000;
  let timer;
  const tick = async () => {
    try {
      await director.perform();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    timer = setTimeout(tick, intervalMs);
  };
  process.on('SIGINT', () => {
    clearTimeout(timer);
    process.exit(0);
  });
  await tick();
}
