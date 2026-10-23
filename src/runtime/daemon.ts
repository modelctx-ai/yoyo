import { setTimeout as delay } from 'node:timers/promises';

import type { LanguageModel } from '@modelctx-ai/ctx';

import { startHotkeyHelper } from '../adapters/platform/macos.ts';
import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import type { Channel } from '../brain/channel.ts';
import { dueItems } from '../features/alarms/schedule.ts';
import { notePaste } from '../features/clipboard/clipboard.ts';
import { nextWhisperAt } from '../kernel/pace.ts';
import type { InboxRequest } from '../kernel/types.ts';
import type { Clipboard, Logger, PetHost, Repos } from '../ports/index.ts';
import type { Director } from './director.ts';
import { drain, enqueue } from './inbox.ts';

/** 常驻循环要用到的那部分应用（`createApp` 的结果满足它）。 */
export interface DaemonApp {
  readonly config: Config;
  readonly paths: Paths;
  readonly logger: Logger;
  readonly repos: Repos;
  readonly host: PetHost;
  readonly clipboard: Clipboard;
  readonly model: LanguageModel | null;
  readonly director: Director;
  /** 开本机对话渠道，关闭应用时一起关。 */
  openChannel(): Promise<Channel>;
  close(): Promise<void>;
}

export type TickApp = Pick<DaemonApp, 'config' | 'paths' | 'logger' | 'repos' | 'clipboard' | 'director'>;

export const TICK_MS = 1000;
/** 离下一句日常碎碎念还有这么久，才趁空去找表情包。 */
export const MEME_LEAD_MS = 20_000;
/** 上下文多久看一次要不要压缩。 */
export const COMPACT_EVERY_MS = 10 * 60 * 1000;
const RETRY_MS = 2000;

export const MENU_OWNER = 'yoyo';
export const MENU_LABELS: readonly string[] = ['碎碎念', '听一句'];

/** 两句日常碎碎念的间隔：至少一分钟，缺省 5 分钟。 */
export function whisperIntervalMs(intervalSec: number): number {
  return Math.max(60, Number(intervalSec) || 300) * 1000;
}

export function memeIdle(now: number, nextWhisper: number): boolean {
  return now + MEME_LEAD_MS < nextWhisper;
}

export type WhisperStep =
  { readonly kind: 'wait' } | { readonly kind: 'delay'; readonly until: number } | { readonly kind: 'speak' };

/** 没到点就等；到点了但 30 秒内还有对话就顺延；否则开口。 */
export function whisperStep(nextWhisper: number, lastTalk: number, now: number): WhisperStep {
  if (now < nextWhisper) return { kind: 'wait' };
  const shifted = nextWhisperAt(nextWhisper, lastTalk, now);
  return shifted > now ? { kind: 'delay', until: shifted } : { kind: 'speak' };
}

/** 说完一句以后的下一句：隔一个间隔；刚有人说话，还要等对话停下来。 */
export function nextAfterSpeak(now: number, intervalMs: number, lastTalk: number): number {
  return nextWhisperAt(now + intervalMs, lastTalk, now);
}

/** 配了 `context.compactAt` 才压缩，而且每 10 分钟最多看一次。 */
export function compactDue(config: Pick<Config, 'context'>, now: number, lastCheck: number | null): boolean {
  if (!config.context.compactAt) return false;
  return lastCheck === null || now - lastCheck >= COMPACT_EVERY_MS;
}

export function menuRequest(label: string): InboxRequest | null {
  if (label === '碎碎念') return 'whisper';
  if (label === '听一句') return 'listen';
  return null;
}

/** 桌宠右键对话要不要改走 yoyo 的渠道。只有 openai-compatible 能走网关。 */
export function channelPlan(
  config: Pick<Config, 'llm'>,
  hostName: string,
  hasModel: boolean,
): 'open' | 'unsupported' | 'skip' {
  if (!hasModel || hostName !== 'dsh-pet') return 'skip';
  return config.llm.provider === 'openai-compatible' ? 'open' : 'unsupported';
}

export interface DaemonState {
  /** 下一句日常碎碎念的时间（毫秒）。 */
  nextWhisper: number;
  /** 最近一次对话、听写或提醒结束的时间。 */
  lastTalk: number;
  /** 最近一次看要不要压缩上下文的时间。 */
  lastCompact: number | null;
}

