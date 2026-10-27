import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore as createSessionStore,
  createOrchestrator,
  type Context,
  type MemoryStore,
} from '@modelctx-ai/ctx';
import { createMemoryStore } from '@modelctx-ai/ctx-memory';
import { createScriptedDecisionModel } from '@modelctx-ai/ctx-protocol/testing';
import { MockLanguageModelV4 } from 'ai/test';

import { parseConfig } from '../app/config.ts';
import type { Line } from '../kernel/types.ts';
import type { Logger } from '../ports/index.ts';
import { generateReply, generateWhisper } from './compose.ts';
import { recordLine, recordUser, storePetChat, yoyoProjection } from './context.ts';
import { createYoyoHarness } from './harness.ts';
import {
  MEMORY_SOURCE,
  WHISPER_MEMORY_SOURCE,
  createSystemOneModels,
  createYoyoMemory,
  memorySecrets,
  memorySources,
  systemOneSpec,
  openMemoryStore,
  type YoyoMemory,
} from './memory.ts';
import { replyInstructions } from './prompts.ts';
import { taskSource } from './sources.ts';

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): DoGenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
}

const SESSION = 'pet:main';
const CORE = '主人叫小王，在写 yoyo。';
const WEATHER_FACT = '主人的天气地点是台北';
const MEETING_FACT = '主人周三下午开周会';

/** 照组装根的写法：任务来源加两个记忆来源，碎碎念、回复各收自己那个。 */
const FACT_SOURCES = {
  whisper: ['task', WHISPER_MEMORY_SOURCE],
  reply: ['task', MEMORY_SOURCE],
} as const;

async function addFact(store: MemoryStore, text: string, topic: string): Promise<void> {
  await store.facts.add({
    subject: 'user',
    text,
    topic,
    validFrom: 1,
    confidence: 0.9,
    salience: 0.8,
    sources: [{ session: SESSION, from: 1, upTo: 1 }],
  });
}

interface Rig {
  readonly context: Context;
  readonly memory: YoyoMemory;
  readonly runs: ReturnType<typeof createOrchestrator>;
}

/** 当前任务是「修天气地点」；记忆里有画像和两条事实。 */
async function rig(options: { readonly task?: string } = {}): Promise<Rig> {
  const deps = {
    host: { workStatus: async () => (options.task ? { state: null, task: options.task } : null) },
    repos: { tasks: { list: () => [] } },
  };
  const sessions = createSessionStore();
  const memory = createYoyoMemory({
    store: createMemoryStore(),
    sessions,
    config: parseConfig({ memory: { enabled: true } }).memory,
  });
  const context = createContext({
    store: sessions,
    session: SESSION,
    projection: yoyoProjection,
    sources: [taskSource(deps), ...memorySources(memory.memory, deps)],
  });
  await memory.store.core.set(CORE, 1);
  await addFact(memory.store, WEATHER_FACT, 'routine');
  await addFact(memory.store, MEETING_FACT, 'routine');
  return { context, memory, runs: createOrchestrator({ harness: createYoyoHarness(context) }) };
}

function lastText(model: MockLanguageModelV4): string {
  const content = model.doGenerateCalls[0]!.prompt.at(-1)?.content;
  return Array.isArray(content) ? content.map((part) => ('text' in part ? part.text : '')).join('') : '';
}

function systemText(model: MockLanguageModelV4): string {
  const first = model.doGenerateCalls[0]!.prompt[0];
  return first?.role === 'system' ? first.content : '';
}

