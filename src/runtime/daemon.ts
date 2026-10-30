import { setTimeout as delay } from 'node:timers/promises';

import type { Context, LanguageModel } from '@modelctx-ai/ctx';

import type { Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import type { Channel } from '../brain/channel.ts';
import type { InboxRequest } from '../kernel/types.ts';
import type { Logger, PetHost, UrlOpener } from '../ports/index.ts';
import type { Director } from './director.ts';
import { recompactLossySummaries } from './compact.ts';
import { enqueue } from './inbox.ts';
import type { YoyoOrchestrator } from './orchestrator.ts';

/**
 * 常驻循环要用到的那部分应用（`createApp` 的结果满足它）。拍子、让路、收件箱、到点都在编排器里；
 * 这里只管进程：接对话渠道、挂菜单和按键、盯气泡、信号。
 */
export interface DaemonApp {
  readonly config: Config;
  readonly paths: Paths;
  readonly logger: Logger;
  readonly host: PetHost;
  readonly model: LanguageModel | null;
  /** 启动时检查旧摘要用。 */
  readonly context: Pick<Context, 'session' | 'store' | 'builder'>;
  readonly director: Pick<Director, 'bake' | 'claim' | 'playForeign'>;
  readonly orchestrator: Pick<YoyoOrchestrator, 'whisper' | 'start'>;
  readonly opener: UrlOpener;
  /** 开本机对话渠道，关闭应用时一起关。 */
  openChannel(): Promise<Channel>;
  /** 开管理页，关闭应用时一起关。`web.enabled` 关着时是 null。 */
  openWeb(): Promise<{ readonly origin: string; readonly url: string } | null>;
  /** 起按键助手。由组装根决定：macOS 且 `hotkey.enabled` 才真的起，别处什么也不做。 */
  startHotkey(): void;
  /** 后台做子任务的；`tasks.enabled` 关着时是 null。 */
  readonly tasks?: { start(signal: AbortSignal): void } | null;
  close(): Promise<void>;
}

/** 桌宠还没开、对话渠道接不上时，隔这么久再接一次。 */
export const BIND_RETRY_MS = 30_000;
const RETRY_MS = 2000;

export const MENU_OWNER = 'yoyo';
export const MENU_LABELS: readonly string[] = ['碎碎念', '听一句'];
/** 打开管理页的那一项，`web.enabled` 打开时才挂。 */
export const MANAGE_LABEL = '管理';

export function menuLabels(config: Pick<Config, 'web'>): readonly string[] {
  return config.web.enabled ? [...MENU_LABELS, MANAGE_LABEL] : MENU_LABELS;
}

export function menuRequest(label: string): InboxRequest | null {
  if (label === '碎碎念') return 'whisper';
  if (label === '听一句') return 'listen';
  return null;
}

/** 桌宠右键对话要不要改走 yoyo：驱动桌宠、配了模型才接。回答在 yoyo 里跑，哪种 `llm.provider` 都行。 */
export function channelWanted(hostName: string, hasModel: boolean): boolean {
  return hasModel && hostName === 'dsh-pet';
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

export type ChannelApp = Pick<DaemonApp, 'config' | 'logger' | 'host' | 'model' | 'openChannel'>;

/**
 * 开本机对话渠道，让桌宠右键对话接上它。网关只开一次；桌宠还没开、接不上时隔 `retryMs` 再接，
 * 直到接上或 signal 中止。只记第一次失败。
 */
export async function connectChannel(app: ChannelApp, signal: AbortSignal, retryMs = BIND_RETRY_MS): Promise<void> {
  if (!channelWanted(app.host.name, app.model !== null)) return;
  let channel: Channel;
  try {
    channel = await app.openChannel();
  } catch (error) {
    app.logger.error(errorText(error));
    return;
  }
  let failed = false;
  while (!signal.aborted) {
    try {
      const saved = await app.host.bindChat({
        baseUrl: channel.baseUrl,
        model: app.config.llm.model,
        apiKey: channel.token,
      });
      app.logger.info(`对话渠道已接上 ${saved.model}`);
      return;
    } catch (error) {
      if (!failed) app.logger.error(`对话渠道还没接上桌宠，过一会儿再试：${errorText(error)}`);
      failed = true;
    }
    await delay(retryMs, undefined, { signal }).catch(() => {});
  }
}

/** 开着管理页就用浏览器打开（地址带着令牌）；从 yoyo.app 里跑时打开 app，管理页在它的窗口里。 */
async function openManager(app: DaemonApp): Promise<void> {
  const web = await app.openWeb();
  if (web) app.opener.open(app.paths.appBundle ?? web.url);
}

/** 起管理页，记一行地址（不带令牌）。没起成只记一行，右键「管理」时再试。 */
async function startManager(app: DaemonApp): Promise<void> {
  try {
    const web = await app.openWeb();
    if (web) app.logger.info(`管理页开在 ${web.origin}：右键「管理」或 yoyo web open 打开`);
  } catch (error) {
    app.logger.error(`管理页没开成：${errorText(error)}`);
  }
}

function watchMenu(app: DaemonApp, signal: AbortSignal): Promise<void> {
  return keepRunning(signal, app.logger, async () => {
    for await (const label of app.host.menu(MENU_OWNER, menuLabels(app.config), signal)) {
      if (label === MANAGE_LABEL) {
        openManager(app).catch((error: unknown) => app.logger.error(`管理页没打开：${errorText(error)}`));
        continue;
      }
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

export interface DaemonOptions {
  readonly once?: boolean;
  readonly bake?: boolean;
  /** 不发 SIGINT 也能停：中止后关掉应用，runDaemon 返回，不退出进程。换配置时、测试里用。 */
  readonly signal?: AbortSignal;
}

/** `--bake` 预合成，`--once` 说一句；否则常驻，直到 SIGINT/SIGTERM（或 `options.signal` 中止）。 */
export async function runDaemon(app: DaemonApp, options: DaemonOptions = {}): Promise<void> {
  if (options.bake || options.once) {
    try {
      if (options.bake) await app.director.bake();
      else await app.orchestrator.whisper();
    } finally {
      await app.close();
    }
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();

  /** 停下所有循环，关掉应用。收到信号时再退出进程。 */
  async function stop(exit: boolean): Promise<void> {
    if (signal.aborted) return;
    // 先停拍子和正在跑的模型，再关应用（关编排器、MCP、对话渠道）
    controller.abort();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      await app.close();
    } catch (error) {
      app.logger.error(errorText(error));
    }
    finish();
    if (exit) process.exit(0);
  }
  function onSignal(): void {
    void stop(true);
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (options.signal?.aborted) await stop(false);
  options.signal?.addEventListener('abort', () => void stop(false), { once: true });
  if (signal.aborted) return finished;

  // 升级前留下的旧摘要可能盖住了后写进来的记录：在渠道、拍子开始读写上下文之前修一次（命令行不跑）
  await recompactLossySummaries(app.context, { model: app.model, logger: app.logger, signal });
  if (signal.aborted) return finished;

  // 桌宠还没开时渠道会一直等着再接，不挡后面的事
  void connectChannel(app, signal);
  void startManager(app);
  void watchMenu(app, signal);
  app.startHotkey();
  void watchSayings(app, signal);

  app.orchestrator.start(signal);
  app.tasks?.start(signal);
  await finished;
}