/** 一拍：粘贴板、桌宠对话、收件箱、到点提醒、空闲找图、碎碎念让路、上下文压缩。上一拍没走完就跳过。 */
export function createTick(app: TickApp, state: DaemonState, clock: () => number = Date.now): () => Promise<void> {
  const { config, paths, logger, repos, clipboard, director } = app;
  const intervalMs = whisperIntervalMs(config.intervalSec);
  let busy = false;

  return async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (config.clipboard.enabled) notePaste(repos, clipboard.read());
      await director.syncPetChat();
      for (const message of drain(paths.inboxFile)) {
        if (message.type === 'listen') await director.listenNow();
        else await director.perform();
        state.lastTalk = clock();
      }
      const now = new Date(clock());
      for (const item of dueItems(repos.schedule.list(), now)) {
        await director.remind(item, now);
        state.lastTalk = clock();
      }
      if (memeIdle(clock(), state.nextWhisper)) {
        try {
          await director.refreshMemes(now);
        } catch (error) {
          logger.error(errorText(error));
        }
      }
      const step = whisperStep(state.nextWhisper, state.lastTalk, clock());
      if (step.kind === 'delay') {
        state.nextWhisper = step.until;
        logger.info('碎碎念先让一下，等对话停 30 秒');
        repos.activity.record({ type: 'delay', until: new Date(step.until).toISOString() });
      } else if (step.kind === 'speak') {
        const spoken = await director.perform();
        if (spoken?.talked) state.lastTalk = clock();
        state.nextWhisper = nextAfterSpeak(clock(), intervalMs, state.lastTalk);
      }
      if (compactDue(config, clock(), state.lastCompact)) {
        state.lastCompact = clock();
        try {
          await director.compactIfNeeded();
        } catch (error) {
          logger.error(`上下文没压缩成：${errorText(error)}`);
        }
      }
    } catch (error) {
      logger.error(errorText(error));
    } finally {
      busy = false;
    }
  };
}

/** 一直跑到 signal 中止。出错或意外结束时等一会儿重来。 */
async function keepRunning(signal: AbortSignal, logger: Logger, run: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      await run();
    } catch (error) {
      if (!signal.aborted) logger.error(errorText(error));
    }
    if (signal.aborted) break;
    await delay(RETRY_MS, undefined, { signal }).catch(() => {});
  }
}

async function connectChannel(app: DaemonApp): Promise<void> {
  const plan = channelPlan(app.config, app.host.name, app.model !== null);
  if (plan === 'skip') return;
  if (plan === 'unsupported') {
    app.logger.info('llm.provider 不是 openai-compatible，桌宠右键对话不经过 yoyo');
    return;
  }
  try {
    const channel = await app.openChannel();
    const saved = await app.host.bindChat({
      baseUrl: channel.baseUrl,
      model: app.config.llm.model,
      apiKey: channel.token,
    });
    app.logger.info(`对话渠道已接上 ${saved.model}`);
  } catch (error) {
    app.logger.error(errorText(error));
  }
}

function watchMenu(app: DaemonApp, signal: AbortSignal): Promise<void> {
  return keepRunning(signal, app.logger, async () => {
    for await (const label of app.host.menu(MENU_OWNER, MENU_LABELS, signal)) {
      const type = menuRequest(label);
      if (type) enqueue(app.paths.inboxFile, type);
    }
  });
}

/** 启动时气泡里已有的那句记成自己的；之后桌宠新说的句子念出来。 */
function watchSayings(app: DaemonApp, signal: AbortSignal): Promise<void> {
  return keepRunning(signal, app.logger, async () => {
    for await (const saying of app.host.sayings(signal)) {
      try {
        if (saying.initial) app.director.claim(saying.text);
        else await app.director.playForeign(saying.text);
      } catch (error) {
        app.logger.error(errorText(error));
      }
    }
  });
}

/** `--bake` 预合成，`--once` 说一句；否则常驻，直到 SIGINT/SIGTERM。 */
export async function runDaemon(
  app: DaemonApp,
  options: { readonly once?: boolean; readonly bake?: boolean },
): Promise<void> {
  if (options.bake || options.once) {
    try {
      if (options.bake) await app.director.bake();
      else await app.director.perform();
    } finally {
      await app.close();
    }
    return;
  }

  const { config, paths, logger } = app;
  const controller = new AbortController();
  const { signal } = controller;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (signal.aborted) return;
    controller.abort();
    clearTimeout(timer);
    app
      .close()
      .catch((error: unknown) => logger.error(errorText(error)))
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await connectChannel(app);
  void watchMenu(app, signal);
  if (process.platform === 'darwin' && config.hotkey.enabled) {
    startHotkeyHelper({ binDir: paths.binDir, source: paths.hotkeySource, inboxFile: paths.inboxFile, logger });
  }
  void watchSayings(app, signal);

  const tick = createTick(app, { nextWhisper: Date.now(), lastTalk: 0, lastCompact: null });
  const loop = async (): Promise<void> => {
    await tick();
    if (!signal.aborted) timer = setTimeout(loop, TICK_MS);
  };
  await loop();
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