describe('brain/memory 来源', () => {
  test('碎碎念：画像和按当前任务召回的事实放进最后一条临时消息，不带按用户话召回的', async () => {
    const { context, runs } = await rig({ task: '修天气地点' });
    await recordUser(context, '周三下午开周会', 1);
    const model = new MockLanguageModelV4({ doGenerate: textResult('天气地点改好了吗') });
    await generateWhisper(context, runs, {
      tone: 'calm',
      model,
      sources: FACT_SOURCES.whisper,
    });
    const text = lastText(model);
    assert.ok(text.startsWith('当前任务：修天气地点\n<memory>'), text);
    assert.ok(text.includes(CORE));
    assert.ok(text.includes(WEATHER_FACT));
    assert.ok(!text.includes(MEETING_FACT), '按任务召回，不按用户话');
    assert.ok(text.endsWith('\n\n请再说一句碎碎念。'));
    assert.equal(text.match(/<memory>/g)?.length, 1, '只带一份记忆');
  });

  test('碎碎念没有任务：只带画像', async () => {
    const { context, runs } = await rig();
    const model = new MockLanguageModelV4({ doGenerate: textResult('今天也安安静静的') });
    await generateWhisper(context, runs, {
      tone: 'calm',
      model,
      sources: FACT_SOURCES.whisper,
    });
    const text = lastText(model);
    assert.ok(text.includes(CORE));
    assert.ok(!text.includes(WEATHER_FACT));
    assert.ok(!text.includes(MEETING_FACT));
  });

  test('回复：画像和按最近一条用户话召回的事实接在指令后面', async () => {
    const { context, runs } = await rig({ task: '修天气地点' });
    await recordUser(context, '周三下午开周会', 1);
    const model = new MockLanguageModelV4({ doGenerate: textResult('记得呢，周三下午') });
    await generateReply(context, runs, { tone: 'warm', model, sources: FACT_SOURCES.reply });
    const system = systemText(model);
    assert.ok(system.startsWith(`${replyInstructions('warm')}\n\n当前任务：修天气地点\n<memory>`), system);
    assert.ok(system.includes(CORE));
    assert.ok(system.includes(MEETING_FACT));
    assert.ok(!system.includes(WEATHER_FACT), '按用户话召回，不按任务');
    assert.equal(system.match(/<memory>/g)?.length, 1);
  });

  test('记忆是空的：两个 agent 都没有记忆这一段', async () => {
    const deps = { host: { workStatus: async () => null }, repos: { tasks: { list: () => [] } } };
    const sessions = createSessionStore();
    const memory = createYoyoMemory({
      store: createMemoryStore(),
      sessions,
      config: parseConfig({ memory: { enabled: true } }).memory,
    });
    const context = createContext({ store: sessions, session: SESSION, sources: memorySources(memory.memory, deps) });
    assert.deepEqual(await context.builder.facts(SESSION), []);
  });

  test('记忆表放在 yoyo.db 里，前缀 memory_，和 ctx_ 表并排', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openMemoryStore(db);
    await store.core.set(CORE, 5);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    assert.ok(names.includes('memory_core'), names.join(','));
    assert.ok(names.includes('memory_facts'));
    assert.deepEqual(await openMemoryStore(db).core.get(), { text: CORE, at: 5 });
  });
});

function line(kind: Line['kind'], text: string): Line {
  return { text, kind, tone: 'warm', cue: '[relaxed]', action: '碎碎念-对屏碎碎念' };
}

describe('brain/memory 门控', () => {
  test('只看消息：用户话、回复、桌宠对话进门控；碎碎念、天气、提醒不进', async () => {
    const sessions = createSessionStore();
    const context = createContext({ store: sessions, session: SESSION, projection: yoyoProjection });
    const decision = createScriptedDecisionModel({ noul: 0.9, score: 1 });
    const { memory, store } = createYoyoMemory({
      store: createMemoryStore(),
      sessions,
      decision,
      config: parseConfig({ memory: { enabled: true } }).memory,
    });
    await recordLine(context, line('whisper', '碎碎念不进'), 1);
    await recordLine(context, line('weather', '傍晚有雨，天气不进'), 2);
    await recordUser(context, '我换到项目 Y 了', 3);
    await recordLine(context, line('reply', '好，记住了，项目 Y'), 4);
    await recordLine(context, line('reminder', '该开周会了，提醒不进'), 5);
    await storePetChat(context, [{ role: 'user', content: '右键对话说的也进', ts: 6 }]);

    const notes = await memory.gate(SESSION);
    assert.equal(decision.requests.length, 1);
    const state = JSON.stringify(decision.requests[0]!.state);
    for (const kept of ['我换到项目 Y 了', '好，记住了，项目 Y', '右键对话说的也进'])
      assert.ok(state.includes(kept), state);
    for (const dropped of ['不进']) assert.ok(!state.includes(dropped), state);
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0]!.from, notes[0]!.upTo], [3, 6]);
    assert.equal(notes[0]!.settledAt, undefined, '过了阈值，待处理');
    assert.equal(await store.notes.head(SESSION), 6);

    // 只剩天气：没有新条目，什么都不写，也不调决策模型
    await recordLine(context, line('weather', '明天晴，天气不进'), 7);
    assert.deepEqual(await memory.gate(SESSION), []);
    assert.equal(decision.requests.length, 1);
  });
});

