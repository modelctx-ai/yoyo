import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { record } from './activity.js';
import { latestClip } from './clipboard.js';
import { appendContext, loadContext, storePetChat, toMessages } from './context.js';
import { listSpoken, listTasks, saveSpoken } from './db.js';
import { ensureAsrModel, transcribe } from './asr.js';
import { TONE_CUES, LINES, REPEAT_WINDOW_MS, bubbleMs, pickLine, toneForHour } from './catalog.js';
import { generateReply, generateWhisper } from './compose.js';
import { confirmSend } from './confirm.js';
import { listenSeconds, recordWav, wantsReply } from './listen.js';
import { decorateMeme, packIsStale, readPack, writePack, extractImageUrls } from './memes.js';
import { createPet } from './pet.js';
import { saveFired } from './schedule.js';
import { shouldSearch, searchWeb } from './search.js';
import { playSfx } from './sfx.js';
import { foreignLine, resolveSpeech, speechAutoplay } from './speech.js';
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
  const owned = new Set();

  function recent(now) {
    return listSpoken(dataDir).filter(
      (item) => item && typeof item.text === 'string' && typeof item.at === 'number' && now - item.at < REPEAT_WINDOW_MS,
    );
  }

  function remember(text, now) {
    saveSpoken(dataDir, [...recent(now), { text, at: now }]);
  }

  async function choose(now) {
    if (offWorkWeatherDue(now, readWeatherStamp(dataDir))) {
      try {
        const report = await buildOffWorkWeather(dataDir, now);
        if (report) return report;
        log('天气没查到，改说一句预制台词');
      } catch (error) {
        log(`天气没查到：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const tone = toneForHour(now.getHours());
    const said = recent(now.getTime());
    const line = pickLine(LINES, tone, said, now.getTime());
    if (line) return line;
    if (!config.llm?.apiKey) return null;
    const context = await contextLines();
    log('预制台词用完了，按最近的对话和任务写一句');
    return generateWhisper(config.llm, {
      tone,
      messages: toMessages(loadContext(dataDir)),
      task: context.task,
    });
  }

  async function syncPetChat() {
    try {
      const chat = await pet.get(`/chat?pet=${encodeURIComponent(config.pet.id)}&rounds=200`);
      storePetChat(dataDir, Array.isArray(chat.messages) ? chat.messages : []);
    } catch {
      /* 桌宠对话暂时读不到，已有上下文还在 */
    }
  }

  async function contextLines() {
    let chatLines = [];
    let task = '';
    try {
      const chat = await pet.get(`/chat?pet=${encodeURIComponent(config.pet.id)}&rounds=6`);
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      chatLines = messages.slice(-6).map((item) => {
        const who = item.role === 'assistant' ? '宠物' : '用户';
        return `${who}：${String(item.content ?? '').slice(0, 80)}`;
      });
    } catch {
      /* 没有对话记录时照样能生成 */
    }
    try {
      const state = await pet.get('/state');
      const data = state?.sections?.workStatus?.data;
      if (typeof data?.task === 'string' && data.task.trim()) task = data.task.trim();
      else if (typeof data?.state === 'string' && data.state) task = data.state;
    } catch {
      /* 工作状态读不到就当没有任务 */
    }
    try {
      const extra = listTasks(dataDir).slice(0, 5);
      if (extra.length) task = [task, ...extra].filter(Boolean).join('；');
    } catch {
      /* 本地任务文件是可选的 */
    }
    if (config.clipboard?.enabled !== false) {
      const clip = latestClip(dataDir).trim();
      if (clip) chatLines.push(`粘贴板：${clip.slice(0, 160)}`);
    }
    return { chatLines, task };
  }

  async function listenNow(now = new Date()) {
    record(dataDir, { type: 'listen-request' });
    const heard = await capture();
    if (heard.length < 2) {
      log('没听到');
      return { talked: false };
    }
    const accepted = await confirmSend(heard);
    if (!accepted) {
      log('听写没有发出');
      record(dataDir, { type: 'confirm-cancel', text: heard });
      return { talked: true };
    }
    log(`听到 ${accepted.length}字`);
    record(dataDir, { type: 'listen', text: accepted });
    if (!config.llm?.apiKey) return { talked: true };
    await answer(accepted, { tone: toneForHour(now.getHours()), text: '' }, now);
    return { talked: true };
  }

  async function speak(line, now) {
    owned.add(line.text);
    const file = await resolveSpeech(cacheDir, config.speech, line.text, line.cue);
    const duration = bubbleMs(line.text);
    const lockId = await pet.lock();
    try {
      await pet.broadcast(lockId, line.text, duration, line.imageUrl);
      try {
        await pet.anim(lockId, line.action);
      } catch (error) {
        log(`动作没播成（${line.action}）：${error instanceof Error ? error.message : String(error)}`);
      }
      const label = line.kind === 'weather' ? 'weather' : line.kind === 'generated' ? 'reply' : line.kind === 'reminder' ? 'reminder' : line.tone;
      log(`${label} ${line.action} ${line.text.length}字`);
      record(dataDir, { type: label, action: line.action, text: line.text, meme: line.imageUrl || undefined });
      playSfx(join(dataDir, 'sfx'), line.action);
      record(dataDir, { type: 'sfx', action: line.action });
      if (speechAutoplay(config.speech)) await play(file);
      if (line.kind === 'weather') writeWeatherStamp(dataDir, localDateKey(now));
      else remember(line.text, now.getTime());
      appendContext(dataDir, {
        role: line.reply || line.kind === 'reminder' || line.kind === 'weather' ? 'assistant' : 'whisper',
        text: line.text,
        at: now.getTime(),
      });
    } finally {
      await pet.release(lockId);
    }
  }

  async function capture() {
    const seconds = listenSeconds(config.listen);
    const wav = join(tmpdir(), `yoyo-mic-${Date.now()}.wav`);
    const action = config.listen?.action || '碎碎念-对屏碎碎念';
    log(`听 ${seconds} 秒`);
    pet.anim(undefined, action).catch((error) => {
      log(`侧耳听没播成（${action}）：${error instanceof Error ? error.message : String(error)}`);
    });
    try {
      await recordWav(wav, { seconds, device: config.listen?.device || ':0' });
      const model = await ensureAsrModel(join(dataDir, 'models'), config.asr?.model || 'tiny');
      return await transcribe(wav, model, config.asr?.bin);
    } finally {
      try {
        unlinkSync(wav);
      } catch {
        /* 录音文件留在临时目录也没关系 */
      }
    }
  }

  async function hear(line) {
    if (!wantsReply(line, config.listen)) return '';
    return capture();
  }

  async function answer(heard, line, now) {
    let searchText = '';
    if (shouldSearch(heard) && config.anysearch?.script) {
      try {
        searchText = await searchWeb(heard, config.anysearch);
        if (searchText) record(dataDir, { type: 'search', query: heard });
      } catch (error) {
        log(`搜索没做成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    appendContext(dataDir, { role: 'user', text: heard, at: now.getTime() });
    const reply = await generateReply(config.llm, {
      tone: line.tone || toneForHour(now.getHours()),
      messages: toMessages(loadContext(dataDir)),
      searchText,
    });
    await speak(reply, now);
  }

  async function perform(now = new Date()) {
    const line = await choose(now);
    if (!line) {
      log('这 3 小时里的碎碎念都说过了，这次先停');
      record(dataDir, { type: 'whisper-skip' });
      return null;
    }
    await speak(decorateMeme(line, readPack(dataDir)), now);
    if (!config.llm?.apiKey) return line;
    try {
      const heard = await hear(line);
      if (heard.length < 2) return { ...line, talked: false };
      const accepted = await confirmSend(heard);
      if (!accepted) {
        log('听写没有发出');
        record(dataDir, { type: 'confirm-cancel', text: heard });
        return { ...line, talked: true };
      }
      log(`听到 ${accepted.length}字`);
      record(dataDir, { type: 'listen', text: accepted });
      await answer(accepted, line, now);
      return { ...line, talked: true };
    } catch (error) {
      log(`没听成：${error instanceof Error ? error.message : String(error)}`);
    }
    return line;
  }

  async function bake(fetcher) {
    for (const line of LINES) {
      const existed = await resolveSpeech(cacheDir, config.speech, line.text, line.cue, fetcher);
      log(`bake ${line.tone} ${line.text.length}字 ${existed}`);
    }
  }

  async function remind(item, now = new Date()) {
    const tone = toneForHour(now.getHours());
    await speak({
      text: item.kind === 'task' ? `到点了。${item.title}` : item.title,
      tone,
      cue: TONE_CUES[tone],
      action: '碎碎念-对屏碎碎念',
      kind: 'reminder',
    }, now);
    saveFired(dataDir, item, now);
  }

  function claim(text) {
    if (text) owned.add(text);
  }

  async function playForeign(state) {
    if (!speechAutoplay(config.speech)) return null;
    const line = foreignLine(state, config.pet.id, owned);
    if (!line) return null;
    owned.add(line.text);
    const cue = TONE_CUES[config.speech.tone] || TONE_CUES.lively;
    const file = await resolveSpeech(cacheDir, config.speech, line.text, cue);
    log(`对话朗读 ${line.text.length}字`);
    record(dataDir, { type: 'chat-voice', text: line.text });
    await play(file);
    return line;
  }

  async function refreshMemes(now = new Date(), options = {}) {
    if (!config.anysearch?.script) return readPack(dataDir);
    const current = readPack(dataDir);
    if (!options.force && !packIsStale(current, now.getTime())) return current;
    const query = '可爱表情包 png';
    const text = await searchWeb(query, { ...config.anysearch, maxResults: 5 });
    const items = extractImageUrls(text).map((url) => ({ url }));
    return writePack(dataDir, { fetchedAt: now.toISOString(), query, items });
  }

  return { perform, bake, choose, remind, listenNow, playForeign, claim, refreshMemes, syncPetChat };
}
