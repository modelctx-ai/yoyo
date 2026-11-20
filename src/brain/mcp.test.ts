import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createOrchestrator, createToolRegistry, tool } from '@modelctx-ai/ctx';
import { connectorFor, type McpConnector, type McpServerConfig } from '@modelctx-ai/ctx-mcp';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { parseConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';
import { generateReply } from './compose.ts';
import { createYoyoContext, recordUser } from './context.ts';
import { createYoyoHarness } from './harness.ts';
import { connectMcp, mcpLogger, mcpServerOf } from './mcp.ts';

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

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

const fixtures = fileURLToPath(new URL('fixtures', import.meta.url));
const fakeSrt = join(fixtures, 'fake-srt.mjs');
const whereServer = join(fixtures, 'where-server.mjs');

/** 记下交给 ctx-mcp 的配置；`real` 的再交给 ctx-mcp 真正的连接方式，别的给一个假连接。 */
function recordingConnector(real: readonly string[] = []) {
  const seen: Record<string, McpServerConfig> = {};
  const spawn = connectorFor('yoyo');
  const connector: McpConnector = async (name, config, options) => {
    seen[name] = config;
    if (real.includes(name)) return await spawn(name, config, options);
    return { tools: async () => ({ ping: fake('p') }), close: async () => {} };
  };
  return { seen, connector };
}

/** 每条连接的 `onClose`、`onToolsChanged` 留下来，测试里拿它们装作服务器断了、工具变了。 */
function flaky(options: { fail?: (attempt: number) => boolean; failTools?: (call: number) => boolean } = {}) {
  let listed = 0;
  const opened: { close?: (reason?: string) => void; changed?: () => void }[] = [];
  const connector: McpConnector = async (_name, _config, connect) => {
    const attempt = opened.length;
    opened.push({
      ...(connect?.onClose ? { close: connect.onClose } : {}),
      ...(connect?.onToolsChanged ? { changed: connect.onToolsChanged } : {}),
    });
    if (options.fail?.(attempt)) throw new Error('spawn ENOENT');
    return {
      tools: async () => {
        listed += 1;
        if (options.failTools?.(listed)) throw new Error('boom');
        return { search: fake('s') };
      },
      close: async () => {},
    };
  };
  return { opened, connector, drop: (reason?: string) => opened.at(-1)?.close?.(reason) };
}

/** 注册表里有没有那台服务器的工具。 */
const has = (registry: ReturnType<typeof createToolRegistry>) =>
  registry.list().some((info) => info.name === 'web__search');

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
}

/** 三台服务器：一台要包的 stdio（经假 srt 真的启动）、一台豁免的 via、一台 HTTP。 */
function setup(sandbox: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-mcp-sandbox-'));
  const config = parseConfig({
    sandbox,
    mcpServers: {
      boxed: {
        command: process.execPath,
        args: [whereServer],
        cwd: fixtures,
        env: { MARK: 'm', FAKE_SRT_LOG: join(home, 'srt.log') },
      },
      via: { command: 'via', args: ['serve'], sandbox: false },
      web: { url: 'https://mcp.example/api' },
    },
  });
  const sandboxOptions = {
    config: config.sandbox,
    dataDir: join(home, 'data'),
    configFile: join(home, 'config.json'),
    env: { PATH: fixtures },
  };
  return { home, config, sandboxOptions };
}

