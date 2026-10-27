import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vite-plus/test';

import { MockLanguageModelV4 } from 'ai/test';

import { silentSfx, silentSynthesizer } from '../adapters/voice/silent.ts';
import { localDateKey } from '../kernel/time.ts';
import type { Director } from '../runtime/director.ts';
import { fakeDirector, memoryLogger } from '../runtime/testing.ts';
import { parseConfig } from './config.ts';
import { createApp } from './container.ts';
import { resolvePaths, type Paths } from './paths.ts';

function tempPaths(): Paths {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  return resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
}

const LLM = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'llm-key', model: 'mock-model' };

function memoryTables(app: { readonly db: DatabaseSync }): string[] {
  return (
    app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'").all() as {
      name: string;
    }[]
  )
    .map((row) => row.name)
    .toSorted();
}

function mockText(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/** 第几次模型调用里 `<memory>` 出现了几次（指令和消息都算）。 */
function memoryBlocks(model: MockLanguageModelV4, call: number): number {
  return JSON.stringify(model.doGenerateCalls[call]!.prompt).split('<memory>').length - 1;
}

describe('container', () => {
  test('控制台舞台：没配的搜索、模型、工具都留空；close 可以调两次', async () => {
    const app = await createApp(parseConfig({ stage: 'console' }), tempPaths(), { logger: memoryLogger() });
    assert.equal(app.host.name, 'console');
    assert.equal(app.search, null);
    assert.equal(app.model, null);
    assert.equal(app.tools, undefined);
    assert.equal(app.context.session, 'pet:main');
    assert.equal(typeof app.director.speak, 'function');
    assert.equal(typeof app.harness.run, 'function');
    assert.equal(typeof app.orchestrator.whisper, 'function');
    await app.close();
    await app.close();
    await assert.rejects(app.openChannel(), /已经关闭/);
  });

  test('桌宠舞台用 dsh-pet；配了 anysearch 才有搜索，llm.tools 打开才有工具', async () => {
    const config = parseConfig({
      pet: { id: 'desk' },
      llm: { ...LLM, tools: true },
      anysearch: { script: '/opt/anysearch/cli.js' },
    });
    const app = await createApp(config, tempPaths(), { logger: memoryLogger() });
    assert.equal(app.host.name, 'dsh-pet');
    assert.ok(app.search);
    assert.ok(app.model);
    assert.ok(app.tools && app.tools.size > 0);
    assert.equal(app.context.session, 'pet:desk');
    await app.close();
  });

  test('overrides 换掉任意一项，null 也算', async () => {
    const director = { choose: async () => null } as unknown as Director;
    const app = await createApp(parseConfig({ stage: 'console', llm: LLM }), tempPaths(), {
      logger: memoryLogger(),
      model: null,
      director,
    });
    assert.equal(app.model, null);
    assert.equal(app.director, director);
    await app.close();
  });

  test('memory 缺省关着：没有记忆、记忆表和记忆来源', async () => {
    const app = await createApp(parseConfig({ stage: 'console', llm: LLM }), tempPaths(), { logger: memoryLogger() });
    assert.equal(app.memory, null);
    assert.deepEqual(memoryTables(app), []);
    assert.deepEqual(await app.context.builder.facts(app.context.session), []);
    await app.close();
  });

  test('memory.enabled：记忆表建在 yoyo.db 里，两个记忆来源注册进上下文，两个 agent 各收一份', async () => {
    const model = mockText('在呢，周三下午开会');
    const app = await createApp(
      parseConfig({ stage: 'console', llm: LLM, listen: { enabled: true }, memory: { enabled: true } }),
      tempPaths(),
      {
        logger: memoryLogger(),
        model,
        director: fakeDirector([], { choose: async () => null, hear: async () => '周三下午开周会' }),
      },
    );
    assert.ok(app.memory);
    assert.deepEqual(memoryTables(app), [
      'memory_core',
      'memory_facts',
      'memory_meta',
      'memory_notes',
      'memory_procedures',
    ]);
    await app.memory.store.core.set('主人叫小王', 1);
    assert.deepEqual(
      (await app.context.builder.facts(app.context.session)).map((fact) => fact.source),
      ['memory', 'memory-whisper'],
    );
    // 碎碎念说完听一句、回复：两轮各只带一份记忆
    await app.orchestrator.whisper();
    assert.equal(model.doGenerateCalls.length, 2);
    assert.equal(memoryBlocks(model, 0), 1);
    assert.equal(memoryBlocks(model, 1), 1);
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt[0]), /主人叫小王/, '回复接在指令后面');
    await app.close();
  });

  test('recall 工具：只在记忆打开、llm.tools 打开时注册，只交给回复，调用走记忆这个执行环境', async () => {
    const off = await createApp(parseConfig({ stage: 'console', llm: { ...LLM, tools: true } }), tempPaths(), {
      logger: memoryLogger(),
    });
    assert.equal(off.tools?.has('recall'), false, '记忆没开');
    await off.close();
    const plain = await createApp(parseConfig({ stage: 'console', llm: LLM, memory: { enabled: true } }), tempPaths(), {
      logger: memoryLogger(),
    });
    assert.equal(plain.tools, undefined, 'llm.tools 没开就没有注册表');
    await plain.close();

    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: 'text', text: '主人还在忙项目吗' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'recall', input: JSON.stringify({ query: '项目' }) },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: '你在做项目 Y 呀' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      ],
    });
    const app = await createApp(
      parseConfig({
        stage: 'console',
        llm: { ...LLM, tools: true },
        listen: { enabled: true },
        memory: { enabled: true },
      }),
      tempPaths(),
      {
        logger: memoryLogger(),
        model,
        director: fakeDirector([], { choose: async () => null, hear: async () => '我在做什么项目来着' }),
      },
    );
    assert.equal(app.tools?.has('recall'), true);
    await app.memory!.store.facts.add({
      subject: 'user',
      text: '主人在做项目 Y',
      topic: 'work',
      validFrom: 1,
      confidence: 0.9,
      salience: 0.8,
      sources: [{ session: 'pet:main', from: 1, upTo: 1 }],
    });
    await app.orchestrator.whisper();
    assert.equal(model.doGenerateCalls.length, 3);
    assert.equal(model.doGenerateCalls[0]!.tools, undefined, '碎碎念不给工具');
    assert.ok(
      model.doGenerateCalls[1]!.tools?.some((item) => item.name === 'recall'),
      '回复给 recall',
    );
    const result = JSON.stringify(model.doGenerateCalls[2]!.prompt.filter((message) => message.role === 'tool'));
    assert.match(result, /主人在做项目 Y/, '工具结果是记忆里的事实');
    await app.close();
  });

  test('对话渠道只开一次，记下地址和令牌，关闭应用时一起关', async () => {
    const app = await createApp(parseConfig({ stage: 'console', llm: LLM }), tempPaths(), { logger: memoryLogger() });
    const channel = await app.openChannel();
    assert.equal(await app.openChannel(), channel);
    assert.match(channel.baseUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(app.repos.kv.get('channel-base'), channel.baseUrl);
    assert.equal(app.repos.kv.get('channel-token'), channel.token);
    await app.close();
    await assert.rejects(fetch(`${channel.baseUrl}/chat/completions`, { method: 'POST', body: '{}' }));
  });

  test('控制台舞台、没配语音、不是 macOS：只出字，不合成也不播放，按键助手不起', async () => {
    const logger = memoryLogger();
    const paths = tempPaths();
    const app = await createApp(parseConfig({ stage: 'console' }), paths, { logger, platform: 'linux' });
    assert.equal(app.synthesizer, silentSynthesizer);
    assert.equal(app.sfx, silentSfx);
    assert.equal(await app.synthesizer.synthesize('你好', '[happy]'), '');
    await app.player.play('/x.mp3');
    app.player.fire('/x.mp3');
    assert.deepEqual(logger.lines, ['这台机器不是 macOS，没有 afplay，语音和配音都不播放'], '只说一次');
    app.startHotkey();
    assert.equal(existsSync(paths.binDir), false);

    // 导演用真时钟：先记下今天报过天气，免得赶上下班时间去联网查
    app.repos.kv.set('weather-date', localDateKey(new Date()));
    logger.lines.length = 0;
    const result = await app.orchestrator.whisper();
    assert.ok(result);
    assert.equal(logger.lines[0], `[${result.line.action}] ${result.line.text}`);
    assert.equal(existsSync(paths.speechCacheDir), false, '没有合成');
    assert.equal(existsSync(paths.sfxDir), false, '也没有生成配音');
    await app.close();
  });

  test('语音配齐用 Fish；macOS 上用 afplay 和配音', async () => {
    const config = parseConfig({ stage: 'console', speech: { apiKey: 'fish-key', referenceId: 'ref' } });
    const app = await createApp(config, tempPaths(), { logger: memoryLogger(), platform: 'darwin' });
    assert.notEqual(app.synthesizer, silentSynthesizer);
    assert.notEqual(app.sfx, silentSfx);
    await assert.rejects(app.player.play('/不存在/x.mp3'), '真的去调 afplay');
    await app.close();
  });
});
