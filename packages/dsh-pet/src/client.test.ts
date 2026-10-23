import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { PetApiError, createPetClient, defaultRuntimePath, readRuntimeToken } from './index.ts';
import type { PetClient, PetClientOptions, PollState } from './index.ts';

// ---------- 假桌宠：本机随机端口，记下每个请求，按处理函数回 JSON ----------

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

interface Answer {
  readonly status?: number;
  readonly json?: unknown;
  /** 原样写出的响应体，用来测读不懂的响应。 */
  readonly raw?: string;
}

/** `closed` 在连接断开（包括客户端中止）时触发，长轮询的假实现靠它收尾。 */
type Handler = (seen: Seen, closed: AbortSignal) => Answer | Promise<Answer>;

interface Fake {
  readonly origin: string;
  readonly baseUrl: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

async function startFake(handler: Handler): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const request: Seen = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(request);
      const closed = new AbortController();
      res.on('close', () => closed.abort());
      void (async () => {
        let answer: Answer;
        try {
          answer = await handler(request, closed.signal);
        } catch {
          res.destroy();
          return;
        }
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        res.end(answer.raw ?? JSON.stringify(answer.json ?? {}));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/dsh-pet-7340`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 一直挂着，直到客户端断开。 */
function hold(closed: AbortSignal): Promise<Answer> {
  return new Promise((resolve) => closed.addEventListener('abort', () => resolve({}), { once: true }));
}

function clientFor(fake: Fake, extra: Partial<PetClientOptions> = {}): PetClient {
  return createPetClient({ baseUrl: fake.baseUrl, pet: 'main', surface: 'desktop', token: () => 'tok', ...extra });
}

function pollState(counter: number, extra: Partial<PollState> = {}): PollState {
  return { counter, sections: {}, pets: {}, ...extra };
}

/** 去掉路由前缀，方便比对请求顺序。 */
function route(seen: Seen): string {
  return seen.path.replace('/dsh-pet-7340', '');
}

describe('dsh-pet 客户端', () => {
  test('写接口带令牌和 JSON 头，按 pet、surface、lock 拼查询', async (t) => {
    const fake = await startFake(({ path }) => {
      if (path.endsWith('/lock'))
        return { json: { ok: true, lockId: 'lk-1', petId: 'main', expiresAt: 1755000030000 } };
      if (path.endsWith('/anim')) return { json: { ok: true, playbackId: 'pb-1' } };
      return { json: { ok: true } };
    });
    t.onTestFinished(() => fake.close());
    let issued = 0;
    const client = clientFor(fake, { token: () => `tok-${++issued}` });

    assert.deepEqual(await client.lock(), { lockId: 'lk-1', expiresAt: 1755000030000 });
    await client.broadcast('lk-1', {
      text: '该喝水了',
      durationMs: 3000,
      imageUrl: 'https://cdn.example.com/a.png',
      anim: false,
    });
    assert.equal(await client.anim('东张西望', { lockId: 'lk-1', facing: 'right' }), 'pb-1');
    await client.release('lk-1');

    assert.deepEqual(
      fake.seen.map((seen) => [seen.method, seen.path, seen.query]),
      [
        ['POST', '/dsh-pet-7340/lock', { pet: 'main', surface: 'desktop' }],
        ['POST', '/dsh-pet-7340/broadcast', { pet: 'main', surface: 'desktop', lock: 'lk-1' }],
        ['POST', '/dsh-pet-7340/anim', { pet: 'main', surface: 'desktop', lock: 'lk-1' }],
        ['POST', '/dsh-pet-7340/lock/release', { pet: 'main' }],
      ],
    );
    assert.deepEqual(
      fake.seen.map((seen) => seen.headers['x-dsh-pet-token']),
      ['tok-1', 'tok-2', 'tok-3', 'tok-4'],
    );
    for (const seen of fake.seen) assert.equal(seen.headers['content-type'], 'application/json');
    assert.deepEqual(
      fake.seen.map((seen) => seen.body),
      [
        {},
        { text: '该喝水了', anim: false, duration: 3000, url: 'https://cdn.example.com/a.png' },
        { name: '东张西望', facing: 'right' },
        { lockId: 'lk-1' },
      ],
    );
  });

  test('不持锁时不带 lock；续期把 lockId 放进请求体', async (t) => {
    const fake = await startFake(({ path }) =>
      path.endsWith('/lock') ? { json: { ok: true, lockId: 'lk-1' } } : { json: { ok: true } },
    );
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    assert.equal(await client.anim('转身'), undefined);
    await client.broadcast(undefined, { text: '嗨', image: '可爱' });
    assert.deepEqual(await client.lock('lk-1'), { lockId: 'lk-1' });

    assert.deepEqual(
      fake.seen.map((seen) => [route(seen), seen.query, seen.body]),
      [
        ['/anim', { pet: 'main', surface: 'desktop' }, { name: '转身' }],
        ['/broadcast', { pet: 'main', surface: 'desktop' }, { text: '嗨', image: '可爱' }],
        ['/lock', { pet: 'main', surface: 'desktop' }, { lockId: 'lk-1' }],
      ],
    );
  });

  test('读对话记忆不带 surface，丢掉格式不对的消息', async (t) => {
    const fake = await startFake(() => ({
      json: {
        ok: true,
        rounds: 6,
        messages: [
          { role: 'user', content: '在吗', ts: 1 },
          { role: 'system', content: '系统提示', ts: 2 },
          { role: 'assistant', content: 42, ts: 3 },
          { role: 'assistant', content: '在呀', ts: 4, image: '可爱' },
          null,
          { role: 'user', content: '没有时间戳' },
        ],
      },
    }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    assert.deepEqual(await client.chat(6), [
      { role: 'user', content: '在吗', ts: 1 },
      { role: 'assistant', content: '在呀', ts: 4 },
    ]);
    await client.chat();
    await client.chat(500);

    assert.deepEqual(
      fake.seen.map((seen) => [seen.method, route(seen), seen.query]),
      [
        ['GET', '/chat', { pet: 'main', rounds: '6' }],
        ['GET', '/chat', { pet: 'main' }],
        ['GET', '/chat', { pet: 'main', rounds: '200' }],
      ],
    );
    assert.equal(fake.seen[0]?.headers['x-dsh-pet-token'], 'tok');
    assert.equal(fake.seen[0]?.headers['content-type'], undefined);
  });

  test('业务失败（ok: false）抛 PetApiError，按 message、reason、缺省文案取说明', async (t) => {
    const answers: Record<string, unknown> = {
      '/lock': { ok: false, reason: 'locked', expiresAt: 1755000030000 },
      '/broadcast': { ok: false, reason: 'unknown-image', message: '配图不在表情包池里' },
      '/anim': {},
      '/chat': { ok: false, reason: 'unknown-pet' },
      '/menu/item': { ok: false, reason: 'invalid-label', message: '菜单项太长' },
    };
    const fake = await startFake((seen) => ({ json: answers[route(seen)] }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    await assert.rejects(client.lock(), (error) => {
      assert.ok(error instanceof PetApiError);
      assert.equal(error.name, 'PetApiError');
      assert.equal(error.message, 'locked');
      assert.equal(error.reason, 'locked');
      assert.equal(error.path, '/lock');
      assert.equal(error.status, 200);
      return true;
    });
    await assert.rejects(client.broadcast('lk-1', { text: '嗨' }), {
      name: 'PetApiError',
      message: '配图不在表情包池里',
      reason: 'unknown-image',
      path: '/broadcast',
    });
    await assert.rejects(client.anim('跳舞'), { message: '动作不在池内：跳舞', reason: undefined });
    await assert.rejects(client.chat(6), { message: 'unknown-pet', reason: 'unknown-pet' });
    await assert.rejects(client.registerMenu('yoyo', ['碎碎念']), { message: '菜单项太长', reason: 'invalid-label' });
  });

  test('占锁回 ok 却没有 lockId 也算失败', async (t) => {
    const fake = await startFake(() => ({ json: { ok: true } }));
    t.onTestFinished(() => fake.close());
    await assert.rejects(clientFor(fake).lock(), { name: 'PetApiError', message: '拿不到桌宠占用锁' });
  });

  test('HTTP 非 2xx 抛 dsh-pet 状态码和路径', async (t) => {
    const fake = await startFake(() => ({ status: 405, json: { error: 'method not allowed' } }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    await assert.rejects(client.anim('东张西望', { lockId: 'lk-1' }), {
      name: 'PetApiError',
      message: 'dsh-pet 405 /anim',
      status: 405,
      path: '/anim',
    });
    await assert.rejects(client.state(), { message: 'dsh-pet 405 /state', status: 405 });
  });

  test('响应体读不懂就当 bad-response', async (t) => {
    const fake = await startFake(() => ({ raw: '<html>gateway</html>' }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    await assert.rejects(client.broadcast(undefined, { text: '嗨' }), {
      name: 'PetApiError',
      reason: 'bad-response',
      message: '<html>gateway</html>',
    });
    await assert.rejects(client.lock(), { reason: 'bad-response' });
    await assert.rejects(client.state(), { reason: 'bad-response', message: '<html>gateway</html>' });
  });

  test('放锁永不抛错', async (t) => {
    const fake = await startFake(() => ({ status: 500, raw: 'boom' }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    await client.release('lk-1');
    const tokenless = clientFor(fake, {
      token: () => {
        throw new Error('没有令牌');
      },
    });
    await tokenless.release('lk-1');
    await fake.close();
    await client.release('lk-1');
    assert.equal(fake.seen.length, 1);
  });

  test('state 不带参数取全量；waitState 带 since 和 timeout 长轮询，等待封顶 10 秒', async (t) => {
    const fake = await startFake(({ query }) => ({
      json: query['since']
        ? { counter: 9, sections: {}, pets: {} }
        : {
            counter: 5,
            sections: { workStatus: { counter: 3, data: { state: 'working', task: '读代码' } } },
            pets: { main: { say: { counter: 2, data: { text: '主人好' } } } },
          },
    }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);

    const first = await client.state();
    assert.equal(first.counter, 5);
    assert.deepEqual(first.sections.workStatus?.data, { state: 'working', task: '读代码' });
    assert.equal(first.pets['main']?.say.data?.text, '主人好');
    assert.equal((await client.waitState(5, 8000)).counter, 9);
    await client.waitState(9, 60_000);

    assert.deepEqual(
      fake.seen.map((seen) => [seen.method, route(seen), seen.query]),
      [
        ['GET', '/state', {}],
        ['GET', '/state', { since: '5', timeout: '8000' }],
        ['GET', '/state', { since: '9', timeout: '10000' }],
      ],
    );
  });

  test('state 缺 sections 或 pets 时补成空的', async (t) => {
    const fake = await startFake(() => ({ json: { counter: 1 } }));
    t.onTestFinished(() => fake.close());
    assert.deepEqual(await clientFor(fake).state(), pollState(1));
  });

  test('单次请求会超时，调用方的 signal 也能中止正在挂着的请求', async (t) => {
    const controller = new AbortController();
    const fake = await startFake((seen, closed) => {
      if (seen.query['since']) setImmediate(() => controller.abort());
      return hold(closed);
    });
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake, { timeoutMs: 30 });

    await assert.rejects(client.state(), { name: 'TimeoutError' });
    await assert.rejects(client.waitState(1, 8000, controller.signal), { name: 'AbortError' });
  });

  test('调用方的 signal 一直开着也不攒监听：每次请求完就摘掉', async (t) => {
    const fake = await startFake(({ query }) => ({ json: pollState(Number(query['since'] ?? 0) + 1) }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);
    const controller = new AbortController();

    for (let since = 0; since < 5; since += 1) await client.waitState(since, 1000, controller.signal);
    await client.menuEvents('yoyo', 1000, controller.signal).catch(() => {});

    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test('watchState 先产出全量，之后只在版本变了时产出，中止就停', async (t) => {
    const controller = new AbortController();
    let waits = 0;
    const fake = await startFake(({ query }, closed) => {
      if (query['since'] === undefined) return { json: pollState(1) };
      if (query['since'] === '1') {
        // 第一次等满了没变化，第二次等到了
        waits += 1;
        return { json: pollState(waits === 1 ? 1 : 2) };
      }
      setImmediate(() => controller.abort());
      return hold(closed);
    });
    t.onTestFinished(() => fake.close());

    const counters: number[] = [];
    for await (const state of clientFor(fake).watchState(controller.signal)) counters.push(state.counter);

    assert.deepEqual(counters, [1, 2]);
    assert.deepEqual(
      fake.seen.map((seen) => seen.query),
      [{}, { since: '1', timeout: '8000' }, { since: '1', timeout: '8000' }, { since: '2', timeout: '8000' }],
    );
  });

  test('watchState 出错就等 retryMs 再试，第一份仍然是全量', async (t) => {
    const controller = new AbortController();
    let calls = 0;
    const fake = await startFake(({ query }, closed) => {
      calls += 1;
      if (calls === 1) return { status: 503 };
      if (calls === 2) return { raw: 'not json' };
      if (query['since'] === undefined) return { json: pollState(7) };
      setImmediate(() => controller.abort());
      return hold(closed);
    });
    t.onTestFinished(() => fake.close());

    const counters: number[] = [];
    const watch = clientFor(fake).watchState(controller.signal, { waitMs: 5000, retryMs: 5 });
    for await (const state of watch) counters.push(state.counter);

    assert.deepEqual(counters, [7]);
    assert.deepEqual(
      fake.seen.map((seen) => seen.query),
      [{}, {}, {}, { since: '7', timeout: '5000' }],
    );
  });

  test('signal 已经中止就什么都不做', async (t) => {
    const fake = await startFake(() => ({ json: pollState(1) }));
    t.onTestFinished(() => fake.close());
    const controller = new AbortController();
    controller.abort();
    const client = clientFor(fake);

    for await (const state of client.watchState(controller.signal)) assert.fail(`不该产出 ${state.counter}`);
    for await (const label of client.watchMenu('yoyo', ['碎碎念'], { signal: controller.signal })) {
      assert.fail(`不该产出 ${label}`);
    }
    assert.equal(fake.seen.length, 0);
  });

  test('watchMenu 遇到 unknown-owner 重新注册，只产出被点过的菜单项', async (t) => {
    const controller = new AbortController();
    let polls = 0;
    const fake = await startFake((seen, closed) => {
      if (route(seen) === '/menu/item') return { json: { ok: true } };
      polls += 1;
      if (polls === 1) return { json: { ok: false, reason: 'unknown-owner' } };
      if (polls === 2) return { json: { ok: true, events: { 碎碎念: 'main', 听一句: null } } };
      if (polls === 3) return { json: { ok: true, events: { 碎碎念: null, 听一句: 'main' } } };
      setImmediate(() => controller.abort());
      return hold(closed);
    });
    t.onTestFinished(() => fake.close());

    let registered = 0;
    const errors: unknown[] = [];
    const clicked: string[] = [];
    const menu = clientFor(fake).watchMenu('yoyo', ['碎碎念', '听一句'], {
      target: 'desktop',
      signal: controller.signal,
      onRegistered: () => {
        registered += 1;
      },
      onError: (error) => errors.push(error),
    });
    for await (const label of menu) clicked.push(label);

    assert.deepEqual(clicked, ['碎碎念', '听一句']);
    assert.equal(registered, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(fake.seen.map(route), [
      '/menu/item',
      '/menu/events',
      '/menu/item',
      '/menu/events',
      '/menu/events',
      '/menu/events',
    ]);
    const [item, events] = fake.seen;
    assert.equal(item?.method, 'POST');
    assert.deepEqual(item?.query, {});
    assert.deepEqual(item?.body, { owner: 'yoyo', labels: ['碎碎念', '听一句'], target: 'desktop' });
    assert.equal(item?.headers['x-dsh-pet-token'], 'tok');
    assert.equal(events?.method, 'GET');
    assert.deepEqual(events?.query, { owner: 'yoyo', wait: '8000' });
  });

  test('watchMenu 注册失败交给 onError；轮询出错静默重试，回 unknown-owner 时再注册', async (t) => {
    const controller = new AbortController();
    let items = 0;
    let polls = 0;
    const fake = await startFake((seen, closed) => {
      if (route(seen) === '/menu/item') {
        items += 1;
        return { json: items === 1 ? { ok: false, reason: 'too-many-owners', message: '菜单太多了' } : { ok: true } };
      }
      polls += 1;
      if (polls === 1) return { json: { ok: false, reason: 'unknown-owner' } };
      if (polls === 2) return { status: 500 };
      setImmediate(() => controller.abort());
      return hold(closed);
    });
    t.onTestFinished(() => fake.close());

    let registered = 0;
    const errors: unknown[] = [];
    const menu = clientFor(fake).watchMenu('小游戏', ['弹弓'], {
      signal: controller.signal,
      waitMs: 3000,
      retryMs: 5,
      onRegistered: () => {
        registered += 1;
      },
      onError: (error) => errors.push(error),
    });
    for await (const label of menu) assert.fail(`不该产出 ${label}`);

    assert.equal(registered, 1);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof PetApiError);
    assert.equal(errors[0].message, '菜单太多了');
    assert.equal(errors[0].reason, 'too-many-owners');
    assert.deepEqual(fake.seen.map(route), [
      '/menu/item',
      '/menu/events',
      '/menu/item',
      '/menu/events',
      '/menu/events',
    ]);
    assert.deepEqual(fake.seen[0]?.body, { owner: '小游戏', labels: ['弹弓'] });
    assert.deepEqual(fake.seen[1]?.query, { owner: '小游戏', wait: '3000' });
  });

  test('setStandaloneAi 打到服务根上的 /standalone-ai/settings，只发认识的字段', async (t) => {
    const fake = await startFake(() => ({
      json: {
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'demo',
        enabled: true,
        automaticWhispers: false,
        whisperIntervalSec: 300,
        hasKey: true,
      },
    }));
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake, { baseUrl: `${fake.baseUrl}/` });
    const input = {
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'demo',
      apiKey: 'secret',
      enabled: true,
      automaticWhispers: false,
      tools: true,
    };

    assert.deepEqual(await client.setStandaloneAi(input), { enabled: true, model: 'demo', hasKey: true });

    const [seen] = fake.seen;
    assert.equal(seen?.method, 'POST');
    assert.equal(seen?.path, '/standalone-ai/settings');
    assert.deepEqual(seen?.query, {});
    assert.equal(seen?.headers['x-dsh-pet-token'], 'tok');
    assert.equal(seen?.headers['content-type'], 'application/json');
    assert.deepEqual(seen?.body, {
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'demo',
      apiKey: 'secret',
      enabled: true,
      automaticWhispers: false,
    });
  });

  test('setStandaloneAi 没存上就抛错：先用桌宠给的说明，没有就报状态码', async (t) => {
    const answers: Answer[] = [
      { status: 400, json: { error: '设置未保存：请检查接口地址、模型名称、密钥和数值范围' } },
      { status: 503 },
      { json: { enabled: false, model: 'demo', hasKey: true } },
      { raw: 'oops' },
    ];
    const fake = await startFake(() => answers.shift() ?? {});
    t.onTestFinished(() => fake.close());
    const client = clientFor(fake);
    const input = { baseUrl: 'http://127.0.0.1:9/v1', model: 'demo', apiKey: 'secret', enabled: true };

    await assert.rejects(client.setStandaloneAi(input), {
      name: 'PetApiError',
      message: '设置未保存：请检查接口地址、模型名称、密钥和数值范围',
      status: 400,
      path: '/standalone-ai/settings',
    });
    await assert.rejects(client.setStandaloneAi(input), { message: '对话渠道没有接上（503）', status: 503 });
    await assert.rejects(client.setStandaloneAi(input), { message: '对话渠道没有接上（200）', status: 200 });
    await assert.rejects(client.setStandaloneAi(input), { message: 'oops', reason: 'bad-response' });
  });
});

describe('运行状态文件', () => {
  test('缺省路径在 ~/.dsh/dsh-pet，YOYO_PET_RUNTIME 可以改', () => {
    assert.equal(defaultRuntimePath({}), join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json'));
    assert.equal(defaultRuntimePath({ YOYO_PET_RUNTIME: '/tmp/pet.json' }), '/tmp/pet.json');
  });

  test('读出令牌；没有令牌就提示先启动独立模式', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'standalone-runtime.json');
    writeFileSync(file, JSON.stringify({ name: 'dsh-pet-standalone', pid: 1, port: 3080, token: 'abc' }));
    assert.equal(readRuntimeToken(file), 'abc');
    writeFileSync(file, JSON.stringify({ name: 'dsh-pet-standalone', token: '' }));
    assert.throws(() => readRuntimeToken(file), { message: '桌宠运行状态里没有令牌，先确认独立模式已经启动' });
  });

  test('缺省每次请求都重新读运行状态文件里的令牌', async (t) => {
    const file = join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'standalone-runtime.json');
    writeFileSync(file, JSON.stringify({ token: 'first' }));
    const previous = process.env['YOYO_PET_RUNTIME'];
    process.env['YOYO_PET_RUNTIME'] = file;
    t.onTestFinished(() => {
      if (previous === undefined) delete process.env['YOYO_PET_RUNTIME'];
      else process.env['YOYO_PET_RUNTIME'] = previous;
    });
    const fake = await startFake(() => ({ json: { ok: true, playbackId: 'pb-1' } }));
    t.onTestFinished(() => fake.close());
    const client = createPetClient({ baseUrl: fake.baseUrl, pet: 'main', surface: 'desktop' });

    await client.anim('东张西望');
    writeFileSync(file, JSON.stringify({ token: 'second' }));
    await client.anim('东张西望');

    assert.deepEqual(
      fake.seen.map((seen) => seen.headers['x-dsh-pet-token']),
      ['first', 'second'],
    );
  });
});
