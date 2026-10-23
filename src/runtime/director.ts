import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Context, LanguageModel } from '@modelctx-ai/ctx';

import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import { recordLine, recordUser, storePetChat } from '../brain/context.ts';
import { generateReply, generateWhisper } from '../brain/compose.ts';
import { reminderLine, saveFired } from '../features/alarms/schedule.ts';
import { confirmSend } from '../features/listen/confirm.ts';
import { listenSeconds, wantsReply } from '../features/listen/listen.ts';
import { decorateMeme, refreshMemes } from '../features/memes/memes.ts';
import { shouldSearch } from '../features/search/question.ts';
import {
  buildOffWorkWeather,
  offWorkWeatherDue,
  readWeatherStamp,
  writeWeatherStamp,
} from '../features/weather/weather.ts';
import { LINES, REPEAT_WINDOW_MS, pickLine } from '../features/whisper/catalog.ts';
import { activityLabel, bubbleMs } from '../kernel/line.ts';
import { localDateKey } from '../kernel/time.ts';
import { TONE_CUES, toneForHour } from '../kernel/tone.ts';
import type { Line, MemePack, ScheduleItem, Tone } from '../kernel/types.ts';
import type {
  AudioPlayer,
  Logger,
  PetHost,
  Recorder,
  Repos,
  SfxPlayer,
  Synthesizer,
  Transcriber,
  UrlOpener,
  WebSearch,
} from '../ports/index.ts';
import { compactContext, historyTokens } from './compact.ts';

export interface DirectorDeps {
  readonly config: Config;
  readonly paths: Paths;
  readonly logger: Logger;
  readonly host: PetHost;
  readonly synthesizer: Synthesizer;
  readonly player: AudioPlayer;
  readonly sfx: SfxPlayer;
  readonly recorder: Recorder;
  readonly transcriber: Transcriber;
  readonly search: WebSearch | null;
  readonly opener: UrlOpener;
  readonly repos: Repos;
  readonly context: Context;
  readonly model: LanguageModel | null;
  readonly now?: () => Date;
  readonly rand?: () => number;
  /** 缺省 confirmSend(text, { open: opener.open })。 */
  readonly confirm?: (text: string) => Promise<string>;
  /** 天气用。 */
  readonly fetch?: typeof fetch;
}

export interface PerformResult {
  readonly line: Line;
  /** 用户这次有没有开口（取消发送也算）。 */
  readonly talked: boolean;
}

export interface Director {
  perform(now?: Date): Promise<PerformResult | null>;
  listenNow(now?: Date): Promise<{ readonly talked: boolean }>;
  remind(item: ScheduleItem, now?: Date): Promise<void>;
  bake(): Promise<void>;
  choose(now?: Date): Promise<Line | null>;
  claim(text: string): void;
  playForeign(text: string): Promise<boolean>;
  refreshMemes(now?: Date, options?: { readonly force?: boolean }): Promise<MemePack | null>;
  syncPetChat(): Promise<void>;
  compactIfNeeded(): Promise<boolean>;
}

/** 记住多少句 yoyo 自己投喂过的话，用来分辨桌宠气泡里哪些不是自己说的。 */
const OWNED_LIMIT = 500;
const LISTEN_ACTION = '碎碎念-对屏碎碎念';

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 录音文件留在临时目录也没关系 */
  }
}

