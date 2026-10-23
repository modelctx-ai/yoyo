import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createToolRegistry, tool } from '@modelctx-ai/ctx';
import type { McpConnector } from '@modelctx-ai/ctx-mcp';
import { z } from 'zod';

import { parseConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';
import { connectMcp } from './mcp.ts';

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
});
