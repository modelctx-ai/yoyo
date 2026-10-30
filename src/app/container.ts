import type { DatabaseSync } from 'node:sqlite';

import {
  createOrchestrator,
  type Context,
  type ContextSource,
  type Harness,
  type LanguageModel,
  type ToolRegistry,
} from '@modelctx-ai/ctx';
import type { McpHub } from '@modelctx-ai/ctx-mcp';

import { createConsoleHost } from '../adapters/console/host.ts';
import { createDshPetHost } from '../adapters/dsh-pet/host.ts';
import {
  createMacOpener,
  createPbpasteClipboard,
  startHotkeyHelper,
  type HotkeyHelper,
} from '../adapters/platform/macos.ts';
import { noopClipboard, noopOpener } from '../adapters/platform/noop.ts';
import { createAnysearch } from '../adapters/search/anysearch.ts';
import { createAfplayPlayer } from '../adapters/voice/afplay.ts';
import { createFfmpegRecorder } from '../adapters/voice/ffmpeg.ts';
import { createFishSynthesizer } from '../adapters/voice/fish.ts';
import { createSfxPlayer } from '../adapters/voice/sfx.ts';
import { createSilentPlayer, silentSfx, silentSynthesizer } from '../adapters/voice/silent.ts';
import { createWhisperTranscriber } from '../adapters/voice/whisper-cpp.ts';
import { startChannel, type Channel } from '../brain/channel.ts';
import { createTaskContext, createYoyoContext } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import {
  MEMORY_SOURCE,
  WHISPER_MEMORY_SOURCE,
  createSystemOneModels,
  createYoyoMemory,
  memorySecrets,
  memorySources,
  openMemoryStore,
  type YoyoMemory,
} from '../brain/memory.ts';
import { connectMcp } from '../brain/mcp.ts';
import { createLanguageModel } from '../brain/model.ts';
import { agentTasksSource, clipboardSource, taskSource } from '../brain/sources.ts';
import { addTaskWorkerTools, createYoyoTools } from '../brain/tools.ts';
import type { FactSources } from '../brain/agents.ts';
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
import { createYoyoOrchestrator, type ScheduleState, type YoyoOrchestrator } from '../runtime/orchestrator.ts';
import { createTaskRunner, type TaskRunner } from '../runtime/tasks.ts';
import { openDatabase } from '../storage/db.ts';
import { createRepos } from '../storage/repos.ts';
import { startWeb, type WebServer } from '../web/server.ts';
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
  /** 只有 `memory.enabled` 打开时才有。 */
  readonly memory: YoyoMemory | null;
  /** 跑一轮：组装上下文、调模型、分发工具。 */
  readonly harness: Harness;
  /** 舞台上的动作：说、听、提醒、预合成、压缩。 */
  readonly director: Director;
  /** 什么时候、在哪个会话上跑一轮：拍子、让路、收件箱、到点，模型经它交给 harness。 */
  readonly orchestrator: YoyoOrchestrator;
}

export interface App extends AppServices {
  readonly config: Config;
  readonly paths: Paths;
  /** 开本机对话渠道（只开一次），关闭应用时一起关。 */
  openChannel(): Promise<Channel>;
  /** 开管理页（只开一次），关闭应用时一起关。`web.enabled` 关着时是 null。 */
  openWeb(): Promise<WebServer | null>;
  /** 起按键助手：只有 macOS 且 `hotkey.enabled` 才起，别处什么也不做。 */
  startHotkey(): void;
  /** 后台做子任务的。`tasks.enabled` 关着时是 null。 */
  readonly tasks: TaskRunner | null;
  /** 关掉编排器（等正在跑的一轮）、按键助手、管理页、MCP 连接和对话渠道。数据库留给进程退出时关。 */
  close(): Promise<void>;
}

export interface AppOverrides extends Partial<AppServices> {
  /** 测试用：当成哪个系统来挑实现。缺省是 `process.platform`。 */
  readonly platform?: NodeJS.Platform;
  /** 换配置重建应用时接着上一个的，见 `Resume`。 */
  readonly resume?: Resume;
}

