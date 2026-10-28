import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  createContext,
  createMemoryStore,
  userEntry,
  type Context,
  type Entry,
  type LanguageModel,
} from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { silentSynthesizer } from '../adapters/voice/silent.ts';
import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { sessionFor, yoyoProjection } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import { LINES, REPEAT_WINDOW_MS } from '../features/whisper/catalog.ts';
import { TONE_CUES } from '../kernel/tone.ts';
import type { PetChatMessage, ScheduleItem } from '../kernel/types.ts';
import type { Repos } from '../ports/index.ts';
import { createDirector, type Director } from './director.ts';
import { createYoyoOrchestrator, type YoyoOrchestrator } from './orchestrator.ts';
import {
  fakeHost,
  fakeOpener,
  fakePlayer,
  fakeRecorder,
  fakeSearch,
  fakeSfx,
  fakeSynthesizer,
  fakeTranscriber,
  memoryLogger,
  memoryRepos,
  type FakeHostOptions,
  type FakeRecorder,
  type MemoryLogger,
} from './testing.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
}

/** 按调用顺序依次回这些话。 */
function mockModel(...texts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: texts.map(textResult) });
}

/** 周六下午三点：语气活泼，不报天气。 */
const SATURDAY = new Date(2026, 9, 24, 15, 0, 0);
/** 周五 17:30：该报下班天气了。 */
const FRIDAY_EVENING = new Date(2026, 9, 23, 17, 30, 0);

interface RigOptions {
  readonly config?: Record<string, unknown>;
  readonly model?: LanguageModel | null;
  readonly heard?: string;
  readonly confirm?: (text: string) => Promise<string>;
  readonly now?: Date;
  readonly rand?: () => number;
  readonly fetch?: typeof fetch;
  readonly host?: FakeHostOptions;
  /** 搜索结果；给 Error 就让搜索失败。 */
  readonly search?: string | Error;
  /** 用没配语音时的合成器：返回空路径。 */
  readonly silent?: boolean;
  readonly recordError?: Error;
}

interface Rig {
  readonly calls: string[];
  readonly logger: MemoryLogger;
  readonly repos: Repos;
  readonly context: Context;
  readonly recorder: FakeRecorder;
  readonly director: Director;
  /** 碎碎念、听一句这两段经它：模型的每一轮由它交给 harness。 */
  readonly orchestrator: YoyoOrchestrator;
  readonly confirmed: string[];
  readonly now: Date;
}

function rig(options: RigOptions = {}): Rig {
  const calls: string[] = [];
  const confirmed: string[] = [];
  const logger = memoryLogger();
  const now = options.now ?? SATURDAY;
  const repos = memoryRepos({ now: () => now });
  const context = createContext({
    store: createMemoryStore({ now: () => now.getTime() }),
    session: sessionFor('main'),
    projection: yoyoProjection,
  });
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const config = parseConfig({
    speech: { apiKey: 'fish-key', referenceId: 'ref' },
    llm: { baseUrl: 'https://llm.example/v1', apiKey: 'llm-key', model: 'mock' },
    ...options.config,
  });
  const recorder = fakeRecorder(calls, options.recordError);
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  const search = options.search === undefined ? null : fakeSearch(calls, options.search);
  const model = options.model ?? null;
  const director = createDirector({
    config,
    paths,
    logger,
    host: fakeHost(calls, options.host),
    synthesizer: options.silent ? silentSynthesizer : fakeSynthesizer(calls),
    player: fakePlayer(calls),
    sfx: fakeSfx(calls),
    recorder,
    transcriber: fakeTranscriber(calls, () => options.heard ?? ''),
    search,
    opener: fakeOpener(calls),
    repos,
    context,
    model,
    now: () => now,
    rand: options.rand ?? (() => 0.99),
    confirm:
      options.confirm ??
      (async (text) => {
        confirmed.push(text);
        return text;
      }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const orchestrator = createYoyoOrchestrator({
    config,
    paths,
    logger,
    repos,
    clipboard: { read: () => '' },
    search,
    context,
    harness: createYoyoHarness(context),
    director,
    model,
    clock: () => now.getTime(),
  });
  return { calls, logger, repos, context, recorder, director, orchestrator, confirmed, now };
}

function types(repos: Repos): string[] {
  return repos.activity.list(100).map((event) => event.type);
}

function shape(entries: readonly Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'message') {
      const { content } = entry.message;
      return `${entry.message.role}:${typeof content === 'string' ? content : '[parts]'}`;
    }
    if (entry.type === 'event') return `${entry.kind}:${entry.text ?? ''}`;
    return 'summary';
  });
}

