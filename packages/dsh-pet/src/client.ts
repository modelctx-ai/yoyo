/**
 * dsh-pet 独立模式 HTTP 接口的客户端。只照 openapi.yaml 办事，不知道调用方是谁。
 */
import { setTimeout as delay } from 'node:timers/promises';

import { PetApiError } from './errors.ts';
import { defaultRuntimePath, readRuntimeToken } from './runtime.ts';
import type { ChatMemoryMessage, PollState, StandaloneAiInput, StandaloneAiResult, Surface } from './types.ts';

export interface PetClientOptions {
  /** 例如 `http://127.0.0.1:3080/dsh-pet-7340`。 */
  readonly baseUrl: string;
  readonly pet: string;
  readonly surface: Surface;
  /** 缺省每次请求都重新读运行状态文件里的令牌。 */
  readonly token?: () => string;
  readonly fetch?: typeof fetch;
  /** 单次请求超时，缺省 15 秒。长轮询在等待时长之外另给 12 秒。 */
  readonly timeoutMs?: number;
}

export type MenuTarget = 'web' | 'desktop' | 'both';

export interface BroadcastInput {
  readonly text: string;
  readonly durationMs?: number;
  /** 自带的配图地址（`url`）。 */
  readonly imageUrl?: string;
  /** 表情包池里的名字（`image`），和 `imageUrl` 二选一。 */
  readonly image?: string;
  /** 是否联动说话动画；不给按桌宠缺省（联动）。 */
  readonly anim?: boolean;
}

export interface AnimOptions {
  readonly lockId?: string;
  readonly facing?: 'left' | 'right';
}

export interface WatchStateOptions {
  /** 每次长轮询挂多久，缺省 8 秒（上限 10 秒）。 */
  readonly waitMs?: number;
  /** 出错以后等多久再试，缺省 2 秒。 */
  readonly retryMs?: number;
}

export interface WatchMenuOptions extends WatchStateOptions {
  readonly target?: MenuTarget;
  readonly signal: AbortSignal;
  /** 每次注册成功（包括桌宠重启后的重新注册）。 */
  readonly onRegistered?: () => void;
  /** 注册失败。轮询出错只静默重试。 */
  readonly onError?: (error: unknown) => void;
}

export interface PetClient {
  state(): Promise<PollState>;
  /** 长轮询：手里的版本还是 `since` 就挂着，直到有变化或等满 `timeoutMs`。 */
  waitState(since: number, timeoutMs: number, signal?: AbortSignal): Promise<PollState>;
  /** 先产出一份全量，之后每次变化产出一份；出错等 retryMs（缺省 2000）重试，直到 signal 中止。 */
  watchState(signal: AbortSignal, options?: WatchStateOptions): AsyncIterable<PollState>;
  chat(rounds?: number): Promise<ChatMemoryMessage[]>;
  /** 给了 lockId 是续期，没给是新建。 */
  lock(lockId?: string): Promise<{ readonly lockId: string; readonly expiresAt?: number }>;
  /** 永不抛错。 */
  release(lockId: string): Promise<void>;
  broadcast(lockId: string | undefined, input: BroadcastInput): Promise<void>;
  /** 返回这次点播的回执编号。 */
  anim(name: string, options?: AnimOptions): Promise<string | undefined>;
  registerMenu(owner: string, labels: readonly string[], target?: MenuTarget): Promise<void>;
  /** 菜单项 → 点它的宠物 id；没被点过是 null。读取即清空。 */
  menuEvents(owner: string, waitMs: number, signal?: AbortSignal): Promise<Record<string, string | null>>;
  /** 注册并长轮询，产出被点的菜单项；遇到 unknown-owner 重新注册；onRegistered/onError 给调用方记日志。 */
  watchMenu(owner: string, labels: readonly string[], options: WatchMenuOptions): AsyncIterable<string>;
  /** 写独立模式的对话设置。接口挂在服务根上，不在 baseUrl 的前缀下。 */
  setStandaloneAi(input: StandaloneAiInput): Promise<StandaloneAiResult>;
}

type Query = Readonly<Record<string, string | number | undefined>>;
type Body = Readonly<Record<string, unknown>>;

interface Reply {
  readonly status: number;
  readonly ok: boolean;
  readonly data: Body;
}

interface SendInit {
  readonly method: 'GET' | 'POST';
  readonly query?: Query;
  readonly body?: Body;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 等 8 秒的长轮询 20 秒超时。 */
const LONG_POLL_SLACK_MS = 12_000;
/** `/state` 的 timeout 和 `/menu/events` 的 wait 都封顶 10 秒。 */
const MAX_WAIT_MS = 10_000;
const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_RETRY_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function waitWithin(ms: number): number {
  return Number.isFinite(ms) ? Math.min(MAX_WAIT_MS, Math.max(0, Math.round(ms))) : 0;
}

/** 读不懂的响应按业务失败处理，和旧代码一样。 */
function parseBody(raw: string): Body {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (isRecord(data)) return data;
  } catch {
    /* 落到下面 */
  }
  return { ok: false, reason: 'bad-response', message: raw.slice(0, 180) };
}

