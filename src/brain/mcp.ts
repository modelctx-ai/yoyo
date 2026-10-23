import type { ToolRegistry } from '@modelctx-ai/ctx';
import { createMcpHub, type McpConnector, type McpHub } from '@modelctx-ai/ctx-mcp';

import type { McpServersConfig } from '../app/config.ts';
import type { Logger } from '../ports/index.ts';

export interface ConnectMcpOptions {
  /** 测试用：换掉真正的连接方式。 */
  readonly connector?: McpConnector;
}

/** 连上 mcpServers 里的服务器，把它们的工具写进注册表。没有配置就返回 null。 */
export async function connectMcp(
  servers: McpServersConfig,
  registry: ToolRegistry,
  logger: Logger,
  options: ConnectMcpOptions = {},
): Promise<McpHub | null> {
  if (Object.keys(servers).length === 0) return null;
  const hub = createMcpHub(servers, {
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
    if (status.state === 'connected') logger.info(`MCP ${status.name} 已连上，${status.tools.length} 个工具`);
    else if (status.state === 'failed') logger.warn(`MCP ${status.name} 没连上：${status.error}`);
    else logger.info(`MCP ${status.name} 没启用`);
  }
  return hub;
}