/** 换配置重建应用时从上一个接过来的：碎碎念的排期（不然一换就马上说一句），管理页的端口和令牌（开着的页面接着能用）。 */
export interface Resume {
  readonly schedule?: Partial<ScheduleState>;
  readonly webPort?: number;
  readonly webToken?: string;
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

  let context: Context;
  // 记忆只读会话日志；日志由下面的上下文打开，用到时 context 已经建好
  const memory = use('memory', () =>
    config.memory.enabled
      ? createYoyoMemory({
          store: openMemoryStore(db),
          sessions: { list: (session, options) => context.store.list(session, options) },
          config: config.memory,
          model,
          logger,
          ...createSystemOneModels(config.memory, logger, [config.llm.apiKey, ...memorySecrets(config.memory)]),
        })
      : null,
  );

  let mcp: McpHub | null = null;
  let tools = overrides.tools;
  if (!tools && config.llm.tools) {
    tools = createYoyoTools({ repos, search, tasks: config.tasks.enabled });
    mcp = await connectMcp(config.mcpServers, tools, logger, {
      sandbox: { config: config.sandbox, dataDir: paths.dataDir, configFile: paths.configFile },
    });
  }
  // recall 工具绑定在记忆这个执行环境上。只有回复给工具（碎碎念是 tools: false），所以只有回复用得到
  const recaller = tools && config.llm.tools && memory ? memory.memory : null;
  if (tools && recaller) for (const definition of await recaller.tools()) tools.add(definition);
  // 非本地工具的执行环境：MCP hub 和记忆，上下文和 harness 分发工具时都要用
  const executors = [...(mcp ? [mcp] : []), ...(recaller ? [recaller] : [])];

