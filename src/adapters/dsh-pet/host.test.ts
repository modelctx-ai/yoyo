import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'vite-plus/test';

import { createPetClient } from '@yoyo/dsh-pet';
import type { ChatMemoryMessage, PetClient, PollState, SayData } from '@yoyo/dsh-pet';

import type { PetConfig } from '../../app/config.ts';
import type { PetSaying } from '../../kernel/types.ts';
import type { Logger, StageLine } from '../../ports/index.ts';
import { createDshPetHost } from './host.ts';

const pet: PetConfig = { baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', id: 'main', surface: 'desktop' };

const line: StageLine = {
  text: '该喝水了',
  durationMs: 3000,
  action: '东张西望',
  imageUrl: 'https://cdn.example.com/a.png',
};

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** 假客户端：记下每次调用，方法可以逐个替换。 */
function fakeClient(overrides: Partial<PetClient> = {}): { readonly client: PetClient; readonly calls: Call[] } {
  const calls: Call[] = [];
  const base: PetClient = {
    state: async () => ({ counter: 0, sections: {}, pets: {} }),
    waitState: async () => ({ counter: 0, sections: {}, pets: {} }),
    async *watchState() {},
    chat: async () => [],
    lock: async () => ({ lockId: 'lk-1' }),
    release: async () => {},
    broadcast: async () => {},
    anim: async () => 'pb-1',
    registerMenu: async () => {},
    menuEvents: async () => ({}),
    async *watchMenu() {},
    setStandaloneAi: async (input) => ({ enabled: true, model: input.model, hasKey: true }),
  };
  const methods = { ...base, ...overrides } as unknown as Record<string, (...args: unknown[]) => unknown>;
  const client = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name, args });
        return method(...args);
      },
    ]),
  ) as unknown as PetClient;
  return { client, calls };
}

function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

function sayState(counter: number, say?: { readonly counter: number; readonly data: SayData | null }): PollState {
  const empty = { counter: 0, data: null };
  return {
    counter,
    sections: {},
    pets: say ? { main: { say, anim: empty, position: empty, throw: empty, lock: empty } } : {},
  };
}

function scripted(states: readonly PollState[]): Partial<PetClient> {
  return {
    async *watchState() {
      yield* states;
    },
  };
}