describe('brain/memory 整理', () => {
  test('衰减归档和画像重写由 ctx 的 consolidate 做：用 config.memory 的归档阈值，有模型才重写画像', async () => {
    const day = 86_400_000;
    const now = 400 * day;
    const sessions = createSessionStore();
    const make = (config: Record<string, unknown>, model?: MockLanguageModelV4) =>
      createYoyoMemory({
        store: createMemoryStore(),
        sessions,
        config: parseConfig({ memory: { enabled: true, ...config } }).memory,
        ...(model ? { model } : {}),
        now: () => now,
      });
    /** 两天前的一条（激活度约 0.25）和刚记下的一条（约 1.96）。 */
    const seed = async ({ store }: YoyoMemory) => {
      const base = { subject: 'user', confidence: 0.9, sources: [{ session: SESSION, from: 1, upTo: 1 }] };
      await store.facts.add({ ...base, text: '主人在台北', topic: 'routine', validFrom: now - 2 * day, salience: 0.6 });
      await store.facts.add({
        ...base,
        text: '主人最近在写 yoyo',
        topic: 'work',
        validFrom: now - day / 10,
        salience: 0.9,
      });
    };

    const rewrite = new MockLanguageModelV4({ doGenerate: textResult('主人在台北，最近在写 yoyo。') });
    const loose = make({ decay: { archiveAt: 0.1 } }, rewrite);
    await seed(loose);
    const kept = await loose.memory.consolidate({ now });
    assert.equal(kept.facts.archived, 0, '归档阈值 0.1：都留着');
    assert.equal(kept.core, true);
    assert.equal((await loose.store.core.get())?.text, '主人在台北，最近在写 yoyo。', '有模型就让它重写画像');

    const usual = make({});
    await seed(usual);
    const report = await usual.memory.consolidate({ now });
    assert.equal(report.facts.archived, 1, '缺省阈值 0.55：两天前的那条归档');
    assert.deepEqual(
      (await usual.store.facts.list({ open: true })).map((fact) => fact.text),
      ['主人最近在写 yoyo'],
    );
    assert.equal((await usual.store.core.get())?.text, '主人最近在写 yoyo', '没有模型：画像是缺省渲染');
  });
});

function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => void lines.push(message),
    warn: (message) => void lines.push(message),
    error: (message) => void lines.push(message),
  };
}

describe('brain/memory System One', () => {
  test('配了就按 ctx-models 造决策、提取模型；不配就用 ctx 的缺省', () => {
    const logger = memoryLogger();
    const none = createSystemOneModels(parseConfig({ memory: { enabled: true } }).memory, logger);
    assert.deepEqual(none, {});
    const { memory } = parseConfig({
      memory: {
        decision: { provider: 'cloudflare', model: 'clef-flash', accountId: 'acc', apiKey: 'cf-decide' },
        extraction: { provider: 'cloudflare', model: 'clairic', accountId: 'acc', apiKey: 'cf-extract' },
      },
    });
    assert.deepEqual(systemOneSpec(memory.decision!), {
      provider: 'cloudflare',
      model: 'clef-flash',
      apiKey: 'cf-decide',
      accountId: 'acc',
    });
    const made = createSystemOneModels(memory, logger);
    assert.equal(typeof made.decision?.decide, 'function');
    assert.equal(typeof made.extraction?.extract, 'function');
    assert.deepEqual(logger.lines, []);
    assert.deepEqual(memorySecrets(memory), ['cf-decide', 'cf-extract']);
  });

  test('写得不对记一行，退回缺省：cloudflare 没有 accountId、没有 provider、认不得的服务商', () => {
    const logger = memoryLogger();
    const { memory } = parseConfig({
      memory: {
        decision: { provider: 'cloudflare', model: 'clef-flash', apiKey: 'cf-decide' },
        extraction: { provider: 'typesafe', model: 'jev' },
      },
    });
    assert.deepEqual(createSystemOneModels(memory, logger), {});
    assert.equal(logger.lines.length, 2);
    assert.match(logger.lines[0]!, /^config\.json 的 memory\.decision 不对：.*accountId.*，门控用启发式$/);
    assert.match(logger.lines[1]!, /^config\.json 的 memory\.extraction 不对：.*typesafe.*，提取交给 llm 的模型$/);
    const blank = createSystemOneModels(parseConfig({ memory: { decision: { model: 'clef' } } }).memory, logger);
    assert.deepEqual(blank, {});
    assert.match(logger.lines[2]!, /memory\.decision 不对：.*provider/);
  });
});
