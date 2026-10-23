import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { Director } from '../runtime/director.ts';
import { memoryLogger } from '../runtime/testing.ts';
import { parseConfig } from './config.ts';
import { createApp } from './container.ts';
import { resolvePaths, type Paths } from './paths.ts';

function tempPaths(): Paths {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  return resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
}

const LLM = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'llm-key', model: 'mock-model' };

describe('container', () => {
  test('控制台舞台：没配的搜索、模型、工具都留空；close 可以调两次', async () => {
    const app = await createApp(parseConfig({ stage: 'console' }), tempPaths(), { logger: memoryLogger() });
    assert.equal(app.host.name, 'console');
    assert.equal(app.search, null);
    assert.equal(app.model, null);
    assert.equal(app.tools, undefined);
    assert.equal(app.context.thread, 'pet:main');
    assert.equal(typeof app.director.perform, 'function');
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
    assert.equal(app.context.thread, 'pet:desk');
    await app.close();
  });

  test('overrides 换掉任意一项，null 也算', async () => {
    const director = { perform: async () => null } as unknown as Director;
    const app = await createApp(parseConfig({ stage: 'console', llm: LLM }), tempPaths(), {
      logger: memoryLogger(),
      model: null,
      director,
    });
    assert.equal(app.model, null);
    assert.equal(app.director, director);
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
});