async function collect(iterable: AsyncIterable<PetSaying>): Promise<PetSaying[]> {
  const out: PetSaying[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('dsh-pet 宿主', () => {
  test('名字是 dsh-pet；缺省自己建客户端，建的时候不发请求', () => {
    assert.equal(createDshPetHost({ pet, logger: memoryLogger() }).name, 'dsh-pet');
  });

  test('present 先占锁，再投喂、点播动作、执行 during，最后放锁', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    await host.present(line, async () => {
      calls.push({ name: 'during', args: [] });
    });

    assert.deepEqual(calls, [
      { name: 'lock', args: [] },
      {
        name: 'broadcast',
        args: ['lk-1', { text: '该喝水了', durationMs: 3000, imageUrl: 'https://cdn.example.com/a.png', anim: false }],
      },
      { name: 'anim', args: ['东张西望', { lockId: 'lk-1' }] },
      { name: 'during', args: [] },
      { name: 'release', args: ['lk-1'] },
    ]);
  });

  test('没有配图就不带 imageUrl；不给 during 也照样放锁', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    await host.present({ text: '嗨', durationMs: 2000, action: '转身' });

    assert.deepEqual(calls[1], { name: 'broadcast', args: ['lk-1', { text: '嗨', durationMs: 2000, anim: false }] });
    assert.deepEqual(
      calls.map((call) => call.name),
      ['lock', 'broadcast', 'anim', 'release'],
    );
  });

  test('投喂失败也放锁，并把错误抛给调用方', async () => {
    const { client, calls } = fakeClient({
      broadcast: async () => {
        throw new Error('投喂失败');
      },
    });
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });
    let ran = false;

    await assert.rejects(
      host.present(line, async () => {
        ran = true;
      }),
      { message: '投喂失败' },
    );

    assert.equal(ran, false);
    assert.deepEqual(
      calls.map((call) => call.name),
      ['lock', 'broadcast', 'release'],
    );
  });

  test('占不到锁就直接抛错，不投喂也不放锁', async () => {
    const { client, calls } = fakeClient({
      lock: async () => {
        throw new Error('拿不到桌宠占用锁');
      },
    });
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    await assert.rejects(host.present(line), { message: '拿不到桌宠占用锁' });
    assert.deepEqual(
      calls.map((call) => call.name),
      ['lock'],
    );
  });

  test('动作没播成只告警，照样执行 during 并放锁', async () => {
    const { client, calls } = fakeClient({
      anim: async (name) => {
        throw new Error(`动作不在池内：${name}`);
      },
    });
    const logger = memoryLogger();
    const host = createDshPetHost({ pet, logger, client });
    let ran = false;

    await host.present({ ...line, action: '跳舞' }, async () => {
      ran = true;
    });

    assert.equal(ran, true);
    assert.deepEqual(logger.lines, ['warn 动作没播成（跳舞）：动作不在池内：跳舞']);
    assert.equal(calls.at(-1)?.name, 'release');
  });

  test('during 出错也放锁', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    await assert.rejects(
      host.present(line, async () => {
        throw new Error('afplay 退出 1');
      }),
      { message: 'afplay 退出 1' },
    );
    assert.equal(calls.at(-1)?.name, 'release');
  });

  test('cue 不占锁地点播动作，失败就 reject', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    await host.cue('碎碎念-对屏碎碎念');
    assert.deepEqual(calls, [{ name: 'anim', args: ['碎碎念-对屏碎碎念'] }]);

    const failing = fakeClient({
      anim: async () => {
        throw new Error('unknown-animation');
      },
    });
    await assert.rejects(createDshPetHost({ pet, logger: memoryLogger(), client: failing.client }).cue('跳舞'), {
      message: 'unknown-animation',
    });
  });

  test('chatHistory 按轮数读桌宠对话记忆，跳过格式不对的', async () => {
    const messages = [
      { role: 'user', content: '在吗', ts: 1 },
      { role: 'assistant', content: '', ts: 2 },
      { role: 'tool', content: '工具输出', ts: 3 },
      { role: 'assistant', content: '在呀', ts: 4 },
      { role: 'user', content: '没有时间戳' },
    ];
    // 桌宠回什么都可能：故意塞进不合格式的消息
    const { client, calls } = fakeClient({ chat: async () => messages as unknown as ChatMemoryMessage[] });
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    assert.deepEqual(await host.chatHistory(200), [
      { role: 'user', content: '在吗', ts: 1 },
      { role: 'assistant', content: '在呀', ts: 4 },
    ]);
    assert.deepEqual(calls, [{ name: 'chat', args: [200] }]);
  });

  test('workStatus 读 state 里的 workStatus，没写过是 null', async () => {
    const states: PollState[] = [
      { counter: 3, sections: { workStatus: { counter: 2, data: { state: 'working', task: '读代码' } } }, pets: {} },
      { counter: 3, sections: { workStatus: { counter: 2, data: { state: null, task: null } } }, pets: {} },
      { counter: 3, sections: { workStatus: { counter: 0, data: null } }, pets: {} },
      { counter: 3, sections: {}, pets: {} },
    ];
    const { client } = fakeClient({ state: async () => states.shift() ?? { counter: 0, sections: {}, pets: {} } });
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    assert.deepEqual(await host.workStatus(), { state: 'working', task: '读代码' });
    assert.deepEqual(await host.workStatus(), { state: null, task: null });
    assert.equal(await host.workStatus(), null);
    assert.equal(await host.workStatus(), null);
  });

  test('menu 挂在桌面端，注册成功和失败都记日志', async () => {
    let options: Parameters<PetClient['watchMenu']>[2] | undefined;
    const { client, calls } = fakeClient({
      async *watchMenu(_owner, _labels, given) {
        options = given;
        yield '碎碎念';
        yield '听一句';
      },
    });
    const logger = memoryLogger();
    const host = createDshPetHost({ pet, logger, client });
    const controller = new AbortController();

    const clicked: string[] = [];
    for await (const label of host.menu('yoyo', ['碎碎念', '听一句'], controller.signal)) clicked.push(label);
    options?.onRegistered?.();
    options?.onError?.(new Error('fetch failed'));

    assert.deepEqual(clicked, ['碎碎念', '听一句']);
    assert.deepEqual(calls[0]?.args.slice(0, 2), ['yoyo', ['碎碎念', '听一句']]);
    assert.equal(options?.target, 'desktop');
    assert.equal(options?.signal, controller.signal);
    assert.deepEqual(logger.lines, ['info 右键里已有 yoyo：碎碎念、听一句', 'error 菜单没挂上：fetch failed']);
  });

  test('sayings 先给启动时已有的那句，之后只在气泡变了时给新句子', async () => {
    const { client, calls } = fakeClient(
      scripted([
        sayState(10, { counter: 3, data: { text: '  主人好  ' } }),
        // 别的叶子变了，气泡没变
        sayState(11, { counter: 3, data: { text: '主人好' } }),
        sayState(12, { counter: 5, data: { text: '新的一句' } }),
        // 清空气泡、空文本、宠物条目不见了，都不算
        sayState(13, { counter: 6, data: { clear: true } }),
        sayState(14, { counter: 7, data: { text: '   ' } }),
        sayState(15),
        sayState(16, { counter: 8, data: { text: '再来一句', duration: 3000, anim: false } }),
        sayState(17, { counter: 9, data: { text: '再来一句' } }),
      ]),
    );
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });
    const controller = new AbortController();

    assert.deepEqual(await collect(host.sayings(controller.signal)), [
      { text: '主人好', initial: true },
      { text: '新的一句', initial: false },
      { text: '再来一句', initial: false },
      { text: '再来一句', initial: false },
    ]);
    assert.equal(calls[0]?.name, 'watchState');
    assert.equal(calls[0]?.args[0], controller.signal);
  });

  test('sayings 启动时气泡是空的或被清掉，就不给 initial', async () => {
    const empty = fakeClient(scripted([sayState(1), sayState(2, { counter: 2, data: { text: '你好' } })]));
    assert.deepEqual(
      await collect(
        createDshPetHost({ pet, logger: memoryLogger(), client: empty.client }).sayings(AbortSignal.abort()),
      ),
      [{ text: '你好', initial: false }],
    );

    const cleared = fakeClient(
      scripted([
        sayState(1, { counter: 1, data: { clear: true } }),
        sayState(2, { counter: 1, data: { clear: true } }),
        sayState(3, { counter: 2, data: { text: '回来了' } }),
      ]),
    );
    assert.deepEqual(
      await collect(
        createDshPetHost({ pet, logger: memoryLogger(), client: cleared.client }).sayings(AbortSignal.abort()),
      ),
      [{ text: '回来了', initial: false }],
    );
  });

  test('对话渠道只打开桌宠对话，不打开它自己的周期碎碎念', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });

    assert.deepEqual(await host.bindChat({ baseUrl: 'https://example.test/v1/', model: 'demo', apiKey: 'secret' }), {
      model: 'demo',
    });
    assert.deepEqual(calls, [
      {
        name: 'setStandaloneAi',
        args: [
          {
            protocol: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'demo',
            apiKey: 'secret',
            enabled: true,
            automaticWhispers: false,
          },
        ],
      },
    ]);
  });

  test('bindChat 缺地址、模型或密钥就不找桌宠', async () => {
    const { client, calls } = fakeClient();
    const host = createDshPetHost({ pet, logger: memoryLogger(), client });
    const full = { baseUrl: 'http://127.0.0.1:9/v1', model: 'demo', apiKey: 'token' };

    for (const binding of [
      { ...full, baseUrl: '' },
      { ...full, baseUrl: '///' },
      { ...full, model: '' },
      { ...full, apiKey: '' },
    ]) {
      await assert.rejects(host.bindChat(binding), { message: 'config.json 的 llm 不完整' });
    }
    assert.deepEqual(calls, []);
  });

  test('bindChat 桌宠没有打开对话就抛错；确认的模型名优先用桌宠回的', async () => {
    const off = fakeClient({ setStandaloneAi: async () => ({ enabled: false, model: 'demo', hasKey: true }) });
    const binding = { baseUrl: 'http://127.0.0.1:9/v1', model: 'demo', apiKey: 'token' };
    await assert.rejects(createDshPetHost({ pet, logger: memoryLogger(), client: off.client }).bindChat(binding), {
      message: '对话渠道没有接上',
    });

    const renamed = fakeClient({ setStandaloneAi: async () => ({ enabled: true, model: 'demo-2', hasKey: true }) });
    assert.deepEqual(
      await createDshPetHost({ pet, logger: memoryLogger(), client: renamed.client }).bindChat(binding),
      { model: 'demo-2' },
    );
  });

  test('接真客户端：一句台词在桌宠那边依次是占锁、投喂、点播、放锁', async (t) => {
    const seen: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = Buffer.concat(chunks).toString('utf8');
        seen.push({
          method: req.method ?? '',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: raw ? JSON.parse(raw) : undefined,
        });
        const body = url.pathname.endsWith('/lock') ? { ok: true, lockId: 'lk-9', expiresAt: 1 } : { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    const config: PetConfig = { ...pet, baseUrl: `http://127.0.0.1:${port}/dsh-pet-7340` };
    const client = createPetClient({
      baseUrl: config.baseUrl,
      pet: config.id,
      surface: config.surface,
      token: () => 't',
    });
    const host = createDshPetHost({ pet: config, logger: memoryLogger(), client });

    await host.present({ text: '该喝水了', durationMs: 3000, action: '东张西望' });

    assert.deepEqual(seen, [
      { method: 'POST', path: '/dsh-pet-7340/lock', query: { pet: 'main', surface: 'desktop' }, body: {} },
      {
        method: 'POST',
        path: '/dsh-pet-7340/broadcast',
        query: { pet: 'main', surface: 'desktop', lock: 'lk-9' },
        body: { text: '该喝水了', anim: false, duration: 3000 },
      },
      {
        method: 'POST',
        path: '/dsh-pet-7340/anim',
        query: { pet: 'main', surface: 'desktop', lock: 'lk-9' },
        body: { name: '东张西望' },
      },
      { method: 'POST', path: '/dsh-pet-7340/lock/release', query: { pet: 'main' }, body: { lockId: 'lk-9' } },
    ]);
  });
});