export function createDirector(deps: DirectorDeps): Director {
  const { config, logger, host, synthesizer, player, sfx, recorder, transcriber, search, repos, context, model } = deps;
  const clock = deps.now ?? (() => new Date());
  const rand = deps.rand ?? Math.random;
  const confirm = deps.confirm ?? ((text: string) => confirmSend(text, { open: (url) => deps.opener.open(url) }));
  const secrets = [config.llm.apiKey].filter(Boolean);
  const owned = new Set<string>();

  function own(text: string): void {
    owned.delete(text);
    owned.add(text);
    for (const old of owned) {
      if (owned.size <= OWNED_LIMIT) break;
      owned.delete(old);
    }
  }

  /** 先合成（锁外），再占住舞台投喂、点播；占着舞台时记行为、配音、播语音、记进窗口和上下文。 */
  async function speak(line: Line, now: Date): Promise<void> {
    own(line.text);
    const file = await synthesizer.synthesize(line.text, line.cue);
    const stage = {
      text: line.text,
      durationMs: bubbleMs(line.text),
      action: line.action,
      ...(line.imageUrl ? { imageUrl: line.imageUrl } : {}),
    };
    await host.present(stage, async () => {
      const label = activityLabel(line);
      logger.info(`${label} ${line.action} ${line.text.length}字`);
      repos.activity.record({ type: label, action: line.action, text: line.text, meme: line.imageUrl || undefined });
      sfx.play(line.action);
      repos.activity.record({ type: 'sfx', action: line.action });
      // 没配语音时没有文件，只出字
      if (file && config.speech.autoplay) await player.play(file);
      if (line.kind === 'weather') writeWeatherStamp(repos.kv, localDateKey(now));
      else repos.spoken.remember(line.text, now.getTime(), REPEAT_WINDOW_MS);
      await recordLine(context, line, now.getTime());
    });
  }

  async function choose(now = clock()): Promise<Line | null> {
    if (offWorkWeatherDue(now, readWeatherStamp(repos.kv))) {
      try {
        const report = await buildOffWorkWeather(repos.kv, now, deps.fetch);
        if (report) return report;
        logger.info('天气没查到，改说一句预制台词');
      } catch (error) {
        logger.warn(`天气没查到：${errorText(error)}`);
      }
    }
    const tone = toneForHour(now.getHours());
    const said = repos.spoken.recent(now.getTime(), REPEAT_WINDOW_MS);
    const line = pickLine(LINES, tone, said, now.getTime(), rand);
    if (line) return line;
    if (!model) return null;
    logger.info('预制台词用完了，按最近的对话和任务写一句');
    return generateWhisper(context, { tone, model, secrets });
  }

  async function capture(): Promise<string> {
    const seconds = listenSeconds(config.listen);
    const wav = join(tmpdir(), `yoyo-mic-${Date.now()}.wav`);
    const action = config.listen.action || LISTEN_ACTION;
    logger.info(`听 ${seconds} 秒`);
    host.cue(action).catch((error: unknown) => {
      logger.warn(`侧耳听没播成（${action}）：${errorText(error)}`);
    });
    let file = wav;
    try {
      file = await recorder.record(wav, seconds);
      return await transcriber.transcribe(file);
    } finally {
      removeQuietly(wav);
      if (file !== wav) removeQuietly(file);
    }
  }

  async function answer(heard: string, tone: Tone, now: Date, llm: LanguageModel): Promise<void> {
    let searchText = '';
    // 打开工具时由模型自己决定搜不搜，不再先按问句搜一遍。
    if (search && !config.llm.tools && shouldSearch(heard)) {
      try {
        searchText = await search.search(heard);
        if (searchText) repos.activity.record({ type: 'search', query: heard });
      } catch (error) {
        logger.warn(`搜索没做成：${errorText(error)}`);
      }
    }
    await recordUser(context, heard, now.getTime());
    const reply = await generateReply(context, {
      tone,
      model: llm,
      secrets,
      tools: config.llm.tools,
      ...(searchText ? { searchText } : {}),
    });
    await speak(reply, now);
  }

  /** 听写结果先确认。返回 null 表示没听到；空字符串表示取消了。 */
  async function accept(heard: string): Promise<string | null> {
    if (heard.length < 2) return null;
    const accepted = await confirm(heard);
    if (!accepted) {
      logger.info('听写没有发出');
      repos.activity.record({ type: 'confirm-cancel', text: heard });
      return '';
    }
    logger.info(`听到 ${accepted.length}字`);
    repos.activity.record({ type: 'listen', text: accepted });
    return accepted;
  }

  async function listenNow(now = clock()): Promise<{ readonly talked: boolean }> {
    repos.activity.record({ type: 'listen-request' });
    const accepted = await accept(await capture());
    if (accepted === null) {
      logger.info('没听到');
      return { talked: false };
    }
    if (accepted && model) await answer(accepted, toneForHour(now.getHours()), now, model);
    return { talked: true };
  }

  async function perform(now = clock()): Promise<PerformResult | null> {
    const chosen = await choose(now);
    if (!chosen) {
      logger.info('这 3 小时里的碎碎念都说过了，这次先停');
      repos.activity.record({ type: 'whisper-skip' });
      return null;
    }
    const line = decorateMeme(chosen, repos.memes.read(), rand);
    await speak(line, now);
    if (!model) return { line, talked: false };
    try {
      if (!wantsReply(chosen, config.listen)) return { line, talked: false };
      const accepted = await accept(await capture());
      if (accepted === null) return { line, talked: false };
      if (accepted) await answer(accepted, chosen.tone, now, model);
      return { line, talked: true };
    } catch (error) {
      logger.warn(`没听成：${errorText(error)}`);
    }
    return { line, talked: false };
  }

  async function remind(item: ScheduleItem, now = clock()): Promise<void> {
    await speak(reminderLine(item, now), now);
    saveFired(repos, item, now);
  }

  async function bake(): Promise<void> {
    for (const line of LINES) {
      const file = await synthesizer.synthesize(line.text, line.cue);
      if (!file) {
        logger.info('语音没配好，没有可预合成的');
        return;
      }
      logger.info(`bake ${line.tone} ${line.text.length}字 ${file}`);
    }
  }

  function claim(text: string): void {
    const trimmed = text.trim();
    if (trimmed) own(trimmed);
  }

  /** 桌宠自己说出的新句子（右键对话的回复）也念出来。yoyo 刚投喂过的不算。 */
  async function playForeign(text: string): Promise<boolean> {
    if (!config.speech.autoplay) return false;
    const trimmed = text.trim();
    if (!trimmed || owned.has(trimmed)) return false;
    own(trimmed);
    const cue = TONE_CUES[config.speech.tone ?? 'lively'];
    const file = await synthesizer.synthesize(trimmed, cue);
    if (!file) return false;
    logger.info(`对话朗读 ${trimmed.length}字`);
    repos.activity.record({ type: 'chat-voice', text: trimmed });
    await player.play(file);
    return true;
  }

  async function syncPetChat(): Promise<void> {
    try {
      await storePetChat(context, await host.chatHistory(200));
    } catch {
      /* 桌宠对话暂时读不到，已有上下文还在 */
    }
  }

  async function compactIfNeeded(): Promise<boolean> {
    const limit = config.context.compactAt;
    if (!limit || !model) return false;
    const before = await historyTokens(context);
    if (before <= limit) return false;
    const done = await compactContext(context, { keep: config.context.keep, model, before });
    if (!done) return false;
    logger.info(`上下文压成摘要：约 ${done.before} → ${done.after} token`);
    return true;
  }

  return {
    perform,
    listenNow,
    remind,
    bake,
    choose,
    claim,
    playForeign,
    refreshMemes: (now = clock(), options = {}) => refreshMemes({ repos, search }, now, options),
    syncPetChat,
    compactIfNeeded,
  };
}