function promptText(model: MockLanguageModelV4, index = 0): string {
  return JSON.stringify(model.doGenerateCalls[index]?.prompt ?? null);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** 从 17:00 起 8 小时的逐时预报。 */
function forecast(): unknown {
  const time = Array.from({ length: 8 }, (_, i) => `2026-10-23T${String(17 + i).padStart(2, '0')}:00`);
  return {
    hourly: {
      time,
      temperature_2m: [24, 23, 22, 21, 20, 19, 18, 18],
      precipitation_probability: [10, 10, 60, 70, 20, 10, 0, 0],
      weather_code: [1, 2, 61, 61, 3, 1, 0, 0],
    },
  };
}

const TAIPEI = JSON.stringify({ name: '台北', latitude: 25.0375, longitude: 121.5637 });

function noLines(repos: Repos, at: number): void {
  for (const line of LINES) repos.spoken.remember(line.text, at - 60_000, REPEAT_WINDOW_MS);
}

describe('director：说、听、提醒（碎碎念和听一句经编排器）', () => {
  test('预制台词：先在锁外合成，再占锁、投喂、点播、配音、播放、放锁；行为、窗口和上下文都记下', async () => {
    const { calls, repos, context, orchestrator, logger, now } = rig();
    const result = await orchestrator.whisper();
    assert.ok(result);
    const { line } = result;
    assert.equal(result.talked, false, '没配模型就不听');
    assert.equal(line.kind, 'whisper');
    assert.ok(LINES.some((item) => item.text === line.text));
    assert.deepEqual(calls, [
      `synth:${line.cue} ${line.text}`,
      'lock',
      `broadcast:${line.text}`,
      `anim:${line.action}`,
      `sfx:${line.action}`,
      `play:voice/${line.text}.mp3`,
      'release',
    ]);
    assert.deepEqual(types(repos), [line.tone, 'sfx']);
    assert.equal(repos.activity.list(100)[0]?.['text'], line.text);
    assert.deepEqual(
      repos.spoken.recent(now.getTime(), REPEAT_WINDOW_MS).map((item) => item.text),
      [line.text],
    );
    assert.deepEqual(shape(await context.entries()), [`whisper:${line.text}`]);
    assert.ok(logger.lines.includes(`${line.tone} ${line.action} ${line.text.length}字`));
  });

  test('speech.autoplay 关掉时只出字，不播语音', async () => {
    const { calls, orchestrator } = rig({ config: { speech: { apiKey: 'k', referenceId: 'r', autoplay: false } } });
    await orchestrator.whisper();
    assert.equal(
      calls.some((call) => call.startsWith('play:')),
      false,
    );
    assert.ok(calls.includes('release'));
  });

  test('碎碎念有时带上一张表情包', async () => {
    const { calls, repos, orchestrator } = rig({ rand: () => 0 });
    repos.memes.write({ fetchedAt: SATURDAY.toISOString(), query: 'q', items: [{ url: 'https://example.com/a.png' }] });
    const result = await orchestrator.whisper();
    assert.equal(result?.line.imageUrl, 'https://example.com/a.png');
    assert.ok(calls.includes(`broadcast:${result?.line.text} https://example.com/a.png`));
    assert.equal(repos.activity.list(100)[0]?.['meme'], 'https://example.com/a.png');
  });

  test('memes.enabled 关掉时碎碎念不配表情包', async () => {
    const { repos, orchestrator } = rig({ rand: () => 0, config: { memes: { enabled: false } } });
    repos.memes.write({ fetchedAt: SATURDAY.toISOString(), query: 'q', items: [{ url: 'https://example.com/a.png' }] });
    const result = await orchestrator.whisper();
    assert.equal(result?.line.imageUrl, undefined);
  });

  test('sfx.enabled 关掉时不放音效，也不记一笔', async () => {
    const { calls, repos, orchestrator } = rig({ config: { sfx: { enabled: false } } });
    const result = await orchestrator.whisper();
    assert.equal(
      calls.some((call) => call.startsWith('sfx:')),
      false,
    );
    assert.deepEqual(types(repos), [result?.line.tone]);
  });

  test('快下班先报天气：说完记下日期，不进 3 小时窗口，也不听回应', async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input));
      return jsonResponse(forecast());
    }) as typeof fetch;
    const model = mockModel('不该用到');
    const { repos, context, director, orchestrator, calls, now } = rig({ now: FRIDAY_EVENING, fetch: fetcher, model });
    repos.kv.set('place', TAIPEI);
    const result = await orchestrator.whisper();
    assert.equal(result?.line.kind, 'weather');
    assert.match(result?.line.text ?? '', /^快下班啦。台北/);
    assert.equal(result?.talked, false);
    assert.ok(asked.some((url) => url.startsWith('https://api.open-meteo.com/')));
    assert.equal(repos.kv.get('weather-date'), '2026-10-23');
    assert.deepEqual(repos.spoken.recent(now.getTime(), REPEAT_WINDOW_MS), []);
    assert.deepEqual(types(repos), ['weather', 'sfx']);
    assert.deepEqual(shape(await context.entries()), [`assistant:${result?.line.text}`]);
    assert.equal(
      calls.some((call) => call.startsWith('record:')),
      false,
    );
    assert.equal(model.doGenerateCalls.length, 0);

    const again = await director.choose(now);
    assert.equal(again?.kind, 'whisper', '同一天只报一次');
  });

  test('weather.enabled 关掉时傍晚也不报天气，不查天气', async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input));
      return jsonResponse(forecast());
    }) as typeof fetch;
    const { repos, orchestrator } = rig({
      now: FRIDAY_EVENING,
      fetch: fetcher,
      config: { weather: { enabled: false } },
    });
    repos.kv.set('place', TAIPEI);
    const result = await orchestrator.whisper();
    assert.equal(result?.line.kind, 'whisper');
    assert.deepEqual(asked, []);
  });

  test('天气没查到就改说一句预制台词', async () => {
    const fetcher = (async () => {
      throw new Error('网络断了');
    }) as typeof fetch;
    const { repos, orchestrator, logger } = rig({ now: FRIDAY_EVENING, fetch: fetcher });
    repos.kv.set('place', TAIPEI);
    const result = await orchestrator.whisper();
    assert.equal(result?.line.kind, 'whisper');
    assert.ok(logger.lines.some((line) => line.startsWith('天气没查到')));
    assert.equal(repos.kv.get('weather-date'), null);
  });

  test('到点提醒：说完记下这次响过；任务前面加「到点了。」', async () => {
    const now = new Date(2026, 9, 23, 18, 1, 0);
    const { repos, context, director } = rig({ now });
    const item: ScheduleItem = {
      id: 's_1',
      title: '周报',
      kind: 'task',
      time: '18:00',
      date: null,
      repeat: 'weekdays',
      weekday: null,
      enabled: true,
      lastFired: null,
    };
    repos.schedule.insert(item);
    await director.remind(item, now);
    assert.equal(repos.schedule.list()[0]?.lastFired, '2026-10-23T18:00');
    assert.deepEqual(types(repos), ['reminder', 'sfx']);
    assert.deepEqual(shape(await context.entries()), ['assistant:到点了。周报']);
  });

  test('主动听：听到 → 确认 → 先记用户这句，再回复并说出来；录音文件删掉', async () => {
    const model = mockModel('好呀，我陪你一起喝水');
    const { calls, repos, context, orchestrator, recorder, confirmed, logger } = rig({ model, heard: '提醒我喝水' });
    const result = await orchestrator.listen();
    assert.deepEqual(result, { talked: true });
    assert.deepEqual(confirmed, ['提醒我喝水']);
    assert.ok(calls.includes('cue:碎碎念-对屏碎碎念'));
    assert.ok(calls.includes('record:5'));
    assert.equal(recorder.files.length, 1);
    assert.equal(existsSync(recorder.files[0]!), false, '录音用完就删');
    assert.ok(logger.lines.includes('听 5 秒'));
    assert.ok(logger.lines.includes('听到 5字'));
    assert.deepEqual(types(repos), ['listen-request', 'listen', 'reply', 'sfx']);
    assert.deepEqual(shape(await context.entries()), ['user:提醒我喝水', 'assistant:好呀，我陪你一起喝水']);
    assert.ok(promptText(model).includes('提醒我喝水'));
    assert.equal(
      calls.some((call) => call.startsWith('search:')),
      false,
      '不像提问就不搜',
    );
  });

  test('像提问就先搜一下，结果交给模型；打开工具时交给模型自己搜', async () => {
    const model = mockModel('台北今天晴，二十五度');
    const asked = rig({ model, heard: '今天台北天气怎么样？', search: '台北 晴 25 度' });
    await asked.orchestrator.listen();
    assert.ok(asked.calls.includes('search:今天台北天气怎么样？'));
    assert.ok(types(asked.repos).includes('search'));
    assert.ok(promptText(model).includes('台北 晴 25 度'));

    const tooled = rig({
      model: mockModel('台北今天晴'),
      heard: '今天台北天气怎么样？',
      search: '台北 晴 25 度',
      config: { llm: { baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'mock', tools: true } },
    });
    await tooled.orchestrator.listen();
    assert.equal(
      tooled.calls.some((call) => call.startsWith('search:')),
      false,
    );
  });

  test('搜索失败只记一行，照样回复', async () => {
    const model = mockModel('我没查到，先陪着你');
    const { orchestrator, logger, context, repos } = rig({
      model,
      heard: '最新新闻是什么？',
      search: new Error('anysearch 退出 1'),
    });
    assert.deepEqual(await orchestrator.listen(), { talked: true });
    assert.ok(logger.lines.includes('搜索没做成：anysearch 退出 1'));
    assert.equal(types(repos).includes('search'), false);
    assert.deepEqual(shape(await context.entries()), ['user:最新新闻是什么？', 'assistant:我没查到，先陪着你']);
  });

  test('确认页取消：记一笔 confirm-cancel，也算说过话，不回复', async () => {
    const model = mockModel('不该用到');
    const { repos, orchestrator, logger, context } = rig({ model, heard: '算了不说了', confirm: async () => '' });
    assert.deepEqual(await orchestrator.listen(), { talked: true });
    assert.ok(logger.lines.includes('听写没有发出'));
    const cancel = repos.activity.list(100).find((event) => event.type === 'confirm-cancel');
    assert.equal(cancel?.['text'], '算了不说了');
    assert.equal(model.doGenerateCalls.length, 0);
    assert.deepEqual(await context.entries(), []);
  });

  test('没听清：不确认也不回复', async () => {
    const { orchestrator, logger, confirmed } = rig({ model: mockModel('不该用到'), heard: '嗯' });
    assert.deepEqual(await orchestrator.listen(), { talked: false });
    assert.ok(logger.lines.includes('没听到'));
    assert.deepEqual(confirmed, []);
  });

  test('侧耳听的动作没播成只告警，照样听', async () => {
    const { orchestrator, logger } = rig({
      heard: '在吗在吗',
      host: { cue: async () => Promise.reject(new Error('动作不在池内')) },
    });
    assert.deepEqual(await orchestrator.listen(), { talked: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logger.lines.includes('侧耳听没播成（碎碎念-对屏碎碎念）：动作不在池内'));
  });

  test('碎碎念念完听回应：听到就回复，算说过话', async () => {
    const model = mockModel('那我们就歇五分钟');
    const { orchestrator, context, calls } = rig({ model, heard: '我有点累了', config: { listen: { enabled: true } } });
    const result = await orchestrator.whisper();
    assert.equal(result?.talked, true);
    assert.ok(calls.includes('record:5'));
    const entries = shape(await context.entries());
    assert.deepEqual(entries.slice(1), ['user:我有点累了', 'assistant:那我们就歇五分钟']);
    assert.match(entries[0] ?? '', /^whisper:/);
  });

  test('碎碎念之后没听成只记一行，不算说过话', async () => {
    const { orchestrator, logger } = rig({
      model: mockModel('不该用到'),
      recordError: new Error('麦克风被占用'),
      config: { listen: { enabled: true } },
    });
    const result = await orchestrator.whisper();
    assert.equal(result?.talked, false);
    assert.ok(logger.lines.includes('没听成：麦克风被占用'));
  });

  test('没写 listen 就不听，和旧代码一样', async () => {
    const { orchestrator, calls } = rig({ model: mockModel('不该用到'), heard: '我在' });
    const result = await orchestrator.whisper();
    assert.equal(result?.talked, false);
    assert.equal(
      calls.some((call) => call.startsWith('record:')),
      false,
    );
  });

  test('没配语音（合成出空路径）时只出字，不播放；bake 和朗读桌宠回复也不做', async () => {
    const { director, orchestrator, calls, logger, repos } = rig({ silent: true });
    const result = await orchestrator.whisper();
    assert.ok(result);
    const { line } = result;
    assert.deepEqual(calls, ['lock', `broadcast:${line.text}`, `anim:${line.action}`, `sfx:${line.action}`, 'release']);
    assert.deepEqual(types(repos), [line.tone, 'sfx']);
    await director.bake();
    assert.ok(logger.lines.includes('语音没配好，没有可预合成的'));
    assert.equal(await director.playForeign('桌宠的回复'), false);
    assert.equal(types(repos).includes('chat-voice'), false);
  });

  test('listen.enabled 关掉时碎碎念念完不听', async () => {
    const { orchestrator, calls } = rig({ model: mockModel('不该用到'), config: { listen: { enabled: false } } });
    const result = await orchestrator.whisper();
    assert.equal(result?.talked, false);
    assert.equal(
      calls.some((call) => call.startsWith('record:')),
      false,
    );
  });

  test('预制台词都说过了就按上下文写一句；没有模型就这次先停', async () => {
    const model = mockModel('主人写了好久代码，喝口水吧');
    const generated = rig({ model, config: { listen: { enabled: false } } });
    noLines(generated.repos, generated.now.getTime());
    const result = await generated.orchestrator.whisper();
    assert.equal(result?.line.kind, 'generated');
    assert.equal(result?.line.text, '主人写了好久代码，喝口水吧');
    assert.equal(result?.line.cue, TONE_CUES.lively);
    assert.ok(generated.logger.lines.includes('预制台词用完了，按最近的对话和任务写一句'));
    assert.deepEqual(types(generated.repos), ['reply', 'sfx']);
    assert.deepEqual(shape(await generated.context.entries()), ['whisper:主人写了好久代码，喝口水吧']);

    const silent = rig();
    noLines(silent.repos, silent.now.getTime());
    assert.equal(await silent.orchestrator.whisper(), null);
    assert.ok(silent.logger.lines.includes('这 3 小时里的碎碎念都说过了，这次先停'));
    assert.deepEqual(types(silent.repos), ['whisper-skip']);
    assert.deepEqual(silent.calls, []);
  });

  test('桌宠自己的对话回复念一遍；yoyo 自己投喂的和 claim 过的不念', async () => {
    const { director, orchestrator, calls, repos, logger } = rig({
      config: { speech: { apiKey: 'k', referenceId: 'r', tone: 'calm' } },
    });
    assert.equal(await director.playForeign('  今天也辛苦啦  '), true);
    assert.ok(calls.includes(`synth:${TONE_CUES.calm} 今天也辛苦啦`));
    assert.ok(calls.includes('play:voice/今天也辛苦啦.mp3'));
    assert.ok(logger.lines.includes('对话朗读 6字'));
    assert.equal(repos.activity.list(100).at(-1)?.type, 'chat-voice');
    assert.equal(await director.playForeign('今天也辛苦啦'), false, '同一句不念两遍');

    director.claim('启动时就在气泡里的话');
    assert.equal(await director.playForeign('启动时就在气泡里的话'), false);

    const result = await orchestrator.whisper();
    assert.equal(await director.playForeign(result?.line.text ?? ''), false);
    assert.equal(await director.playForeign('   '), false);
  });

  test('speech.autoplay 关掉时桌宠的回复不念', async () => {
    const { director, calls } = rig({ config: { speech: { apiKey: 'k', referenceId: 'r', autoplay: false } } });
    assert.equal(await director.playForeign('你好呀'), false);
    assert.deepEqual(calls, []);
  });

  test('桌宠对话记忆并进上下文，重复的不再记；读不到也不报错', async () => {
    const chat: PetChatMessage[] = [
      { role: 'user', content: '在吗', ts: 1_000 },
      { role: 'assistant', content: '在的', ts: 2_000 },
    ];
    let failing = false;
    const { director, context } = rig({
      host: { chat: async () => (failing ? Promise.reject(new Error('桌宠没开')) : chat) },
    });
    await director.syncPetChat();
    await director.syncPetChat();
    assert.deepEqual(shape(await context.entries()), ['user:在吗', 'assistant:在的']);
    failing = true;
    await director.syncPetChat();
  });

  test('配了 compactAt 而且历史太长才压缩', async () => {
    const model = mockModel('之前聊了喝水和周报');
    const long = rig({ model, config: { context: { compactAt: 10, keep: 2 } } });
    for (let i = 0; i < 6; i += 1) {
      await long.context.append(
        userEntry(`第 ${i} 句用户的话，稍微长一点`),
        assistantEntry(`第 ${i} 句回复，也长一点`),
      );
    }
    assert.equal(await long.director.compactIfNeeded(), true);
    const view = await long.context.view();
    assert.ok(view.summary);
    assert.ok(long.logger.lines.some((line) => line.startsWith('上下文压成摘要')));

    const off = rig({ model: mockModel('不该用到') });
    await off.context.append(userEntry('x'.repeat(500)));
    assert.equal(await off.director.compactIfNeeded(), false);
    const noModel = rig({ config: { context: { compactAt: 1 } } });
    await noModel.context.append(userEntry('x'.repeat(500)));
    assert.equal(await noModel.director.compactIfNeeded(), false);
  });

  test('bake 把预制台词都合成一遍', async () => {
    const { director, calls, logger } = rig();
    await director.bake();
    assert.equal(calls.filter((call) => call.startsWith('synth:')).length, LINES.length);
    const first = LINES[0]!;
    assert.ok(logger.lines.includes(`bake ${first.tone} ${first.text.length}字 voice/${first.text}.mp3`));
  });

  test('没有搜索时 refreshMemes 返回现有的那套', async () => {
    const { director, repos } = rig();
    assert.equal(await director.refreshMemes(SATURDAY, { force: true }), null);
    const pack = { fetchedAt: SATURDAY.toISOString(), query: 'q', items: [{ url: 'https://example.com/a.png' }] };
    repos.memes.write(pack);
    assert.deepEqual(await director.refreshMemes(SATURDAY, { force: true }), pack);
  });
});
