import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { sessionFor, yoyoProjection } from '../brain/context.ts';
import { createYoyoHarness } from '../brain/harness.ts';
import { channelPlan, connectChannel, menuRequest, runDaemon, type ChannelApp, type DaemonApp } from './daemon.ts';
import { drain } from './inbox.ts';
import { createYoyoOrchestrator } from './orchestrator.ts';
import { fakeDirector, fakeHost, memoryLogger, memoryRepos } from './testing.ts';

describe('daemon 菜单和渠道', () => {
  test('右键菜单的两项各对应一种请求', () => {
    assert.equal(menuRequest('碎碎念'), 'whisper');
    assert.equal(menuRequest('听一句'), 'listen');
    assert.equal(menuRequest('别的'), null);
  });

  test('只有桌宠宿主、配了模型、openai-compatible 才开对话渠道', () => {
    const openai = parseConfig({ llm: { provider: 'openai-compatible' } });
    const anthropic = parseConfig({ llm: { provider: 'anthropic' } });
    assert.equal(channelPlan(openai, 'dsh-pet', true), 'open');
    assert.equal(channelPlan(anthropic, 'dsh-pet', true), 'unsupported');
    assert.equal(channelPlan(openai, 'console', true), 'skip');
    assert.equal(channelPlan(openai, 'dsh-pet', false), 'skip');
  });
});

describe('daemon 对话渠道', () => {
  const LLM = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'llm-key', model: 'mock-model' };

  function channelRig(bind: (attempt: number) => Promise<void>, config: Record<string, unknown> = { llm: LLM }) {
    const logger = memoryLogger();
    const counts = { opened: 0, attempts: 0 };
    const app: ChannelApp = {
      config: parseConfig(config),
      logger,
      model: new MockLanguageModelV4(),
      host: {
        ...fakeHost([], { name: 'dsh-pet' }),
        async bindChat(binding) {
          counts.attempts += 1;
          await bind(counts.attempts);
          return { model: binding.model };
        },
      },
      openChannel: async () => {
        counts.opened += 1;
        return { baseUrl: 'http://127.0.0.1:4567/v1', token: 'local-token', close: async () => {} };
      },
    };
    return { app, logger, counts };
  }

  test('桌宠还没开时隔一会儿再接；网关只开一次，只记第一次失败', async () => {
    const { app, logger, counts } = channelRig(async (attempt) => {
      if (attempt <= 2) throw new Error('connect ECONNREFUSED 127.0.0.1:3080');
    });
    await connectChannel(app, new AbortController().signal, 5);
    assert.equal(counts.attempts, 3);
    assert.equal(counts.opened, 1);
    assert.deepEqual(logger.lines, [
      '对话渠道还没接上桌宠，过一会儿再试：connect ECONNREFUSED 127.0.0.1:3080',
      '对话渠道已接上 mock-model',
    ]);
  });

  test('一直接不上时，停下常驻循环就不再试', async () => {
    const controller = new AbortController();
    const { app, logger, counts } = channelRig(async (attempt) => {
      if (attempt === 2) controller.abort();
      throw new Error('桌宠没开');
    });
    await connectChannel(app, controller.signal, 5);
    assert.equal(counts.attempts, 2);
    assert.equal(logger.lines.length, 1);
  });

  test('控制台舞台、没配模型都不开渠道；anthropic 只记一行', async () => {
    const consoleRig = channelRig(async () => {});
    await connectChannel(
      { ...consoleRig.app, host: fakeHost([], { name: 'console' }) },
      new AbortController().signal,
      5,
    );
    await connectChannel({ ...consoleRig.app, model: null }, new AbortController().signal, 5);
    assert.equal(consoleRig.counts.opened, 0);

    const anthropic = channelRig(async () => {}, { llm: { ...LLM, provider: 'anthropic' } });
    await connectChannel(anthropic.app, new AbortController().signal, 5);
    assert.equal(anthropic.counts.opened, 0);
    assert.deepEqual(anthropic.logger.lines, ['llm.provider 不是 openai-compatible，桌宠右键对话不经过 yoyo']);
  });
});

describe('daemon 常驻', () => {
  test('起按键助手（组装根决定起不起）、编排器开始打拍子、菜单交给收件箱、气泡里的话念出来；signal 中止就关掉返回', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
    const calls: string[] = [];
    const counts = { hotkeys: 0, closed: 0 };
    const controller = new AbortController();
    const listeners = process.listenerCount('SIGINT');
    const config = parseConfig({ stage: 'console', clipboard: { enabled: false } });
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
    const logger = memoryLogger();
    const director = fakeDirector(calls);
    const context = createContext({
      store: createMemoryStore(),
      session: sessionFor('main'),
      projection: yoyoProjection,
    });
    const orchestrator = createYoyoOrchestrator({
      config,
      paths,
      logger,
      repos: memoryRepos(),
      clipboard: { read: () => '' },
      search: null,
      context,
      harness: createYoyoHarness(context),
      director,
      model: null,
    });
    const app: DaemonApp = {
      config,
      paths,
      logger,
      host: fakeHost(calls, {
        menu: ['听一句'],
        sayings: [
          { text: '开场白', initial: true },
          { text: '桌宠的回复', initial: false },
        ],
      }),
      model: null,
      director,
      orchestrator,
      openChannel: async () => {
        throw new Error('控制台舞台不该开渠道');
      },
      startHotkey: () => {
        counts.hotkeys += 1;
      },
      close: async () => {
        counts.closed += 1;
        await orchestrator.close();
      },
    };
    const running = runDaemon(app, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(process.listenerCount('SIGINT'), listeners + 1);
    controller.abort();
    await running;
    assert.equal(counts.hotkeys, 1);
    assert.equal(counts.closed, 1);
    assert.equal(process.listenerCount('SIGINT'), listeners, '停下以后不再占着 SIGINT');
    assert.ok(calls.includes('sync'), '编排器至少走了一拍');
    assert.ok(calls.includes('claim:开场白'));
    assert.ok(calls.includes('foreign:桌宠的回复'));
    const listened = calls.includes('hear') || drain(app.paths.inboxFile).some((message) => message.type === 'listen');
    assert.ok(listened, '菜单的「听一句」进了收件箱');
  });

  test('--once 由编排器说一句，--bake 由导演预合成，做完就关', async () => {
    const calls: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
    const app: DaemonApp = {
      config: parseConfig({ stage: 'console' }),
      paths: resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') }),
      logger: memoryLogger(),
      host: fakeHost(calls),
      model: null,
      director: fakeDirector(calls),
      orchestrator: {
        whisper: async () => {
          calls.push('whisper');
          return null;
        },
        start: () => void calls.push('start'),
      },
      openChannel: async () => {
        throw new Error('不该开渠道');
      },
      startHotkey: () => void calls.push('hotkey'),
      close: async () => void calls.push('close'),
    };
    await runDaemon(app, { once: true });
    await runDaemon(app, { bake: true });
    assert.deepEqual(calls, ['whisper', 'close', 'bake', 'close']);
  });
});
