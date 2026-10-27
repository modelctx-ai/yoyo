import type { ToolRegistry } from '@modelctx-ai/ctx';
import {
  createMcpHub,
  type McpConnector,
  type McpHub,
  type McpServerConfig,
  type McpServers,
} from '@modelctx-ai/ctx-mcp';

import type { McpServersConfig, SandboxConfig } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Logger } from '../ports/index.ts';
import {
  prepareSandbox,
  sandboxed,
  wantsSandbox,
  type PrepareSandboxOptions,
  type SandboxLauncher,
} from './sandbox.ts';

export interface McpSandboxOptions extends PrepareSandboxOptions {
  readonly config: SandboxConfig;
}

export interface ConnectMcpOptions {
  /** 测试用：换掉真正的连接方式。 */
  readonly connector?: McpConnector;
  /** `sandbox` 配置和 yoyo 自己的位置（`YOYO_HOME`、`config.json`）。不给或没打开就不加沙箱。 */
  readonly sandbox?: McpSandboxOptions;
}

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' ? value : undefined;
}

/** 下面这些可选字段写错了就当没写，不连累整台服务器。 */
function words(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(textOf).filter((item): item is string => item !== undefined);
}

function pairs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const text = textOf(item);
    if (text !== undefined) out[key] = text;
  }
  return out;
}

function enabledOf(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * 一台服务器的配置：有 `command` 走 stdio，有 `url` 走远程。两样都没有返回 null。
 * `type` 只认 `http`、`sse`，别的按缺省（Streamable HTTP）。
 */
export function mcpServerOf(raw: unknown): McpServerConfig | null {
  if (!isRecord(raw)) return null;
  const enabled = enabledOf(raw['enabled']);
  const include = words(raw['include']);
  const exclude = words(raw['exclude']);
  const shared = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
  const command = textOf(raw['command'])?.trim();
  if (command) {
    const args = words(raw['args']);
    const env = pairs(raw['env']);
    const cwd = textOf(raw['cwd'])?.trim();
    return { command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}), ...shared };
  }
  const url = textOf(raw['url'])?.trim();
  if (url) {
    const type = raw['type'] === 'http' || raw['type'] === 'sse' ? raw['type'] : undefined;
    const headers = pairs(raw['headers']);
    return { url, ...(type ? { type } : {}), ...(headers ? { headers } : {}), ...shared };
  }
  return null;
}

/** 挑出写对了的服务器。写错的记一行中文，跳过，不挡启动。 */
export function validMcpServers(servers: McpServersConfig, logger: Logger): McpServers {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = mcpServerOf(raw);
    if (server) out[name] = server;
    else logger.warn(`MCP ${name} 的配置不对，要有 command 或 url，先跳过`);
  }
  return out;
}

/**
 * `sandbox.enabled` 打开时，把要放进沙箱的 stdio 服务器改成经沙箱程序启动，返回改写后的服务器和放进沙箱的名字。
 * 沙箱程序找不到、`policy` 读不出或设置写不下时记一行，这些服务器都不启动，不退回到不加沙箱运行；
 * `url` 的和写了 `"sandbox": false` 的照常连。
 */
export function applySandbox(
  valid: McpServers,
  raw: McpServersConfig,
  sandbox: McpSandboxOptions | undefined,
  logger: Logger,
): { readonly servers: McpServers; readonly boxed: ReadonlySet<string> } {
  const names = sandbox?.config.enabled
    ? Object.keys(valid).filter((name) => wantsSandbox(raw[name], valid[name]!))
    : [];
  if (!sandbox || names.length === 0) return { servers: valid, boxed: new Set() };
  let launcher: SandboxLauncher | null = null;
  try {
    launcher = prepareSandbox(sandbox.config, sandbox);
  } catch (error) {
    logger.warn(`${errorText(error)}，sandbox.enabled 打开了，这些 MCP 不启动：${names.join('、')}`);
  }
  const out: Record<string, McpServerConfig> = { ...valid };
  for (const name of names) {
    if (launcher) out[name] = sandboxed(valid[name]!, launcher);
    else delete out[name];
  }
  return { servers: out, boxed: new Set(launcher ? names : []) };
}

/** 连上 mcpServers 里的服务器，把它们的工具写进注册表。没有可连的服务器就返回 null。 */
export async function connectMcp(
  servers: McpServersConfig,
  registry: ToolRegistry,
  logger: Logger,
  options: ConnectMcpOptions = {},
): Promise<McpHub | null> {
  const { servers: valid, boxed } = applySandbox(validMcpServers(servers, logger), servers, options.sandbox, logger);
  if (Object.keys(valid).length === 0) return null;
  const hub = createMcpHub(valid, {
    clientName: 'yoyo',
    // 连接失败下面按状态记中文，这里不再重复
    logger: {
      warn: (message, data) => {
        if (!message.endsWith('failed to connect')) logger.warn(message, data);
      },
    },
    ...(options.connector ? { connector: options.connector } : {}),
  });
  const statuses = await hub.connect();
  hub.registerInto(registry);
  for (const status of statuses) {
    const where = boxed.has(status.name) ? '（在沙箱里）' : '';
    if (status.state === 'connected') logger.info(`MCP ${status.name} 已连上${where}，${status.tools.length} 个工具`);
    else if (status.state === 'failed') logger.warn(`MCP ${status.name} 没连上：${status.error}`);
    else logger.info(`MCP ${status.name} 没启用`);
  }
  return hub;
}
