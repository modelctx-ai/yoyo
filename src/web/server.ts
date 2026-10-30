/**
 * 管理页的服务：只听 127.0.0.1，页面本身谁都能取（里面没有数据），接口要带本机令牌。
 * 防的是本机别的网页：Host 只认本机地址（挡 DNS rebinding），带 Origin 的只认自己，跨站来的请求一律 403，
 * 写操作只收 JSON（表单发不过来）。令牌每次启动新生成，只放在打开页面的地址里。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { errorText } from '../app/log.ts';
import type { Logger } from '../ports/index.ts';
import { createWebApi, type ApiFile, type WebDeps } from './api.ts';
import { pageHtml } from './page.ts';

export interface WebServer {
  /** 例如 `http://127.0.0.1:53001`。 */
  readonly origin: string;
  /** 打开管理页的地址，带着令牌：`origin/#token=…`。 */
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface WebOptions extends WebDeps {
  /** 缺省 0：随机端口。 */
  readonly port?: number;
  /** 缺省新生成一个。换配置重建应用时接着用上一个的，开着的页面不用重开。 */
  readonly token?: string;
  readonly logger?: Logger;
}

/** 请求正文上限：接口收的都是一小段 JSON。 */
const MAX_BODY = 64 * 1024;

const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 原样回一个交付物。不在本页的源里执行：`sandbox` 加 `default-src 'none'`，HTML、SVG 这类只给下载。
 * 文件名用 RFC 5987 的写法，中文名下载下来不乱。
 */
function sendFile(res: ServerResponse, file: ApiFile): void {
  const text = file.type.startsWith('text/') || file.type === 'application/json';
  const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'content-type': text ? `${file.type}; charset=utf-8` : file.type,
    'content-length': String(file.bytes.length),
    'content-disposition': `${file.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'content-security-policy': "sandbox; default-src 'none'",
  });
  res.end(file.bytes);
}

function page(res: ServerResponse): void {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      // 交付物的图片先用令牌取回来，再经 blob: 地址显示
      "img-src 'self' data: blob:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  res.end(pageHtml(nonce));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(/^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

export function startWeb(options: WebOptions): Promise<WebServer> {
  const { logger } = options;
  const api = createWebApi(options);
  const token = options.token ?? randomBytes(24).toString('base64url');
  let hosts = new Set<string>();
  let origins = new Set<string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) return send(res, 403, { error: 'host not allowed' });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase()))
      return send(res, 403, { error: 'origin not allowed' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'cross-site request' });
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const pathname = new URL(path, 'http://yoyo.local').pathname;
    if (!pathname.startsWith('/api/')) {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) return page(res);
      return send(res, 404, { error: 'not found' });
    }
    if (!authorized(req, token))
      return send(res, 401, { error: '令牌不对：从桌宠右键的「管理」或 yoyo web open 重新打开' });
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { error: '只收 JSON' });
      }
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: '正文不是能读的 JSON' });
      }
    }
    const result = await api(method, path, body);
    if (result.file) return sendFile(res, result.file);
    send(res, result.status, result.body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger?.warn(`管理页出错：${errorText(error)}`);
      if (!res.headersSent) send(res, 500, { error: '出错了，看一眼 yoyo 的日志' });
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        url: `${origin}/#token=${token}`,
        token,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