function failure(reply: Reply, path: string, fallback: string): PetApiError {
  const reason = text(reply.data['reason']) || undefined;
  return new PetApiError(text(reply.data['message']) || reason || fallback, { path, status: reply.status, reason });
}

function expectOk(reply: Reply, path: string, fallback: string): Body {
  if (reply.data['ok'] !== true) throw failure(reply, path, fallback);
  return reply.data;
}

function isChatMessage(value: unknown): value is ChatMemoryMessage {
  return (
    isRecord(value) &&
    (value['role'] === 'user' || value['role'] === 'assistant') &&
    typeof value['content'] === 'string' &&
    typeof value['ts'] === 'number' &&
    Number.isFinite(value['ts'])
  );
}

function toPollState(reply: Reply, path: string): PollState {
  const { data } = reply;
  if (typeof data['counter'] !== 'number') {
    const reason = text(data['reason']) || 'bad-response';
    throw new PetApiError(text(data['message']) || reason, { path, status: reply.status, reason });
  }
  return {
    counter: data['counter'],
    sections: isRecord(data['sections']) ? data['sections'] : {},
    pets: isRecord(data['pets']) ? data['pets'] : {},
  } as PollState;
}

/** 等一会儿；signal 中止就提前返回，不抛错。 */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch(() => {});
}

/**
 * 单次请求的中止信号：到点按超时中止，调用方中止就跟着中止，用完调 `done()` 收掉计时器和监听。
 * 不用 `AbortSignal.any`：Node 22 里它挂在长寿的 signal 上会越积越多（每拍长轮询漏一份）。
 */
function requestSignal(ms: number, outer?: AbortSignal): { readonly signal: AbortSignal; readonly done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    ms,
  );
  timer.unref();
  const follow = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener('abort', follow, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', follow);
    },
  };
}

