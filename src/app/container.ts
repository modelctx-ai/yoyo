import type { DatabaseSync } from 'node:sqlite';

import type { Context, LanguageModel, ToolRegistry } from '@modelctx-ai/ctx';
import type { McpHub } from '@modelctx-ai/ctx-mcp';

import { createConsoleHost } from '../adapters/console/host.ts';
import { createDshPetHost } from '../adapters/dsh-pet/host.ts';
import { createMacOpener, createPbpasteClipboard, startHotkeyHelper } from '../adapters/platform/macos.ts';
import { noopClipboard, noopOpener } from '../adapters/platform/noop.ts';
import { createAnysearch } from '../adapters/search/anysearch.ts';
import { createAfplayPlayer } from '../adapters/voice/afplay.ts';
import { createFfmpegRecorder } from '../adapters/voice/ffmpeg.ts';
import { createFishSynthesizer } from '../adapters/voice/fish.ts';
import { createSfxPlayer } from '../adapters/voice/sfx.ts';
import { createSilentPlayer, silentSfx, silentSynthesizer } from '../adapters/voice/silent.ts';
import { createWhisperTranscriber } from '../adapters/voice/whisper-cpp.ts';
import { startChannel, type Channel } from '../brain/channel.ts';
import { createYoyoContext } from '../brain/context.ts';
import { connectMcp } from '../brain/mcp.ts';
import { createLanguageModel } from '../brain/model.ts';
import { clipboardSource, taskSource } from '../brain/sources.ts';
import { createYoyoTools } from '../brain/tools.ts';
import type {
  AudioPlayer,
  Clipboard,
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
import { createDirector, type Director } from '../runtime/director.ts';
import { openDatabase } from '../storage/db.ts';
import { createRepos } from '../storage/repos.ts';
import { speechReady, type AnysearchConfig, type Config } from './config.ts';
import { consoleLogger, errorText } from './log.ts';
import type { Paths } from './paths.ts';

/** 组装好的各项服务。测试可以用 `createApp` 的 overrides 换掉任意一项。 */
export interface AppServices {
  readonly logger: Logger;
  readonly db: DatabaseSync;
  readonly repos: Repos;
  readonly host: PetHost;
  readonly synthesizer: Synthesizer;
  readonly player: AudioPlayer;
  readonly sfx: SfxPlayer;
  readonly recorder: Recorder;
  readonly transcriber: Transcriber;
  readonly clipboard: Clipboard;
  readonly opener: UrlOpener;
  readonly search: WebSearch | null;
  readonly model: LanguageModel | null;
  /** 只有 `llm.tools` 打开时才有。 */
  readonly tools: ToolRegistry | undefined;
  readonly context: Context;
  readonly director: Director;
}

export interface App extends AppServices {
  readonly config: Config;
  readonly paths: Paths;
  /** 开本机对话渠道（只开一次），关闭应用时一起关。 */
  openChannel(): Promise<Channel>;
  /** 起按键助手：只有 macOS 且 `hotkey.enabled` 才起，别处什么也不做。 */
  startHotkey(): void;
  /** 关掉 MCP 连接和对话渠道。数据库留给进程退出时关。 */
  close(): Promise<void>;
}

export interface AppOverrides extends Partial<AppServices> {
  /** 测试用：当成哪个系统来挑实现。缺省是 `process.platform`。 */
  readonly platform?: NodeJS.Platform;
}

const darwin = process.platform === 'darwin';

export function createPetHost(config: Pick<Config, 'stage' | 'pet'>, logger: Logger): PetHost {
  return config.stage === 'console' ? createConsoleHost(logger) : createDshPetHost({ pet: config.pet, logger });
}

/** 只有 macOS 上有 pbpaste；别的系统读到的总是空。 */
export function createPlatformClipboard(): Clipboard {
  return darwin ? createPbpasteClipboard() : noopClipboard;
}

export function createPlatformOpener(): UrlOpener {
  return darwin ? createMacOpener() : noopOpener;
}

export function createSearch(anysearch: AnysearchConfig): WebSearch | null {
  return anysearch.script || anysearch.command?.length ? createAnysearch(anysearch) : null;
}

export async function createApp(config: Config, paths: Paths, overrides: AppOverrides = {}): Promise<App> {
  /** 有替身用替身（null 也算替身），否则现做一份。 */
  function use<K extends keyof AppServices>(key: K, make: () => AppServices[K]): AppServices[K] {
    const given = overrides[key];
    return given !== undefined ? (given as AppServices[K]) : make();
  }

  const mac = (overrides.platform ?? process.platform) === 'darwin';
  const logger = use('logger', () => consoleLogger);
  const db = use('db', () => openDatabase(paths.dbFile));
  const repos = use('repos', () => createRepos(db));
  const host = use('host', () => createPetHost(config, logger));
  const clipboard = use('clipboard', () => (mac ? createPbpasteClipboard() : noopClipboard));
  const opener = use('opener', () => (mac ? createMacOpener() : noopOpener));
  // 语音没配齐就只出字；不是 macOS 就不播放，也不做配音
  const synthesizer = use('synthesizer', () =>
    speechReady(config.speech)
      ? createFishSynthesizer({ speech: config.speech, cacheDir: paths.speechCacheDir })
      : silentSynthesizer,
  );
  const player = use('player', () => (mac ? createAfplayPlayer() : createSilentPlayer(logger)));
  const sfx = use('sfx', () => (mac ? createSfxPlayer({ dir: paths.sfxDir, player }) : silentSfx));
  const recorder = use('recorder', () => createFfmpegRecorder({ device: config.listen.device }));
  const transcriber = use('transcriber', () =>
    createWhisperTranscriber({
      modelDir: paths.modelsDir,
      model: config.asr.model,
      ...(config.asr.bin ? { bin: config.asr.bin } : {}),
    }),
  );
  const search = use('search', () => createSearch(config.anysearch));
  const model = use('model', () => createLanguageModel(config.llm));

  let mcp: McpHub | null = null;
  let tools = overrides.tools;
  if (!tools && config.llm.tools) {
    tools = createYoyoTools({ repos, search });
    mcp = await connectMcp(config.mcpServers, tools, logger);
  }

  const sources = [taskSource({ host, repos }), ...(config.clipboard.enabled ? [clipboardSource(repos)] : [])];
  let context: Context;
  try {
    context =
      overrides.context ??
      (await createYoyoContext({
        db,
        petId: config.pet.id,
        sources,
        logger,
        ...(tools ? { tools } : {}),
        ...(model ? { model } : {}),
        ...(config.context.maxTokens ? { maxTokens: config.context.maxTokens } : {}),
      }));
  } catch (error) {
    // 已经连上的 MCP 进程不能留着，不然进程退不出去
    await mcp?.close().catch(() => {});
    throw error;
  }

  const director = use('director', () =>
    createDirector({
      config,
      paths,
      logger,
      host,
      synthesizer,
      player,
      sfx,
      recorder,
      transcriber,
      search,
      opener,
      repos,
      context,
      model,
    }),
  );

  let channel: Promise<Channel> | null = null;
  let closed = false;

  return {
    config,
    paths,
    logger,
    db,
    repos,
    host,
    synthesizer,
    player,
    sfx,
    recorder,
    transcriber,
    clipboard,
    opener,
    search,
    model,
    tools,
    context,
    director,
    openChannel() {
      if (closed) return Promise.reject(new Error('yoyo 已经关闭'));
      if (!channel) {
        const pending = startChannel({ llm: config.llm, context, kv: repos.kv, logger });
        channel = pending;
        // 没开成就允许下次再试。
        pending.catch(() => {
          if (channel === pending) channel = null;
        });
      }
      return channel;
    },
    startHotkey() {
      if (!mac || !config.hotkey.enabled) return;
      startHotkeyHelper({ binDir: paths.binDir, source: paths.hotkeySource, inboxFile: paths.inboxFile, logger });
    },
    async close() {
      if (closed) return;
      closed = true;
      const opened = channel;
      channel = null;
      try {
        // 没开成的渠道不用关。
        const current = opened ? await opened.catch(() => null) : null;
        await current?.close();
      } catch (error) {
        logger.warn(`对话渠道没关好：${errorText(error)}`);
      }
      try {
        await mcp?.close();
      } catch (error) {
        logger.warn(`MCP 没关好：${errorText(error)}`);
      }
    },
  };
}