describe('brain/mcp', () => {
  test('没配 mcpServers 就不连，返回 null', async () => {
    const registry = createToolRegistry().addTool('list_alarms', fake('x'));
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
    const registry = createToolRegistry().addTool('list_alarms', fake('x'));
    const logger = recorder();
    const hub = await connectMcp(servers, registry, logger, { connector });
    assert.ok(hub);
    assert.deepEqual(
      registry.list().map((info) => `${info.name}@${info.source}`),
      ['list_alarms@local', 'web__search@mcp:web'],
    );
    assert.deepEqual(logger.lines.toSorted(), [
      'info MCP off 没启用',
      'info MCP web 已连上，1 个工具',
      'warn MCP broken 没连上：spawn ENOENT',
    ]);
    await hub.close();
    assert.deepEqual(closed, ['web']);
  });
  test('hub 交给上下文当执行环境，回复时模型调得到 MCP 工具', async () => {
    const calls: string[] = [];
    const connector: McpConnector = async () => ({
      tools: async () => ({
        search: tool({
          description: '搜一下',
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => {
            calls.push(query);
            return '台北晴';
          },
        }),
      }),
      close: async () => {},
    });
    const registry = createToolRegistry();
    const hub = await connectMcp({ web: { url: 'https://mcp.example/api' } }, registry, recorder(), { connector });
    assert.ok(hub);
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'web__search', input: JSON.stringify({ query: '台北' }) },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        } satisfies DoGenerateResult,
        {
          content: [{ type: 'text', text: '台北今天是晴天哦。' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        } satisfies DoGenerateResult,
      ],
    });
    const context = await createYoyoContext({
      db: new DatabaseSync(':memory:'),
      petId: 'main',
      tools: registry,
      executors: [hub],
      model,
    });
    await recordUser(context, '台北天气怎么样', 1);
    // MCP 工具绑定在 hub 上：harness 分发工具时要有这个执行环境
    const runs = createOrchestrator({ harness: createYoyoHarness(context, { executors: [hub] }) });
    const line = await generateReply(context, runs, { tone: 'warm', model, tools: true });
    assert.equal(line.text, '台北今天是晴天哦。');
    assert.deepEqual(calls, ['台北']);
    await hub.close();
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
    assert.deepEqual(logger.lines.filter((line) => line.startsWith('warn')).toSorted(), [
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

  test('一台服务器的时限：timeoutMs、callTimeoutMs 原样交给 ctx-mcp，0 是不限时；写错当没写', () => {
    assert.deepEqual(mcpServerOf({ command: 'node', timeoutMs: '30000', callTimeoutMs: 0 }), {
      command: 'node',
      timeoutMs: 30_000,
      callTimeoutMs: 0,
    });
    assert.deepEqual(mcpServerOf({ url: 'http://a', callTimeoutMs: 300_000 }), {
      url: 'http://a',
      callTimeoutMs: 300_000,
    });
    for (const bad of [-1, 'soon', '', null, Infinity]) {
      assert.deepEqual(
        mcpServerOf({ command: 'node', timeoutMs: bad, callTimeoutMs: bad }),
        { command: 'node' },
        String(bad),
      );
    }
  });

  test('ctx-mcp 的告警换成中文：刷新失败、重名跳过、收不进来、没关干净；没连上和断开不在这里说；认不出的原样', () => {
    const logger = recorder();
    const ctx = mcpLogger(logger);
    ctx.warn('MCP server "web" failed to refresh tools', { error: 'boom' });
    ctx.warn('MCP tool "web__search" from server "web" skipped: name already registered', { owner: 'local' });
    ctx.warn('MCP tool "web__x" from server "web" skipped', { error: 'bad schema' });
    ctx.warn('MCP server "web" failed to close', {});
    ctx.warn('MCP server "web" failed to connect', { error: 'ENOENT' });
    ctx.warn('MCP server "web" disconnected', { error: 'exited' });
    ctx.warn('something new', { error: 'x' });
    assert.deepEqual(logger.lines, [
      'warn MCP web 的工具列表没刷新成，先用原来的：boom',
      'warn MCP web 的工具 web__search 和已有的工具重名，跳过',
      'warn MCP web 的工具 web__x 收不进来，跳过：bad schema',
      'warn MCP web 没关干净：原因不明',
      'warn something new',
    ]);
  });

  describe('断开以后', () => {
    const servers = parseConfig({ mcpServers: { web: { url: 'https://mcp.example/api' } } }).mcpServers;
    test('隔一阵重连，工具回到注册表；日志是中文', async () => {
      const { connector, drop, opened } = flaky();
      const registry = createToolRegistry();
      const logger = recorder();
      const hub = await connectMcp(servers, registry, logger, { connector, reconnectDelaysMs: [5, 5] });
      assert.ok(hub && has(registry));
      drop('process exited');
      assert.equal(has(registry), false, '断开时工具撤掉');
      await until(() => has(registry), '重连以后工具回来');
      assert.equal(opened.length, 2);
      assert.deepEqual(logger.lines, [
        'info MCP web 已连上，1 个工具',
        'warn MCP web 断开了：process exited，1 秒后重连',
        'info MCP web 重新连上了，1 个工具',
      ]);
      await hub.close();
    });

    test('一直连不上：按次数重试，都不行就不再试', async () => {
      const { connector, drop, opened } = flaky({ fail: (attempt) => attempt > 0 });
      const logger = recorder();
      const hub = await connectMcp(servers, createToolRegistry(), logger, { connector, reconnectDelaysMs: [5, 5] });
      assert.ok(hub);
      drop();
      await until(() => logger.lines.length === 4, '试完两次');
      assert.equal(opened.length, 3);
      assert.deepEqual(logger.lines.slice(1), [
        'warn MCP web 断开了：连接关了，1 秒后重连',
        'warn MCP web 还没连上：spawn ENOENT，1 秒后再试',
        'warn MCP web 重连了 2 次都没连上，先不连了，重启 yoyo 再试',
      ]);
      await hub.close();
    });

    test('一连上又断：接着上一次的次数往后排，不一直拉起来', async () => {
      const { connector, drop, opened } = flaky();
      const registry = createToolRegistry();
      const logger = recorder();
      const hub = await connectMcp(servers, registry, logger, { connector, reconnectDelaysMs: [5, 5] });
      assert.ok(hub);
      drop('crashed');
      await until(() => opened.length === 2 && has(registry), '第一次重连');
      drop('crashed');
      await until(() => opened.length === 3 && has(registry), '第二次重连');
      drop('crashed');
      assert.equal(logger.lines.at(-1), 'warn MCP web 断开了：crashed；重连上又断了 2 次，先不连了，重启 yoyo 再试');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(opened.length, 3, '不再重连');
      await hub.close();
    });

    test('关掉以后不再重连；等着的那次也取消', async () => {
      const { connector, drop, opened } = flaky();
      const logger = recorder();
      const hub = await connectMcp(servers, createToolRegistry(), logger, { connector, reconnectDelaysMs: [20] });
      assert.ok(hub);
      drop('process exited');
      await hub.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(opened.length, 1);
      drop('process exited');
      assert.equal(logger.lines.filter((line) => line.includes('断开了')).length, 1);
    });

    test('工具列表刷新失败：留着原来的工具，记一行中文', async () => {
      // 连上时列一次照常，服务器说工具变了以后再列就失败
      const { connector, opened } = flaky({ failTools: (call) => call > 1 });
      const registry = createToolRegistry();
      const logger = recorder();
      const hub = await connectMcp(servers, registry, logger, { connector });
      assert.ok(hub);
      opened[0]?.changed?.();
      await until(() => logger.lines.length === 2, '刷新失败记一行');
      assert.equal(logger.lines[1], 'warn MCP web 的工具列表没刷新成，先用原来的：boom');
      assert.ok(has(registry));
      await hub.close();
    });
  });

  describe('sandbox', () => {
    test('打开后 stdio 服务器经沙箱程序启动：交给 ctx-mcp 的是改写后的命令，里面的进程照常应答', async () => {
      const { home, config, sandboxOptions } = setup({
        enabled: true,
        command: ['fake-srt.mjs', '--debug'],
        policy: { network: { allowedDomains: ['api.example.com'] } },
      });
      const { seen, connector } = recordingConnector(['boxed']);
      const logger = recorder();
      const hub = await connectMcp(config.mcpServers, createToolRegistry(), logger, {
        connector,
        sandbox: sandboxOptions,
      });
      assert.ok(hub);
      try {
        const boxed = seen['boxed'];
        assert.ok(boxed && 'command' in boxed);
        const settingsFile = boxed.args?.[2] ?? '';
        assert.match(settingsFile, /\/data\/sandbox\/settings-[0-9a-f]{16}\.json$/);
        assert.deepEqual(boxed, {
          command: fakeSrt,
          args: ['--debug', '--settings', settingsFile, '--', process.execPath, whereServer],
          env: { MARK: 'm', FAKE_SRT_LOG: join(home, 'srt.log') },
          cwd: fixtures,
        });
        assert.deepEqual(seen['via'], { command: 'via', args: ['serve'] }, '写了 "sandbox": false 的不包');
        assert.deepEqual(seen['web'], { url: 'https://mcp.example/api' }, 'url 的不动');

        const [record] = readFileSync(join(home, 'srt.log'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.deepEqual(record.options, ['--debug', '--settings', settingsFile]);
        assert.deepEqual(record.command, [process.execPath, whereServer]);
        assert.equal(record.cwd, fixtures, 'cwd 交给沙箱程序');
        assert.deepEqual(record.settings, {
          network: { allowedDomains: ['api.example.com'], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [join(home, 'data'), join(home, 'config.json')] },
        });

        const output = await hub.execute({ id: 'c1', name: 'boxed__where', input: {} }, { session: 's' });
        assert.deepEqual(output, { type: 'text', text: JSON.stringify({ cwd: fixtures, mark: 'm' }) });
        assert.ok(logger.lines.includes('info MCP boxed 已连上（在沙箱里），1 个工具'));
        assert.ok(logger.lines.includes('info MCP via 已连上，1 个工具'));
      } finally {
        await hub.close();
      }
    });

    test('沙箱程序找不到：要包的服务器都不启动，记一行，不退回到不加沙箱；url 的和豁免的照常连', async () => {
      const { config, sandboxOptions } = setup({ enabled: true, command: 'no-such-srt' });
      const { seen, connector } = recordingConnector();
      const logger = recorder();
      const hub = await connectMcp(config.mcpServers, createToolRegistry(), logger, {
        connector,
        sandbox: sandboxOptions,
      });
      assert.ok(hub);
      assert.deepEqual(Object.keys(seen).toSorted(), ['via', 'web']);
      assert.deepEqual(
        logger.lines.filter((line) => line.startsWith('warn')),
        ['warn 沙箱程序 no-such-srt 找不到，sandbox.enabled 打开了，这些 MCP 不启动：boxed'],
      );
      await hub.close();
    });

    test('policy 的文件读不出或不是 JSON 对象：同样不启动，记一行', async () => {
      for (const [policy, reason] of [
        ['missing.json', '读不出（ENOENT）'],
        ['list.json', '不是 JSON 对象'],
      ] as const) {
        const { home, config, sandboxOptions } = setup({ enabled: true, command: 'fake-srt.mjs', policy });
        writeFileSync(join(home, 'list.json'), '[1]');
        const { seen, connector } = recordingConnector();
        const logger = recorder();
        const hub = await connectMcp(config.mcpServers, createToolRegistry(), logger, {
          connector,
          sandbox: sandboxOptions,
        });
        assert.ok(hub);
        assert.deepEqual(Object.keys(seen).toSorted(), ['via', 'web']);
        assert.deepEqual(
          logger.lines.filter((line) => line.startsWith('warn')),
          [
            `warn sandbox.policy 的文件 ${join(home, policy)} ${reason}，sandbox.enabled 打开了，这些 MCP 不启动：boxed`,
          ],
        );
        await hub.close();
      }
    });

    test('没打开、或者没有要包的服务器，就不找程序、不写设置文件', async () => {
      const { config, sandboxOptions } = setup({ enabled: false, command: 'no-such-srt' });
      const { seen, connector } = recordingConnector();
      const logger = recorder();
      const hub = await connectMcp(config.mcpServers, createToolRegistry(), logger, {
        connector,
        sandbox: sandboxOptions,
      });
      assert.ok(hub);
      assert.ok(seen['boxed'] && 'command' in seen['boxed']);
      assert.equal(seen['boxed'].command, process.execPath);
      assert.deepEqual(
        logger.lines.filter((line) => line.startsWith('warn')),
        [],
      );
      await hub.close();

      const remoteOnly = await connectMcp({ web: { url: 'https://mcp.example/api' } }, createToolRegistry(), logger, {
        connector,
        sandbox: { ...sandboxOptions, config: { ...sandboxOptions.config, enabled: true } },
      });
      assert.ok(remoteOnly);
      assert.deepEqual(
        logger.lines.filter((line) => line.startsWith('warn')),
        [],
      );
      await remoteOnly.close();
    });
  });
});