export function createPetClient(options: PetClientOptions): PetClient {
  const root = options.baseUrl.trim().replace(/\/+$/, '');
  const token = options.token ?? (() => readRuntimeToken(defaultRuntimePath()));
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function petQuery(lockId?: string): Query {
    return { pet: options.pet, surface: options.surface, lock: lockId || undefined };
  }

  async function send(base: string, path: string, init: SendInit): Promise<Reply> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    const headers: Record<string, string> = { 'x-dsh-pet-token': token() };
    if (init.method === 'POST') headers['content-type'] = 'application/json';
    const { signal, done } = requestSignal(init.timeoutMs ?? timeoutMs, init.signal);
    try {
      const response = await request(`${base}${path}${search ? `?${search}` : ''}`, {
        method: init.method,
        headers,
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
        signal,
      });
      // 读响应体也算在这次请求的时限里
      return { status: response.status, ok: response.ok, data: parseBody(await response.text()) };
    } finally {
      done();
    }
  }

  /** `/dsh-pet-7340` 下的接口：非 2xx 一律抛错。 */
  async function call(path: string, init: SendInit): Promise<Reply> {
    const reply = await send(root, path, init);
    if (!reply.ok) {
      throw new PetApiError(`dsh-pet ${reply.status} ${path}`, {
        path,
        status: reply.status,
        reason: text(reply.data['reason']) || undefined,
      });
    }
    return reply;
  }

  async function readState(
    query: Query | undefined,
    wait: number | undefined,
    signal?: AbortSignal,
  ): Promise<PollState> {
    const path = '/state';
    const timeout = wait === undefined ? undefined : wait + LONG_POLL_SLACK_MS;
    return toPollState(await call(path, { method: 'GET', query, timeoutMs: timeout, signal }), path);
  }

  function state(): Promise<PollState> {
    return readState(undefined, undefined);
  }

  function waitState(since: number, waitMs: number, signal?: AbortSignal): Promise<PollState> {
    const wait = waitWithin(waitMs);
    return readState({ since, timeout: wait }, wait, signal);
  }

  async function* watchState(signal: AbortSignal, watch: WatchStateOptions = {}): AsyncGenerator<PollState, void> {
    const waitMs = watch.waitMs ?? DEFAULT_WAIT_MS;
    const retryMs = watch.retryMs ?? DEFAULT_RETRY_MS;
    let since: number | undefined;
    while (!signal.aborted) {
      let next: PollState;
      try {
        next =
          since === undefined ? await readState(undefined, undefined, signal) : await waitState(since, waitMs, signal);
      } catch {
        if (signal.aborted) return;
        await pause(retryMs, signal);
        continue;
      }
      // 等满了也没变化：接着挂
      if (next.counter === since) continue;
      since = next.counter;
      yield next;
    }
  }

  async function chat(rounds?: number): Promise<ChatMemoryMessage[]> {
    const path = '/chat';
    const count =
      rounds === undefined || !Number.isFinite(rounds) ? undefined : Math.min(200, Math.max(0, Math.round(rounds)));
    const data = expectOk(
      await call(path, { method: 'GET', query: { pet: options.pet, rounds: count } }),
      path,
      '读不到桌宠对话记忆',
    );
    const messages: unknown = data['messages'];
    if (!Array.isArray(messages)) return [];
    return messages
      .filter(isChatMessage)
      .map((message) => ({ role: message.role, content: message.content, ts: message.ts }));
  }

  async function lock(lockId?: string): Promise<{ readonly lockId: string; readonly expiresAt?: number }> {
    const path = '/lock';
    const reply = await call(path, { method: 'POST', query: petQuery(), body: lockId ? { lockId } : {} });
    const id = reply.data['lockId'];
    if (reply.data['ok'] !== true || typeof id !== 'string') throw failure(reply, path, '拿不到桌宠占用锁');
    const expiresAt = reply.data['expiresAt'];
    return typeof expiresAt === 'number' ? { lockId: id, expiresAt } : { lockId: id };
  }

  async function release(lockId: string): Promise<void> {
    try {
      // 释放不带 surface：宠物中途被隐藏也要撤得掉锁
      await send(root, '/lock/release', { method: 'POST', query: { pet: options.pet }, body: { lockId } });
    } catch {
      /* 撤不掉也没关系，锁到点会自己过期 */
    }
  }

  async function broadcast(lockId: string | undefined, input: BroadcastInput): Promise<void> {
    const path = '/broadcast';
    const body = {
      text: input.text,
      anim: input.anim,
      duration: input.durationMs,
      url: input.imageUrl || undefined,
      image: input.image || undefined,
    };
    expectOk(await call(path, { method: 'POST', query: petQuery(lockId), body }), path, '投喂失败');
  }

  async function anim(name: string, animOptions: AnimOptions = {}): Promise<string | undefined> {
    const path = '/anim';
    const body = { name, facing: animOptions.facing };
    const data = expectOk(
      await call(path, { method: 'POST', query: petQuery(animOptions.lockId), body }),
      path,
      `动作不在池内：${name}`,
    );
    const playbackId = data['playbackId'];
    return typeof playbackId === 'string' ? playbackId : undefined;
  }

  async function registerMenu(owner: string, labels: readonly string[], target?: MenuTarget): Promise<void> {
    const path = '/menu/item';
    const body = { owner, labels: [...labels], target };
    expectOk(await call(path, { method: 'POST', body }), path, '菜单项没有注册上');
  }

  async function menuEvents(
    owner: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, string | null>> {
    const path = '/menu/events';
    const wait = waitWithin(waitMs);
    const reply = await call(path, {
      method: 'GET',
      query: { owner, wait },
      timeoutMs: wait + LONG_POLL_SLACK_MS,
      signal,
    });
    const events = expectOk(reply, path, '读不到菜单事件')['events'];
    const entries = isRecord(events) ? Object.entries(events) : [];
    return Object.fromEntries(entries.map(([label, pet]) => [label, typeof pet === 'string' ? pet : null]));
  }

  async function* watchMenu(
    owner: string,
    labels: readonly string[],
    watch: WatchMenuOptions,
  ): AsyncGenerator<string, void> {
    const { signal } = watch;
    const waitMs = watch.waitMs ?? DEFAULT_WAIT_MS;
    const retryMs = watch.retryMs ?? DEFAULT_RETRY_MS;
    let register = true;
    while (!signal.aborted) {
      if (register) {
        register = false;
        try {
          await registerMenu(owner, labels, watch.target);
          watch.onRegistered?.();
        } catch (error) {
          if (signal.aborted) return;
          watch.onError?.(error);
          // 注册不上也先去轮询：桌宠起来以后会回 unknown-owner，到时再注册
          await pause(retryMs, signal);
          continue;
        }
      }
      let events: Record<string, string | null>;
      try {
        events = await menuEvents(owner, waitMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof PetApiError && error.reason === 'unknown-owner') {
          // 桌宠重启过，或者菜单被清掉了
          register = true;
          continue;
        }
        await pause(retryMs, signal);
        continue;
      }
      for (const [label, pet] of Object.entries(events)) {
        if (pet !== null && !signal.aborted) yield label;
      }
    }
  }

  async function setStandaloneAi(input: StandaloneAiInput): Promise<StandaloneAiResult> {
    const path = '/standalone-ai/settings';
    // 桌宠按白名单校验，多一个字段整份拒收，所以只挑认识的字段
    const body = {
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      enabled: input.enabled,
      automaticWhispers: input.automaticWhispers,
      timeoutMs: input.timeoutMs,
    };
    const reply = await send(new URL(root).origin, path, { method: 'POST', body });
    const { data } = reply;
    const enabled = data['enabled'];
    if (!reply.ok || typeof enabled !== 'boolean' || (input.enabled !== undefined && enabled !== input.enabled)) {
      throw new PetApiError(text(data['message']) || text(data['error']) || `对话渠道没有接上（${reply.status}）`, {
        path,
        status: reply.status,
        reason: text(data['reason']) || undefined,
      });
    }
    return { enabled, model: text(data['model']), hasKey: data['hasKey'] === true };
  }

  return {
    state,
    waitState,
    watchState,
    chat,
    lock,
    release,
    broadcast,
    anim,
    registerMenu,
    menuEvents,
    watchMenu,
    setStandaloneAi,
  };
}
