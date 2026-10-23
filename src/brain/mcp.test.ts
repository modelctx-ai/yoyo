import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createToolRegistry, tool } from '@modelctx-ai/ctx';
import type { McpConnector, McpServerConfig } from '@modelctx-ai/ctx-mcp';
import { z } from 'zod';

import { parseConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';
import { connectMcp, mcpServerOf } from './mcp.ts';

function recorder(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

const fake = (text: string) => tool({ description: text, inputSchema: z.object({}), execute: async () => text });

describe('brain/mcp', () => {
  test('没配 mcpServers 就不连，返回 null', async () => {
    const registry = createToolRegistry().add('list_alarms', fake('x'));
    const logger = recorder();
    assert.equal(await connectMcp(parseConfig({}).mcpServers, registry, logger), null);
    assert.equal(registry.size, 1);
    assert.deepEqual(logger.lines, []);
  });

  test('连上的工具带服务器前缀写进注册表，每台服务器的状态用中文记一行', async () => {
    const closed: string[] = [];
    const connector: McpConnector = async (name) => {
      if (name === 'broken') throw new Error('spawn ENOENT');
      return {
        tools: async () => ({ search: fake('s'), fetch: fake('f') }),
        close: async () => {
          closed.push(name);
        },
      };
    };
    const servers = parseConfig({
      mcpServers: {
        web: { url: 'https://mcp.example/api', exclude: ['fetch'] },
        broken: { command: 'missing-mcp' },
        off: { command: 'node', enabled: false },
      },
    }).mcpServers;
    const registry = createToolRegistry().add('list_alarms', fake('x'));
    const logger = recorder();
    const hub = await connectMcp(servers, registry, logger, { connector });
    assert.ok(hub);
    assert.deepEqual(
      registry.list().map((info) => `${info.name}@${info.source}`),
      ['list_alarms@local', 'web__search@mcp:web'],
    );
    assert.deepEqual(logger.lines.sort(), [
      'info MCP off 没启用',
      'info MCP web 已连上，1 个工具',
      'warn MCP broken 没连上：spawn ENOENT',
    ]);
    await hub.close();
    assert.deepEqual(closed, ['web']);
  });
  test('写错的服务器记一行中文跳过，写对的照常连；可选字段写错当没写', async () => {
    const seen: Record<string, McpServerConfig> = {};
    const connector: McpConnector = async (name, config) => {
      seen[name] = config;
      return { tools: async () => ({ ping: fake('p') }), close: async () => {} };
    };
    const servers = parseConfig({
      llm: { tools: true },
      mcpServers: {
        odd: {
          url: ' http://localhost/mcp ',
          type: 'streamable-http',
          headers: { authorization: 'Bearer t', n: 3, x: null },
        },
        wrong: { transport: 'stdio', cmd: 'npx' },
        text: 'npx some-server',
        local: { command: 'node', args: ['server.js', 8080, null], env: 'x', enabled: 'true' },
      },
    }).mcpServers;
    const logger = recorder();
    const hub = await connectMcp(servers, createToolRegistry(), logger, { connector });
    assert.ok(hub);
    assert.deepEqual(seen, {
      odd: { url: 'http://localhost/mcp', headers: { authorization: 'Bearer t', n: '3' } },
      local: { command: 'node', args: ['server.js', '8080'], enabled: true },
    });
    assert.deepEqual(logger.lines.filter((line) => line.startsWith('warn')).sort(), [
      'warn MCP text 的配置不对，要有 command 或 url，先跳过',
      'warn MCP wrong 的配置不对，要有 command 或 url，先跳过',
    ]);
    await hub.close();
  });

  test('一台都没写对就不连，返回 null', async () => {
    const logger = recorder();
    assert.equal(await connectMcp({ bad: { cmd: 'npx' } }, createToolRegistry(), logger), null);
    assert.deepEqual(logger.lines, ['warn MCP bad 的配置不对，要有 command 或 url，先跳过']);
  });

  test('一台服务器的配置：command 优先，type 只认 http 和 sse', () => {
    assert.deepEqual(mcpServerOf({ command: 'node', url: 'http://a' }), { command: 'node' });
    assert.deepEqual(mcpServerOf({ url: 'http://a', type: 'sse', enabled: false, include: ['x'] }), {
      url: 'http://a',
      type: 'sse',
      enabled: false,
      include: ['x'],
    });
    assert.equal(mcpServerOf({ command: '  ' }), null);
    assert.equal(mcpServerOf(null), null);
    assert.equal(mcpServerOf(['node']), null);
  });
});
