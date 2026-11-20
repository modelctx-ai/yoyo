import type { Logger as CtxLogger, ToolRegistry } from '@modelctx-ai/ctx';
import {
  connectorFor,
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
  /** 测试用：断开以后每次重连前等多久，毫秒；缺省 `RECONNECT_DELAYS_MS`。 */
  readonly reconnectDelaysMs?: readonly number[];
}

/** 用着的服务器断开以后，第几次重连前等多久：5 秒、30 秒、2 分钟、10 分钟、10 分钟，都没连上就不再试。 */
export const RECONNECT_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 600_000];
/** 重连上以后这么久之内又断了，接着上一次的次数往后排，不从头来：免得一连上就崩的服务器被一直拉起来。 */
const STABLE_MS = 60_000;

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

/** 毫秒数：不小于 0 的数，可以写成字符串；0 是不限时（ctx-mcp 的写法）。 */
function millis(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined;
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
  const timeoutMs = millis(raw['timeoutMs']);
  const callTimeoutMs = millis(raw['callTimeoutMs']);
  const shared = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
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

function errorOf(data: Readonly<Record<string, unknown>> | undefined): string {
  const error = data?.['error'];
  return typeof error === 'string' && error ? error : '原因不明';
}

/**
 * ctx-mcp 的告警换成一行中文。没连上、断开了不在这里说：连接的结果和重连由 `connectMcp` 按状态记。
 * 认不出的原样交出去，不丢。
 */
export function mcpLogger(logger: Pick<Logger, 'warn'>): CtxLogger {
  return {
    warn(message, data) {
      let match: RegExpExecArray | null;
      if (/^MCP server ".*" (failed to connect|disconnected)$/.test(message)) return;
      if ((match = /^MCP server "(.*)" failed to refresh tools$/.exec(message))) {
        logger.warn(`MCP ${match[1]} 的工具列表没刷新成，先用原来的：${errorOf(data)}`);
      } else if ((match = /^MCP server "(.*)" failed to close$/.exec(message))) {
        logger.warn(`MCP ${match[1]} 没关干净：${errorOf(data)}`);
      } else if ((match = /^MCP tool "(.*)" from server "(.*)" skipped: name already registered$/.exec(message))) {
        logger.warn(`MCP ${match[2]} 的工具 ${match[1]} 和已有的工具重名，跳过`);
      } else if ((match = /^MCP tool "(.*)" from server "(.*)" skipped$/.exec(message))) {
        logger.warn(`MCP ${match[2]} 的工具 ${match[1]} 收不进来，跳过：${errorOf(data)}`);
      } else {
        logger.warn(message, data);
      }
    },
  };
}

/** 「5 秒」「2 分钟」：重连的日志用。 */
function waitText(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/**
 * 连上 mcpServers 里的服务器，把它们的工具写进注册表。没有可连的服务器就返回 null。
 * 用着的服务器自己断了（进程退出、连接断开），ctx-mcp 撤掉它的工具；这里按 `RECONNECT_DELAYS_MS` 隔一阵重连，
 * 连上了工具回到注册表，几次都没连上就不再试。`close` 之后不再重连。
 */
export async function connectMcp(
  servers: McpServersConfig,
  registry: ToolRegistry,
  logger: Logger,
  options: ConnectMcpOptions = {},
): Promise<McpHub | null> {
  const { servers: valid, boxed } = applySandbox(validMcpServers(servers, logger), servers, options.sandbox, logger);
  if (Object.keys(valid).length === 0) return null;
  const delays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const base = options.connector ?? connectorFor('yoyo');
  const retrying = new Map<string, ReturnType<typeof setTimeout>>();
  /** 最近一次重连上的时刻和那是第几次。 */
  const recovered = new Map<string, { readonly at: number; readonly attempt: number }>();
  let closing = false;

  function retry(name: string, attempt: number): void {
    const timer = setTimeout(() => {
      void (async () => {
        const status = (await hub.connect()).find((item) => item.name === name);
        if (closing) return;
        retrying.delete(name);
        if (status?.state === 'connected') {
          recovered.set(name, { at: Date.now(), attempt });
          logger.info(`MCP ${name} 重新连上了，${status.tools.length} 个工具`);
        } else if (attempt + 1 < delays.length) {
          const why = status?.state === 'failed' ? `：${status.error}` : '';
          logger.warn(`MCP ${name} 还没连上${why}，${waitText(delays[attempt + 1]!)}后再试`);
          retry(name, attempt + 1);
        } else {
          logger.warn(`MCP ${name} 重连了 ${delays.length} 次都没连上，先不连了，重启 yoyo 再试`);
        }
      })().catch((error: unknown) => logger.warn(`MCP ${name} 重连出错：${errorText(error)}`));
    }, delays[attempt]);
    timer.unref?.();
    retrying.set(name, timer);
  }

  // 连接自己断了：ctx-mcp 先处理（摘掉工具、状态记成失败），这里再安排重连。连接中途断的算这次没连上，不在这里管。
  const connector: McpConnector = (name, config, connect = {}) =>
    base(name, config, {
      ...connect,
      onClose: (reason) => {
        const live = hub.status().find((item) => item.name === name)?.state === 'connected';
        connect.onClose?.(reason);
        if (!live || closing || retrying.has(name)) return;
        const last = recovered.get(name);
        const attempt = last && Date.now() - last.at < STABLE_MS ? last.attempt + 1 : 0;
        const why = reason ?? '连接关了';
        if (attempt >= delays.length) {
          logger.warn(`MCP ${name} 断开了：${why}；重连上又断了 ${delays.length} 次，先不连了，重启 yoyo 再试`);
          return;
        }
        logger.warn(`MCP ${name} 断开了：${why}，${waitText(delays[attempt]!)}后重连`);
        retry(name, attempt);
      },
    });

  const hub = createMcpHub(valid, { clientName: 'yoyo', logger: mcpLogger(logger), connector });
  const statuses = await hub.connect();
  hub.registerInto(registry);
  for (const status of statuses) {
    const where = boxed.has(status.name) ? '（在沙箱里）' : '';
    if (status.state === 'connected') logger.info(`MCP ${status.name} 已连上${where}，${status.tools.length} 个工具`);
    else if (status.state === 'failed') logger.warn(`MCP ${status.name} 没连上：${status.error}`);
    else logger.info(`MCP ${status.name} 没启用`);
  }

  const stop = (): void => {
    closing = true;
    for (const timer of retrying.values()) clearTimeout(timer);
    retrying.clear();
  };
  return {
    ...hub,
    async close() {
      stop();
      await hub.close();
    },
    async dispose() {
      stop();
      await hub.dispose();
    },
  };
}
