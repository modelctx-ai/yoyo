import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Logger } from '../../ports/index.ts';
import { createConsoleHost } from './host.ts';

function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => void lines.push(m), warn: (m) => void lines.push(m), error: (m) => void lines.push(m) };
}

describe('console host', () => {
  test('台词打印到终端，再执行 during', async () => {
    const logger = memoryLogger();
    const host = createConsoleHost(logger);
    const order: string[] = [];
    await host.present({ text: '我在呢', durationMs: 10_000, action: '照镜子' }, async () => {
      order.push('during');
    });
    await host.present({ text: '看图', durationMs: 10_000, action: '东张西望', imageUrl: 'https://example.com/a.png' });
    assert.equal(host.name, 'console');
    assert.deepEqual(logger.lines, ['[照镜子] 我在呢', '[东张西望] 看图 https://example.com/a.png']);
    assert.deepEqual(order, ['during']);
    await host.cue('碎碎念-对屏碎碎念');
    assert.deepEqual(await host.chatHistory(200), []);
    assert.equal(await host.workStatus(), null);
  });

  test('菜单和气泡什么也不产出，signal 中止就结束', async () => {
    const host = createConsoleHost(memoryLogger());
    const controller = new AbortController();
    const seen: unknown[] = [];
    const menu = (async () => {
      for await (const label of host.menu('yoyo', ['碎碎念'], controller.signal)) seen.push(label);
    })();
    const sayings = (async () => {
      for await (const saying of host.sayings(controller.signal)) seen.push(saying);
    })();
    setTimeout(() => controller.abort(), 10);
    await Promise.all([menu, sayings]);
    for await (const label of host.menu('yoyo', [], controller.signal)) seen.push(label);
    assert.equal(seen.length, 0, '什么也没产出；已经中止的 signal 直接结束');
  });

  test('控制台模式没有桌宠对话，接渠道只记一行', async () => {
    const logger = memoryLogger();
    const host = createConsoleHost(logger);
    assert.deepEqual(await host.bindChat({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 't' }), {
      model: 'm',
    });
    assert.equal(logger.lines.length, 1);
  });
});