  const base: ContextSource[] = [
    taskSource({ host, repos }),
    ...(config.clipboard.enabled ? [clipboardSource(repos)] : []),
    ...(config.tasks.enabled ? [agentTasksSource(repos)] : []),
  ];
  const sources = memory ? [...base, ...memorySources(memory.memory, { host, repos })] : base;
  // 两个记忆来源的查询不一样：碎碎念只收按任务召回的那个，回复只收按用户话召回的那个
  const names = base.map((source) => source.name);
  const factSources: FactSources | undefined = memory
    ? { whisper: [...names, WHISPER_MEMORY_SOURCE], reply: [...names, MEMORY_SOURCE] }
    : undefined;
  try {
    context =
      overrides.context ??
      (await createYoyoContext({
        db,
        petId: config.pet.id,
        sources,
        logger,
        ...(tools ? { tools } : {}),
        ...(executors.length > 0 ? { executors } : {}),
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

  const harness = use('harness', () =>
    createYoyoHarness(context, { logger, ...(executors.length > 0 ? { executors } : {}) }),
  );
  // 碎碎念和回复都是 `record: false`：运行不写 `ctx.run.*`，不占会话，崩溃也没有断掉的运行要恢复，所以这里不配 `owner`，也不 `recover`。
  // 以后打开 `record` 时要做两件事：createYoyoOrchestrator 里的 createOrchestrator 配 `owner: 'yoyo'`（常驻进程和命令行共用一个库），
  // 并在 `start()` 和第一次 `submit` 之前 `await orchestrator.recover()`，否则崩溃留下的未结束运行会让会话一直 `session_busy`。
  const orchestrator = use('orchestrator', () =>
    createYoyoOrchestrator({
      config,
      paths,
      logger,
      repos,
      clipboard,
      search,
      context,
      harness,
      director,
      model,
      memory,
      ...(factSources ? { factSources } : {}),
      ...(overrides.resume?.schedule ? { state: overrides.resume.schedule } : {}),
    }),
  );

  // 子 agent：另一份注册表（本地工具、拆 todo 和交结果的工具，加上主线程那边 MCP 和记忆的工具，没有派子任务的），
  // 另一个上下文和 harness（同一个存储），和自己的编排器（`record: true`，所以配 owner、开始前 recover）
  let tasks: TaskRunner | null = null;
  if (config.tasks.enabled) {
    const worker = createYoyoTools({ repos, search });
    addTaskWorkerTools(worker, { repos });
    const shared = new Set(executors.map((executor) => executor.name));
    for (const definition of tools?.list() ?? []) {
      if (shared.has(definition.executor)) worker.add(definition, { replace: true });
    }
    const taskContext = createTaskContext(context, {
      sources,
      tools: worker,
      ...(executors.length > 0 ? { executors } : {}),
      model,
      logger,
    });
    const taskHarness = createYoyoHarness(taskContext, { logger, ...(executors.length > 0 ? { executors } : {}) });
    tasks = createTaskRunner({
      repos,
      logger,
      runs: createOrchestrator({ harness: taskHarness, store: context.store, owner: 'yoyo-tasks', logger }),
      model,
      main: context,
      // 结果写回主会话以后，叫醒主线程转告主人
      onFinished: (task) => orchestrator.relayTask(task.id),
      ...(factSources ? { sources: factSources.reply } : {}),
      secrets: [config.llm.apiKey].filter(Boolean),
    });
  }

  let channel: Promise<Channel> | null = null;
  let web: Promise<WebServer | null> | null = null;
  let hotkey: HotkeyHelper | null = null;
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
    memory,
    harness,
    director,
    orchestrator,
    tasks,
    openChannel() {
      if (closed) return Promise.reject(new Error('yoyo 已经关闭'));
      if (!channel) {
        const pending = startChannel({
          // 桌宠的请求在 yoyo 里跑完整的一轮：右键对话走回复的 agent，桌宠自己的碎碎念走碎碎念的
          answer: (ask, signal) =>
            ask.kind === 'whisper' ? orchestrator.petWhisper(signal) : orchestrator.chat(ask.text, signal),
          kv: repos.kv,
          logger,
        });
        channel = pending;
        // 没开成就允许下次再试。
        pending.catch(() => {
          if (channel === pending) channel = null;
        });
      }
      return channel;
    },
    openWeb() {
      if (closed) return Promise.reject(new Error('yoyo 已经关闭'));
      if (!config.web.enabled) return Promise.resolve(null);
      if (!web) {
        const { resume } = overrides;
        const open = (port: number): Promise<WebServer> =>
          startWeb({
            config,
            paths,
            repos,
            context,
            // 记忆没打开时库里也可能有以前记的，照样能看、能删
            memory: memory?.store ?? openMemoryStore(db),
            host,
            schedule: () => orchestrator.state,
            talk: (text) => orchestrator.talk(text),
            logger,
            port,
            ...(resume?.webToken ? { token: resume.webToken } : {}),
          });
        // 没固定端口时接着用上一个的；被别人占了就随机挑一个
        const reused = !config.web.port && resume?.webPort ? resume.webPort : 0;
        const pending = open(config.web.port || reused)
          .catch((error: unknown) => (reused ? open(0) : Promise.reject(error)))
          .then((server) => {
            // 令牌只在这个地址里：命令行的 `yoyo web open` 从这里取
            repos.kv.set('web-url', server.url);
            return server;
          });
        web = pending;
        pending.catch(() => {
          if (web === pending) web = null;
        });
      }
      return web;
    },
    startHotkey() {
      if (!mac || !config.hotkey.enabled) return;
      // 换配置时旧的应用关掉、新的再起一个，所以只留一个
      hotkey?.stop();
      hotkey = startHotkeyHelper({
        bin: paths.hotkeyBin,
        source: paths.hotkeySource,
        inboxFile: paths.inboxFile,
        logger,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      hotkey?.stop();
      hotkey = null;
      try {
        // 正在做的子任务放回排队，下次接着做
        await tasks?.close();
      } catch (error) {
        logger.warn(`子任务没停好：${errorText(error)}`);
      }
      try {
        await orchestrator.close();
      } catch (error) {
        logger.warn(`编排器没关好：${errorText(error)}`);
      }
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
        const page = web ? await web.catch(() => null) : null;
        web = null;
        await page?.close();
      } catch (error) {
        logger.warn(`管理页没关好：${errorText(error)}`);
      }
      try {
        await mcp?.close();
      } catch (error) {
        logger.warn(`MCP 没关好：${errorText(error)}`);
      }
    },
  };
}
