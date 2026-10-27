// 最小的 stdio MCP 服务器，只给测试用：一个 where 工具，报告自己的工作目录和环境变量 MARK。
import { createInterface } from 'node:readline';

const tools = [{ name: 'where', description: '报告工作目录', inputSchema: { type: 'object', properties: {} } }];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send({
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'where', version: '0.0.0' },
      },
    });
  } else if (request.method === 'tools/list') {
    send({ id: request.id, result: { tools } });
  } else if (request.method === 'tools/call') {
    const text = JSON.stringify({ cwd: process.cwd(), mark: process.env.MARK ?? null });
    send({ id: request.id, result: { content: [{ type: 'text', text }] } });
  } else {
    send({ id: request.id, error: { code: -32601, message: 'method not found' } });
  }
});
