import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notePaste, readPaste } from './clipboard.js';
import { startChannel } from './channel.js';
import { createDirector } from './director.js';
import { syncChatChannel } from './pet.js';
import { drain, enqueue } from './inbox.js';
import { nextWhisperAt } from './pace.js';
import { record } from './activity.js';
import { dueItems, listSchedule } from './schedule.js';

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

async function registerMenu() {
  const response = await fetch(`${config.pet.baseUrl.replace(/\/+$/, '')}/menu/item`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-pet-token': JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json'), 'utf8')).token,
    },
    body: JSON.stringify({ owner: 'yoyo', target: 'desktop', labels: ['碎碎念', '听一句'] }),
  });
  const data = await response.json();
  if (!data.ok) console.error(`菜单没挂上：${data.message || data.reason}`);
  else console.log('右键里已有 yoyo：碎碎念、听一句');
}

function startHotkey() {
  if (config.hotkey?.enabled === false) return;
  const binDir = join(dataDir, 'bin');
  const bin = join(binDir, 'yoyo-hotkey');
  const source = join(root, 'src', 'hotkey.swift');
  if (!existsSync(bin)) {
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const built = spawnSync('swiftc', ['-O', '-o', bin, source], { encoding: 'utf8' });
    if (built.status !== 0) {
      console.error('按键助手没编译成，仍可用 yoyo listen');
      return;
    }
  }
  const child = spawn(bin, [join(dataDir, 'inbox.jsonl')], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(text);
  });
  child.unref();
}

writeFileSync(join(dataDir, 'director.pid'), String(process.pid), { mode: 0o600 });

if (bakeOnly) {
  await director.bake();
} else if (once) {
  await director.perform();
} else {
  const intervalMs = Math.max(60, Number(config.intervalSec) || 300) * 1000;
  let nextWhisper = Date.now();
  let lastTalk = 0;
  let busy = false;
  let timer;
  let menuOn = true;

  const pollMenu = async () => {
    while (menuOn) {
      try {
        const response = await fetch(`${config.pet.baseUrl.replace(/\/+$/, '')}/menu/events?owner=yoyo&wait=8000`, {
          headers: {
            'x-dsh-pet-token': JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json'), 'utf8')).token,
          },
          signal: AbortSignal.timeout(20_000),
        });
        const data = await response.json();
        if (!data.ok) {
          if (data.reason === 'unknown-owner') await registerMenu();
          else await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (data.events?.['碎碎念']) enqueue(dataDir, 'whisper');
        if (data.events?.['听一句']) enqueue(dataDir, 'listen');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };

  const tick = async () => {
    if (busy) {
      timer = setTimeout(tick, 1000);
      return;
    }
    busy = true;
    try {
      if (config.clipboard?.enabled !== false) notePaste(dataDir, readPaste());
      await director.syncPetChat();
      for (const message of drain(dataDir)) {
        if (message.type === 'listen') await director.listenNow();
        else if (message.type === 'whisper') await director.perform();
        lastTalk = Date.now();
      }
      const now = new Date();
      for (const item of dueItems(listSchedule(dataDir), now)) {
        await director.remind(item, now);
        lastTalk = Date.now();
      }
      if (Date.now() + 20_000 < nextWhisper) {
        try {
          await director.refreshMemes(now);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
      if (Date.now() >= nextWhisper) {
        const shifted = nextWhisperAt(nextWhisper, lastTalk, Date.now());
        if (shifted > Date.now()) {
          nextWhisper = shifted;
          console.log('碎碎念先让一下，等对话停 30 秒');
          record(dataDir, { type: 'delay', until: new Date(shifted).toISOString() });
        } else {
          const spoken = await director.perform();
          if (spoken?.talked) lastTalk = Date.now();
          nextWhisper = nextWhisperAt(Date.now() + intervalMs, lastTalk, Date.now());
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      timer = setTimeout(tick, 1000);
    }
  };

  process.on('SIGINT', () => {
    menuOn = false;
    clearTimeout(timer);
    process.exit(0);
  });
  try {
    const channel = await startChannel(config.llm, dataDir);
    const saved = await syncChatChannel(config.pet, { ...config.llm, baseUrl: channel.baseUrl });
    console.log(`对话渠道已接上 ${saved.model}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  const watchSays = async () => {
    let since = -1;
    while (menuOn) {
      try {
        const path = since < 0 ? '/state' : `/state?since=${since}&timeout=8000`;
        const response = await fetch(`${config.pet.baseUrl.replace(/\/+$/, '')}${path}`, {
          headers: {
            'x-dsh-pet-token': JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json'), 'utf8')).token,
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`state ${response.status}`);
        const state = await response.json();
        if (typeof state.counter === 'number') since = state.counter;
        if (path === '/state') {
          const current = state?.pets?.[config.pet.id]?.say?.data?.text;
          if (typeof current === 'string') director.claim(current.trim());
        } else await director.playForeign(state);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  await registerMenu();
  startHotkey();
  pollMenu();
  watchSays();
  await tick();
}
