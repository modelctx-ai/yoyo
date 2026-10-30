import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  createContext,
  createMemoryStore,
  eventEntry,
  userEntry,
  type Context,
  type MemoryStore,
} from '@modelctx-ai/ctx';
import { createMemoryStore as createMemory } from '@modelctx-ai/ctx-memory';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import type { PaceDecision } from '../kernel/pace.ts';
import { petChatEntries, sessionFor, taskSession, yoyoProjection } from '../brain/context.ts';
import { deliverArtifact } from '../features/tasks/artifacts.ts';
import { requestApproval } from '../features/approvals/approvals.ts';
import { mergeAgents } from '../features/tasks/agents.ts';
import { askTask } from '../features/tasks/tasks.ts';
import { drain } from '../runtime/inbox.ts';
import { createArtifactFiles } from '../storage/artifacts.ts';
import { memoryLogger, memoryRepos } from '../runtime/testing.ts';
import { startWeb, type WebServer } from './server.ts';

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** 自己发请求：fetch 改不了 Host 头。 */
function raw(
  web: WebServer,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const url = new URL(path, web.origin);
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { host: url.host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const T0 = new Date(2026, 9, 24, 15, 0, 0).getTime();

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

/** 在后台读一个 SSE 响应：事件边来边进 `events`（注释行跳过），流结束 `done` 就好；`stop` 是客户端自己掐断。 */
function collectSse(response: Response): { events: SseEvent[]; done: Promise<void>; stop: () => Promise<void> } {
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name && data) events.push({ event: name, data: JSON.parse(data) as unknown });
      }
    }
  })();
  return { events, done, stop: () => reader.cancel() };
}

/** 读到流结束，返回所有事件。 */
async function readSse(response: Response): Promise<SseEvent[]> {
  const stream = collectSse(response);
  await stream.done;
  return stream.events;
}

/** POST /api/tasks 应该被拒：回 400，返回那句话。 */
async function badRequest(
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>,
  body: unknown,
): Promise<string> {
  const { status, data } = await call('POST', '/api/tasks', body);
  assert.equal(status, 400);
  return (data as { error: string }).error;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await sleep(10);
  }
}

describe('web 管理页', () => {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-web-'));
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  writeFileSync(paths.configFile, JSON.stringify({ stage: 'console', llm: { apiKey: 'secret-key', model: 'demo' } }));
  const repos = memoryRepos({ now: () => new Date(T0) });
  const logger = memoryLogger();
  const memory: MemoryStore = createMemory();
  const context = createContext({
    store: createMemoryStore(),
    session: sessionFor('main'),
    projection: yoyoProjection,
  });
  let unreachable = false;
  let lastPace: PaceDecision | null = null;
  let web: WebServer;
  const files = createArtifactFiles(paths.artifactsDir);
  const revealed: string[] = [];
  const approved: number[] = [];

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await fetch(new URL(path, web.origin), {
      method,
      headers: {
        authorization: `Bearer ${web.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }

  beforeAll(async () => {
    web = await startWeb({
      config: parseConfig({ llm: { model: 'demo', apiKey: 'secret-key' }, memory: { enabled: true } }),
      paths,
      repos,
      context,
      memory,
      host: {
        name: 'dsh-pet',
        workStatus: async () => {
          if (unreachable) throw new Error('connect ECONNREFUSED');
          return { state: 'busy', task: '写周报' };
        },
      },
      schedule: () => ({ nextWhisper: T0 + 60_000, lastTalk: 0, lastPace }),
      talk: async (text, _signal, onDelta) => {
        if (text === '坏了') throw new Error('没配 llm，回不了话');
        const reply = `收到：${text}`;
        // 流式时一个字一个字吐，开头多一个换行：整段回复是去了首尾空白的
        for (const piece of `\n${reply}`) onDelta?.(piece);
        return reply;
      },
      agents: mergeAgents([]),
      pollMs: 20,
      now: () => new Date(T0),
      files,
      reveal: (path) => void revealed.push(path),
      onApproved: () => void approved.push(repos.approvals.list({ states: ['approved'] }).at(0)?.id ?? 0),
      logger,
    });
  });

  afterAll(async () => {
    await web.close();
  });

  test('页面谁都能取，里面没有数据；脚本和样式带 CSP 的 nonce', async () => {
    assert.match(web.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{32}$/);
    const reply = await raw(web, 'GET', '/');
    assert.equal(reply.status, 200);
    const csp = String(reply.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.ok(reply.body.includes(`<script nonce="${nonce}">`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!reply.body.includes(web.token));
  });

  const paceView = async (): Promise<unknown> =>
    ((await call('GET', '/api/status')).data as { lastPace: unknown }).lastPace;

  test('概览带上下一句间隔是怎么来的：固定、挑的档、退回的原因，各带一句短说明', async () => {
    lastPace = { source: 'fixed', ms: 300_000 };
    assert.deepEqual(await paceView(), { source: 'fixed', sec: 300, note: '按固定间隔' });
    lastPace = { source: 'decided', ms: 1_800_000, option: '30m', confidence: 0.8 };
    assert.deepEqual(await paceView(), {
      source: 'decided',
      sec: 1800,
      option: '30m',
      confidence: 0.8,
      note: '隔 30 分钟',
    });
    lastPace = { source: 'decided', ms: 3_600_000, option: '1h', confidence: 0.6 };
    assert.equal(((await paceView()) as { note: string }).note, '主人在忙，隔 1 小时');
    lastPace = { source: 'fallback', ms: 300_000, reason: 'timeout' };
    assert.deepEqual(await paceView(), {
      source: 'fallback',
      sec: 300,
      reason: 'timeout',
      note: '决策模型超时，按固定间隔',
    });
    lastPace = null;
  });

  test('只认本机 Host、自己的 Origin；跨站、没令牌、不是 JSON 的都挡掉', async () => {
    assert.equal((await raw(web, 'GET', '/', { headers: { host: 'evil.example' } })).status, 403);
    const auth = { authorization: `Bearer ${web.token}` };
    assert.equal(
      (await raw(web, 'GET', '/api/status', { headers: { ...auth, origin: 'http://evil.example' } })).status,
      403,
    );
    assert.equal((await raw(web, 'GET', '/api/status', { headers: { ...auth, origin: web.origin } })).status, 200);
    assert.equal(
      (await raw(web, 'GET', '/api/status', { headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).status,
      403,
    );
    assert.equal((await raw(web, 'GET', '/api/status')).status, 401);
    assert.equal((await raw(web, 'GET', '/api/status', { headers: { authorization: 'Bearer nope' } })).status, 401);
    const form = await raw(web, 'POST', '/api/actions/whisper', {
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    assert.equal(form.status, 415);
    assert.equal((await raw(web, 'GET', '/nope')).status, 404);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });

  test('概览：桌宠、模型、记忆、下一句碎碎念；密钥不出现', async () => {
    const { status, data } = await call('GET', '/api/status');
    assert.equal(status, 200);
    assert.deepEqual((data as { pet: unknown }).pet, { reachable: true, work: { state: 'busy', task: '写周报' } });
    assert.equal((data as { nextWhisper: number }).nextWhisper, T0 + 60_000);
    assert.equal((data as { lastTalk: number | null }).lastTalk, null);
    assert.ok(!JSON.stringify(data).includes('secret-key'));
    assert.equal((data as { lastPace: unknown }).lastPace, null, '还没说过，没有间隔的来历');
    unreachable = true;
    assert.deepEqual(((await call('GET', '/api/status')).data as { pet: unknown }).pet, {
      reachable: false,
      work: null,
    });
    unreachable = false;
  });

  test('对话：按时间排好，碎碎念单列', async () => {
    await context.append(
      ...petChatEntries([
        { role: 'user', content: '今天要带伞吗', ts: T0 - 2000 },
        { role: 'assistant', content: '要带', ts: T0 - 1000 },
      ]),
    );
    const { data } = await call('GET', '/api/context');
    assert.deepEqual(
      (data as { kind: string; text: string; via?: string }[]).map((item) => `${item.kind}:${item.text}:${item.via}`),
      ['user:今天要带伞吗:dsh-pet', 'assistant:要带:dsh-pet'],
    );
  });

  test('工作台聊一句：回复原样回来；空的、太长的、没回上来的都说清楚', async () => {
    assert.deepEqual(await call('POST', '/api/chat', { text: '  在吗 ' }), {
      status: 200,
      data: { reply: '收到：在吗' },
    });
    assert.deepEqual(await call('POST', '/api/chat', { text: ' ' }), { status: 400, data: { error: '要说点什么' } });
    assert.equal((await call('POST', '/api/chat', { text: '长'.repeat(4001) })).status, 400);
    assert.deepEqual(await call('POST', '/api/chat', { text: '坏了' }), {
      status: 502,
      data: { error: 'yoyo 没回上来：没配 llm，回不了话' },
    });
  });

  test('记忆：改画像、忘掉事实、退役程序，都记一笔', async () => {
    const source = { session: 'pet:main', from: 1, upTo: 1 };
    const fact = await memory.facts.add({
      subject: 'owner',
      text: '主人怕淋雨',
      topic: 'owner',
      validFrom: T0,
      confidence: 0.9,
      salience: 0.5,
      sources: [source],
    });
    const rule = await memory.procedures.add({ when: '下雨', do: '提醒带伞', evidence: [source], at: T0 });
    let view = (await call('GET', '/api/memory')).data as { facts: { id: string }[]; rules: { id: string }[] };
    assert.deepEqual(
      view.facts.map((item) => item.id),
      [fact.id],
    );
    assert.deepEqual(
      view.rules.map((item) => item.id),
      [rule.id],
    );

    assert.equal((await call('PUT', '/api/memory/core', { text: '  主人叫小王  ' })).status, 200);
    assert.deepEqual(await memory.core.get(), { text: '主人叫小王', at: T0 });
    assert.equal((await call('PUT', '/api/memory/core', { text: 1 })).status, 400);

    assert.equal((await call('DELETE', `/api/memory/facts/${fact.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/memory/facts/${fact.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/memory/rules/${rule.id}`)).status, 200);
    view = (await call('GET', '/api/memory')).data as typeof view;
    assert.deepEqual([view.facts, view.rules], [[], []]);
    assert.deepEqual(
      repos.activity
        .list(3)
        .map((event) => event.type)
        .toSorted(),
      ['memory-core-edit', 'memory-forget', 'memory-retire'],
    );
  });

  test('日程和联系人：加、列、删；填错回一句话', async () => {
    const bad = await call('POST', '/api/alarms', { title: '喝水', time: '25:00', repeat: 'daily' });
    assert.deepEqual(bad, { status: 400, data: { error: '时间要写成 HH:MM' } });
    const added = (await call('POST', '/api/alarms', { title: '周会', time: '10:00', repeat: 'weekly', weekday: 1 }))
      .data as { id: string; weekday: number };
    assert.equal(added.weekday, 1);
    assert.equal(((await call('GET', '/api/alarms')).data as unknown[]).length, 1);
    assert.equal((await call('DELETE', `/api/alarms/${added.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/alarms/${added.id}`)).status, 404);

    const contact = (await call('POST', '/api/contacts', { name: '小王', yoyo: 'yoyo://xiaowang@example' })).data as {
      id: string;
    };
    assert.equal(((await call('GET', '/api/contacts')).data as unknown[]).length, 1);
    assert.equal((await call('DELETE', `/api/contacts/${contact.id}`)).status, 200);
    assert.deepEqual((await call('POST', '/api/contacts', { name: '小李' })).data, { error: '联系人要有 yoyo 地址' });
  });

  test('设置：读到的密钥打了码；整份存、只改开关都写回 config.json，填错回一句话', async () => {
    const read = (await call('GET', '/api/config')).data as {
      file: string;
      text: string;
      switches: Record<string, boolean>;
    };
    assert.equal(read.file, paths.configFile);
    assert.ok(!read.text.includes('secret-key'));
    assert.equal(read.switches['weather.enabled'], true);

    const edited = JSON.parse(read.text) as Record<string, unknown>;
    edited['intervalSec'] = 900;
    assert.equal((await call('PUT', '/api/config', { text: JSON.stringify(edited) })).status, 200);
    const saved = JSON.parse(readFileSync(paths.configFile, 'utf8')) as {
      intervalSec: number;
      llm: { apiKey: string };
    };
    assert.equal(saved.intervalSec, 900);
    assert.equal(saved.llm.apiKey, 'secret-key');

    assert.equal((await call('PATCH', '/api/config', { switches: { 'weather.enabled': false } })).status, 200);
    assert.deepEqual((JSON.parse(readFileSync(paths.configFile, 'utf8')) as { weather: unknown }).weather, {
      enabled: false,
    });

    assert.deepEqual(await call('PUT', '/api/config', { text: '[]' }), {
      status: 400,
      data: { error: '整份配置要是一个对象' },
    });
    assert.equal((await call('PATCH', '/api/config', { switches: { 'web.enabled': false } })).status, 400);
    assert.deepEqual(
      repos.activity
        .list(10)
        .map((event) => event.type)
        .filter((type) => type.startsWith('config-'))
        .toSorted(),
      ['config-edit', 'config-switch'],
    );
  });

  test('改日程：PATCH /api/alarms/:id 改字段、暂停、恢复；填错回 400，没有的回 404', async () => {
    const added = (await call('POST', '/api/alarms', { title: '周会', time: '10:00', repeat: 'weekly', weekday: 1 }))
      .data as { id: string };
    const path = `/api/alarms/${added.id}`;
    const edited = await call('PATCH', path, { title: '开周会', time: '10:30', weekday: 2 });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data, {
      id: added.id,
      title: '开周会',
      kind: 'alarm',
      time: '10:30',
      date: null,
      repeat: 'weekly',
      weekday: 2,
      enabled: true,
      lastFired: null,
    });
    const paused = await call('PATCH', path, { enabled: false });
    assert.equal((paused.data as { enabled: boolean; title: string }).enabled, false);
    assert.equal((paused.data as { title: string }).title, '开周会', '没写的项不动');
    assert.equal(((await call('GET', '/api/alarms')).data as { enabled: boolean }[])[0]?.enabled, false);
    assert.equal(((await call('PATCH', path, { enabled: true })).data as { enabled: boolean }).enabled, true);
    // 改成一次性
    const once = await call('PATCH', path, { repeat: null, date: '2026-11-01' });
    assert.deepEqual(
      [
        (once.data as { repeat: null }).repeat,
        (once.data as { date: string }).date,
        (once.data as { weekday: null }).weekday,
      ],
      [null, '2026-11-01', null],
    );

    assert.deepEqual(await call('PATCH', path, { time: '25:00' }), {
      status: 400,
      data: { error: '时间要写成 HH:MM' },
    });
    assert.deepEqual(await call('PATCH', path, { title: '  ' }), { status: 400, data: { error: '日程要有标题' } });
    assert.deepEqual(await call('PATCH', path, { enabled: 'no' }), {
      status: 400,
      data: { error: 'enabled 只能是 true 或 false' },
    });
    assert.deepEqual(await call('PATCH', path, { weekday: '1' }), {
      status: 400,
      data: { error: 'weekday 要是一个数' },
    });
    assert.deepEqual(await call('PATCH', path, { kind: 'noise' }), {
      status: 400,
      data: { error: '类型只能是 alarm 或 task' },
    });
    assert.deepEqual(await call('PATCH', '/api/alarms/s_nope', { title: '喝水' }), {
      status: 404,
      data: { error: '没有这条日程' },
    });
    assert.equal(((await call('GET', '/api/alarms')).data as { time: string }[])[0]?.time, '10:30', '填错的没写进去');
    assert.deepEqual(
      repos.activity
        .list(20)
        .map((event) => event.type)
        .filter((type) => type.startsWith('schedule-'))
        .slice(-5),
      ['schedule-add', 'schedule-edit', 'schedule-pause', 'schedule-resume', 'schedule-edit'],
    );
    assert.equal((await call('DELETE', path)).status, 200);
  });

  test('设置表单：PATCH /api/config/fields 只改白名单里的项，密钥打码、不泄露也不被码盖掉', async () => {
    const read = (await call('GET', '/api/config')).data as {
      version: string;
      text: string;
      fields: Record<string, unknown>;
    };
    assert.equal(read.fields['llm.model'], 'demo');
    assert.equal(read.fields['llm.apiKey'], '••••••', '读出来是码');
    assert.equal(read.fields['speech.apiKey'], '', '没填的是空');
    assert.equal(read.fields['llm.provider'], 'openai-compatible', '没写的按缺省补齐');
    assert.ok(!JSON.stringify(read).includes('secret-key'));
    const before = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;

    const saved = await call('PATCH', '/api/config/fields', {
      fields: { 'llm.model': 'demo-2', 'llm.apiKey': '••••••', 'pace.options': [900, 300, 300, 1800] },
      version: read.version,
    });
    assert.deepEqual(saved, { status: 200, data: { saved: true } });
    const after = JSON.parse(readFileSync(paths.configFile, 'utf8')) as {
      llm: { apiKey: string; model: string };
      pace: { options: number[] };
    };
    assert.equal(after.llm.model, 'demo-2');
    assert.equal(after.llm.apiKey, 'secret-key', '码不当成新密钥');
    assert.deepEqual(after.pace.options, [300, 900, 1800]);
    assert.deepEqual({ ...after, llm: before['llm'], pace: undefined }, { ...before, pace: undefined });

    const stale = await call('PATCH', '/api/config/fields', { fields: { 'llm.model': 'x' }, version: read.version });
    assert.deepEqual(stale, { status: 409, data: { error: 'config.json 在别处改过了：刷新一下再改' } });
    assert.deepEqual(await call('PATCH', '/api/config/fields', { fields: { 'llm.model': 3 } }), {
      status: 400,
      data: { error: 'llm.model 要是一段文字' },
    });
    assert.equal((await call('PATCH', '/api/config/fields', { fields: { 'web.port': 1 } })).status, 400);
    assert.equal((await call('PATCH', '/api/config/fields', { fields: [] })).status, 400);
    assert.equal((await call('PATCH', '/api/config/fields', {})).status, 400);
    const events = repos.activity.list(20).filter((event) => event.type === 'config-fields');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.['text'], 'llm.model llm.apiKey pace.options', '只记改了哪几项，不记值');
  });

  test('子任务等回答：详情带问题，POST /api/tasks/:id/answer 回答以后排队接着做；不在等的、空回答、没有的都报清楚', async () => {
    const task = repos.agentTasks.create(
      { title: '做封面', goal: '做封面', criteria: [], agent: 'general', origin: 'main' },
      T0,
    );
    repos.agentTasks.update(task.id, { state: 'running', startedAt: T0 }, T0);
    assert.deepEqual(await call('POST', `/api/tasks/${task.id}/answer`, { answer: '蓝色' }), {
      status: 409,
      data: { error: `子任务 #${task.id} 现在是「在做」，没有在等回答` },
    });
    askTask(repos, task.id, '封面用蓝色还是绿色？', new Date(T0));
    const waiting = (await call('GET', `/api/tasks/${task.id}`)).data as {
      state: string;
      question: string;
      askedAt: number;
      answer: string | null;
    };
    assert.deepEqual(
      [waiting.state, waiting.question, waiting.askedAt, waiting.answer],
      ['waiting', '封面用蓝色还是绿色？', T0, null],
    );
    assert.equal(((await call('GET', '/api/tasks')).data as { state: string }[])[0]?.state, 'waiting');
    assert.deepEqual(await call('POST', `/api/tasks/${task.id}/answer`, {}), {
      status: 400,
      data: { error: '要给 answer，回答要是一段文字' },
    });
    assert.deepEqual(await call('POST', `/api/tasks/${task.id}/answer`, { answer: '  ' }), {
      status: 409,
      data: { error: '回答不能空着' },
    });
    assert.equal((await call('POST', '/api/tasks/99/answer', { answer: '蓝' })).status, 409);
    const answered = (await call('POST', `/api/tasks/${task.id}/answer`, { answer: '蓝色' })).data as {
      state: string;
    };
    assert.equal(answered.state, 'queued');
    assert.equal(repos.agentTasks.get(task.id)?.answer, '蓝色');
    assert.equal(
      (await call('POST', `/api/tasks/${task.id}/answer`, { answer: '蓝色' })).status,
      409,
      '答过了不能再答',
    );
  });

  test('子任务：列表、详情带一步步的过程、取消；主聊天里做完的那条带编号', async () => {
    const task = repos.agentTasks.create(
      { title: '整理周报', goal: '本周进展', criteria: ['三个项目都有'], agent: 'research', origin: 'main' },
      T0,
    );
    repos.agentTasks.update(
      task.id,
      {
        state: 'running',
        todos: [
          { text: '收集', state: 'done' },
          { text: '写', state: 'pending' },
        ],
      },
      T0,
    );
    await context.store.append(taskSession(task.id), [userEntry('子任务 #1：整理周报', { at: T0 })]);
    const list = (await call('GET', '/api/tasks')).data as { id: number; state: string; progress: unknown }[];
    assert.deepEqual(list[0], {
      id: task.id,
      title: '整理周报',
      agent: 'research',
      state: 'running',
      origin: 'main',
      createdAt: T0,
      finishedAt: null,
      progress: { done: 1, total: 2 },
    });
    const detail = (await call('GET', `/api/tasks/${task.id}`)).data as { goal: string; steps: unknown[] };
    assert.equal(detail.goal, '本周进展');
    assert.deepEqual(detail.steps, [{ at: T0, kind: 'input', text: '子任务 #1：整理周报' }]);
    assert.equal((await call('GET', '/api/tasks/99')).status, 404);
    assert.equal((await call('POST', `/api/tasks/${task.id}/cancel`, {})).status, 200);
    assert.deepEqual(await call('POST', `/api/tasks/${task.id}/cancel`, {}), {
      status: 409,
      data: { error: `子任务 #${task.id} 已经「取消了」` },
    });

    await context.append(
      eventEntry('task', {
        text: '子任务 #1「整理周报」取消了。',
        meta: { id: task.id, state: 'cancelled' },
        at: T0 + 10,
      }),
    );
    const items = (await call('GET', '/api/context')).data as {
      seq: number;
      kind: string;
      task?: number;
      state?: string;
    }[];
    const { seq, ...last } = items.at(-1)!;
    assert.ok(Number.isInteger(seq));
    assert.deepEqual(last, {
      at: T0 + 10,
      kind: 'task',
      text: '子任务 #1「整理周报」取消了。',
      task: task.id,
      state: 'cancelled',
    });
  });

  test('交付物：按子任务列；原文带对的类型，HTML 只给下载，都关在沙箱里；能在访达里显示、能删', async () => {
    const task = repos.agentTasks.create(
      { title: '出周报', goal: '本周进展', criteria: [], agent: 'writer', origin: 'main' },
      T0,
    );
    repos.agentTasks.update(task.id, { state: 'running' }, T0);
    const md = deliverArtifact(repos, files, { id: task.id, name: '周报.md', content: '# 周报' }, new Date(T0));
    const page = deliverArtifact(
      repos,
      files,
      { id: task.id, name: '页.html', content: '<script>1</script>' },
      new Date(T0 + 1),
    );
    const list = (await call('GET', `/api/artifacts?task=${task.id}`)).data as { name: string; view: string }[];
    assert.deepEqual(
      list.map((item) => [item.name, item.view]),
      [
        ['页.html', 'file'],
        ['周报.md', 'text'],
      ],
    );
    assert.deepEqual((await call('GET', '/api/artifacts?task=999')).data, []);

    const auth = { authorization: `Bearer ${web.token}` };
    const text = await raw(web, 'GET', `/api/artifacts/${md.id}`, { headers: auth });
    assert.equal(text.status, 200);
    assert.equal(text.body, '# 周报');
    assert.equal(text.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(text.headers['content-security-policy'], "sandbox; default-src 'none'");
    assert.equal(text.headers['x-content-type-options'], 'nosniff');
    assert.match(
      String(text.headers['content-disposition']),
      /^inline; filename="__\.md"; filename\*=UTF-8''%E5%91%A8%E6%8A%A5\.md$/,
    );
    const html = await raw(web, 'GET', `/api/artifacts/${page.id}`, { headers: auth });
    assert.match(String(html.headers['content-disposition']), /^attachment;/);
    assert.equal((await raw(web, 'GET', `/api/artifacts/${md.id}`)).status, 401, '原文也要令牌');
    assert.equal((await call('GET', '/api/artifacts/999')).status, 404);

    assert.deepEqual((await call('POST', `/api/artifacts/${md.id}/reveal`, {})).data, { revealed: md.id });
    assert.deepEqual(revealed, [files.path(task.id, '周报.md')]);
    assert.equal((await call('DELETE', `/api/artifacts/${md.id}`)).status, 200);
    assert.equal(files.read(task.id, '周报.md'), null);
    assert.equal((await call('DELETE', `/api/artifacts/${md.id}`)).status, 404);
    const status = (await call('GET', '/api/status')).data as { app: boolean; reveal: boolean };
    assert.deepEqual([status.app, status.reveal], [false, true]);
  });

  test('待批准：列表不带参数全文，详情带；批准、拒绝只能点一次，批准会叫常驻进程马上做；状态里有等批准的个数', async () => {
    const before = ((await call('GET', '/api/status')).data as { approvals: number }).approvals;
    const write = requestApproval(
      repos,
      {
        tool: 'write',
        summary: '写 notes/周报.md（新建，2 行，11 B）',
        input: { path: 'notes/周报.md', content: '# 周报\nA\n' },
        task: null,
      },
      new Date(T0),
    );
    const task = repos.agentTasks.create(
      { title: '画图', goal: '画图', criteria: [], agent: 'general', origin: 'main' },
      T0,
    );
    repos.agentTasks.update(task.id, { state: 'running', startedAt: T0 }, T0);
    const bash = requestApproval(
      repos,
      { tool: 'bash', summary: '跑命令：python plot.py', input: { command: 'python plot.py' }, task: task.id },
      new Date(T0 + 1),
    );
    askTask(repos, task.id, '想做下面这件事', new Date(T0));
    assert.equal(((await call('GET', '/api/status')).data as { approvals: number }).approvals, before + 2);

    const list = (await call('GET', '/api/approvals')).data as Record<string, unknown>[];
    assert.deepEqual(
      list
        .filter((item) => [write.id, bash.id].includes(item['id'] as number))
        .map((item) => [item['id'], item['state'], item['task'], 'input' in item]),
      [
        [bash.id, 'pending', task.id, false],
        [write.id, 'pending', null, false],
      ],
      '等批准的新的在前，列表里不带参数',
    );
    const detail = (await call('GET', `/api/approvals/${write.id}`)).data as Record<string, unknown>;
    assert.deepEqual(detail['input'], { path: 'notes/周报.md', content: '# 周报\nA\n' });
    assert.deepEqual(
      [detail['tool'], detail['summary'], detail['result']],
      ['write', '写 notes/周报.md（新建，2 行，11 B）', null],
    );
    assert.equal((await call('GET', '/api/approvals/999')).status, 404);
    const inTask = (await call('GET', `/api/tasks/${task.id}`)).data as { approvals: { id: number; state: string }[] };
    assert.deepEqual(
      inTask.approvals.map((item) => [item.id, item.state]),
      [[bash.id, 'pending']],
      '子任务详情带着它要批准的',
    );

    assert.equal((await call('POST', `/api/approvals/${write.id}/approve`, {})).status, 200);
    assert.deepEqual(approved, [write.id], '点了批准就叫一声');
    assert.equal(repos.approvals.get(write.id)?.state, 'approved');
    assert.deepEqual(await call('POST', `/api/approvals/${write.id}/deny`, {}), {
      status: 409,
      data: { error: `批准请求 #${write.id} 已经「批准了」，不能再改` },
    });
    assert.equal((await call('POST', `/api/approvals/${bash.id}/deny`, {})).status, 200);
    assert.deepEqual(approved, [write.id], '拒绝不叫');
    assert.equal((await call('POST', `/api/approvals/${bash.id}/approve`, {})).status, 409);
    assert.equal((await call('POST', '/api/approvals/999/approve', {})).status, 404);
    assert.deepEqual(
      repos.activity
        .list(50)
        .filter((e) => e.type === 'approval-approve' || e.type === 'approval-deny')
        .map((e) => [e.type, e['via']]),
      [
        ['approval-approve', 'web'],
        ['approval-deny', 'web'],
      ],
    );
    assert.equal(((await call('GET', '/api/status')).data as { approvals: number }).approvals, before);

    await context.append(
      eventEntry('approval', {
        text: '批准请求 #1「写 a.md」：主人在工作台里拒绝了，没有做。',
        meta: { id: 1, state: 'denied' },
        at: T0 + 20,
      }),
    );
    const items = (await call('GET', '/api/context')).data as {
      seq: number;
      kind: string;
      approval?: number;
      state?: string;
    }[];
    const { seq, ...last } = items.at(-1)!;
    assert.ok(Number.isInteger(seq));
    assert.deepEqual(last, {
      at: T0 + 20,
      kind: 'approval',
      text: '批准请求 #1「写 a.md」：主人在工作台里拒绝了，没有做。',
      approval: 1,
      state: 'denied',
    });
  });

  test('说一句、听一句交给收件箱，下一拍做', async () => {
    assert.equal((await call('POST', '/api/actions/whisper', {})).status, 200);
    assert.equal((await call('POST', '/api/actions/listen', {})).status, 200);
    assert.deepEqual(
      drain(paths.inboxFile).map((message) => message.type),
      ['whisper', 'listen'],
    );
  });

  const open = (path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<Response> =>
    fetch(new URL(path, web.origin), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${init.token ?? web.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  test('流式聊天：delta 一小段一小段来，最后 done 带整段回复，和 POST /api/chat 交回的一样', async () => {
    const response = await open('/api/chat/stream', { method: 'POST', body: { text: '  在吗 ' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const events = await readSse(response);
    // 假的 talk 先吐一个换行，再一个字一个字吐 `收到：在吗`
    assert.deepEqual(
      events.map((event) => event.event),
      ['delta', 'delta', 'delta', 'delta', 'delta', 'delta', 'done'],
    );
    const text = events
      .filter((event) => event.event === 'delta')
      .map((event) => (event.data as { text: string }).text)
      .join('');
    assert.equal(text, '\n收到：在吗', '增量是模型原文，还没去首尾空白');
    const done = events.at(-1)?.data as { reply: string };
    assert.deepEqual(done, { reply: '收到：在吗' });
    assert.deepEqual(await call('POST', '/api/chat', { text: '在吗' }), { status: 200, data: done });
  });

  test('流式聊天没回上来：error 事件带原因，没有 done', async () => {
    const events = await readSse(await open('/api/chat/stream', { method: 'POST', body: { text: '坏了' } }));
    assert.deepEqual(events, [{ event: 'error', data: { error: 'yoyo 没回上来：没配 llm，回不了话' } }]);
  });

  test('流式聊天的门槛和别的接口一样：令牌、Host、Origin、只收 JSON；空的、太长的开流之前就拒绝', async () => {
    assert.equal(
      (await open('/api/chat/stream', { method: 'POST', body: { text: '在吗' }, token: 'bad' })).status,
      401,
    );
    const json = { 'content-type': 'application/json', authorization: `Bearer ${web.token}` };
    const body = JSON.stringify({ text: '在吗' });
    const evil = await raw(web, 'POST', '/api/chat/stream', {
      headers: { ...json, origin: 'http://evil.example' },
      body,
    });
    assert.equal(evil.status, 403);
    const host = await raw(web, 'POST', '/api/chat/stream', { headers: { ...json, host: 'evil.example' }, body });
    assert.equal(host.status, 403);
    const form = await raw(web, 'POST', '/api/chat/stream', {
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${web.token}` },
      body,
    });
    assert.equal(form.status, 415);
    const empty = await open('/api/chat/stream', { method: 'POST', body: { text: ' ' } });
    assert.equal(empty.status, 400);
    assert.match(empty.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await empty.json(), { error: '要说点什么' });
    assert.equal((await open('/api/chat/stream', { method: 'POST', body: { text: '长'.repeat(4001) } })).status, 400);
  });

  test('子任务过程用 SSE 推：开头一份，有新的一步或状态变了才再推，结束推最后一份再 end；没有的 404、没令牌 401', async () => {
    const task = repos.agentTasks.create(
      { title: '整理周报', goal: '本周进展', criteria: [], agent: 'general', origin: 'web' },
      T0,
    );
    repos.agentTasks.update(task.id, { state: 'running' }, T0 + 1);
    const response = await open(`/api/tasks/${task.id}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const stream = collectSse(response);
    const taskAt = (n: number) =>
      (stream.events[n] as SseEvent).data as { task: { steps: unknown[]; progress: unknown; state: string } };
    const steps = () => taskAt(stream.events.length - 1).task.steps.length;

    await waitFor(() => stream.events.length === 1);
    const first = stream.events[0]?.data as {
      task: { id: number; state: string; progress: unknown };
      artifacts: unknown[];
    };
    assert.equal(stream.events[0]?.event, 'task');
    assert.equal(first.task.id, task.id);
    assert.equal(first.task.state, 'running');
    assert.deepEqual(first.artifacts, []);
    assert.equal(steps(), 0);
    await sleep(100);
    assert.equal(stream.events.length, 1, '没有新的就不推');

    await context.store.append(taskSession(task.id), [assistantEntry('先拆 todo', { at: T0 + 2 })]);
    await waitFor(() => stream.events.length === 2);
    assert.equal(steps(), 1);

    repos.agentTasks.update(task.id, { todos: [{ text: '收集材料', state: 'done' }] }, T0 + 3);
    await waitFor(() => stream.events.length === 3);
    assert.deepEqual(taskAt(2).task.progress, { done: 1, total: 1 });

    repos.agentTasks.update(task.id, { state: 'done', result: '写好了', finishedAt: T0 + 4 }, T0 + 4);
    await stream.done;
    assert.deepEqual(
      stream.events.map((event) => event.event),
      ['task', 'task', 'task', 'task', 'end'],
    );
    assert.equal(taskAt(3).task.state, 'done');

    // 已经结束的：一份加 end，流就关了
    const finished = await readSse(await open(`/api/tasks/${task.id}/events`));
    assert.deepEqual(
      finished.map((event) => event.event),
      ['task', 'end'],
    );
    assert.equal((await open('/api/tasks/9999/events')).status, 404);
    assert.equal((await open(`/api/tasks/${task.id}/events`, { token: 'bad' })).status, 401);
  });

  test('客户端自己断开：服务端不再推，也不出错', async () => {
    const task = repos.agentTasks.create(
      { title: '慢慢做', goal: '目标', criteria: [], agent: 'general', origin: 'web' },
      T0,
    );
    repos.agentTasks.update(task.id, { state: 'running' }, T0 + 1);
    const stream = collectSse(await open(`/api/tasks/${task.id}/events`));
    await waitFor(() => stream.events.length === 1);
    await stream.stop();
    await stream.done.catch(() => {});
    repos.agentTasks.update(task.id, { state: 'cancelled', finishedAt: T0 + 2 }, T0 + 2);
    await sleep(80);
    assert.equal(stream.events.length, 1);
    assert.deepEqual(
      logger.lines.filter((line) => line.includes('管理页')),
      [],
    );
    // 服务还能正常回别的请求
    assert.equal((await call('GET', '/api/status')).status, 200);
  });

  test('派子任务：GET /api/agents 列类型；POST /api/tasks 规则同主线程，来源是 web，建好回概要', async () => {
    const agents = (await call('GET', '/api/agents')).data as { name: string; description: string }[];
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ['general', 'research', 'writer'],
    );
    assert.match(agents[1]?.description ?? '', /上网查/);
    assert.deepEqual(Object.keys(agents[0] ?? {}).toSorted(), ['description', 'name'], '不带指令和工具清单');

    const made = await call('POST', '/api/tasks', {
      title: ' 查机票 ',
      goal: '查下周一到周三北京到上海的机票',
      criteria: ['给出三个航班', '  ', '写明价格'],
      agent: 'research',
    });
    assert.equal(made.status, 200);
    const task = made.data as { id: number; title: string; agent: string; state: string; origin: string };
    assert.deepEqual([task.title, task.agent, task.state, task.origin], ['查机票', 'research', 'queued', 'web']);
    const stored = repos.agentTasks.get(task.id);
    assert.deepEqual(stored?.criteria, ['给出三个航班', '写明价格']);
    assert.ok(
      repos.activity
        .list(50)
        .some((event) => event.type === 'task-add' && event.id === task.id && event.origin === 'web'),
    );

    // 验收标准也收整段文字，按行拆；类型不写是 general
    const text = (await call('POST', '/api/tasks', { title: '整理', goal: '整理桌面', criteria: '第一条\r\n第二条' }))
      .data as {
      id: number;
      agent: string;
    };
    assert.equal(text.agent, 'general');
    assert.deepEqual(repos.agentTasks.get(text.id)?.criteria, ['第一条', '第二条']);
  });

  test('派子任务的校验：标题和目标要有、太长不行、验收标准最多 8 条、没有这种类型，都回 400 说清楚，没建', async () => {
    const before = repos.agentTasks.list({ limit: 200 }).length;
    assert.equal(await badRequest(call, { goal: '做点事' }), '标题不能空着');
    assert.equal(await badRequest(call, { title: ' ', goal: '做点事' }), '标题不能空着');
    assert.equal(await badRequest(call, { title: '做事' }), '目标不能空着');
    assert.match(await badRequest(call, { title: '长'.repeat(61), goal: '做点事' }), /标题太长了，最多 60 字/);
    assert.match(await badRequest(call, { title: '做事', goal: '长'.repeat(4001) }), /目标太长了，最多 4000 字/);
    assert.match(
      await badRequest(call, { title: '做事', goal: '做', criteria: Array(9).fill('一条') }),
      /验收标准最多 8 条/,
    );
    assert.equal(
      await badRequest(call, { title: '做事', goal: '做', agent: 'ghost' }),
      '没有「ghost」这种子 agent，有：general、research、writer',
    );
    assert.equal(repos.agentTasks.list({ limit: 200 }).length, before);
    assert.equal(
      (await raw(web, 'POST', '/api/tasks', { headers: { authorization: `Bearer ${web.token}` }, body: '{}' })).status,
      415,
    );
  });
});

const said = (n: number): string => `第${n}句`;

describe('web 管理页：没开子任务、往前翻', () => {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-web-'));
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  const servers: WebServer[] = [];

  /** 一个自己的日志和上下文的服务；`agents` 不给就是子任务没打开。 */
  async function serve(options: { agents?: ReturnType<typeof mergeAgents> } = {}) {
    const repos = memoryRepos({ now: () => new Date(T0) });
    const context: Context = createContext({
      store: createMemoryStore(),
      session: sessionFor('main'),
      projection: yoyoProjection,
    });
    const web = await startWeb({
      config: parseConfig({}),
      paths,
      repos,
      context,
      memory: createMemory(),
      host: { name: 'console', workStatus: async () => ({ state: 'idle', task: null }) },
      ...(options.agents ? { agents: options.agents } : {}),
    });
    servers.push(web);
    const call = async (path: string, body?: unknown): Promise<{ status: number; data: unknown }> => {
      const response = await fetch(new URL(path, web.origin), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${web.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    return { context, repos, call };
  }

  afterAll(async () => {
    await Promise.all(servers.map((web) => web.close()));
  });

  interface Item {
    readonly at: number;
    readonly seq: number;
    readonly kind: string;
    readonly text: string;
  }
  const cursor = (item: Item | undefined): string => `${item?.at}:${item?.seq}`;
  const texts = (items: unknown): string[] => (items as Item[]).map((item) => item.text);

  test('子任务没打开（没给类型）：类型清单是空的，派不了，回 409 说怎么开', async () => {
    const { call } = await serve();
    assert.deepEqual(await call('/api/agents'), { status: 200, data: [] });
    assert.deepEqual(await call('/api/tasks', { title: '做事', goal: '做' }), {
      status: 409,
      data: { error: '子任务没打开：config.json 里把 tasks.enabled 设成 true' },
    });
  });

  test('往前翻：游标是页上最早那条的 at:seq，一页一页接上，不重不漏；不满一页就是到头了', async () => {
    const { context, call } = await serve();
    // 130 句，之后再导入一条很久以前的桌宠对话：序号最大，但 at 最早，排在最前
    await context.append(...Array.from({ length: 130 }, (_, n) => userEntry(said(n), { at: T0 + n * 1000 })));
    await context.append(...petChatEntries([{ role: 'user', content: '很久以前', ts: T0 - 1_000_000 }]));

    const latest = (await call('/api/context?limit=50')).data as Item[];
    assert.deepEqual(
      texts(latest),
      Array.from({ length: 50 }, (_, n) => said(80 + n)),
    );
    const second = (await call(`/api/context?limit=50&before=${cursor(latest[0])}`)).data as Item[];
    assert.deepEqual(
      texts(second),
      Array.from({ length: 50 }, (_, n) => said(30 + n)),
    );
    const third = (await call(`/api/context?limit=50&before=${cursor(second[0])}`)).data as Item[];
    assert.deepEqual(texts(third), ['很久以前', ...Array.from({ length: 30 }, (_, n) => said(n))]);
    assert.ok(third.length < 50, '不满一页：到头了');
    assert.deepEqual((await call(`/api/context?limit=50&before=${cursor(third[0])}`)).data, [], '再往前没有了');

    // 没给 limit 是 40 条，最多 200 条
    assert.equal(((await call(`/api/context?before=${cursor(latest[0])}`)).data as Item[]).length, 40);
    await context.append(
      ...Array.from({ length: 100 }, (_, n) => userEntry(said(130 + n), { at: T0 + (130 + n) * 1000 })),
    );
    assert.equal(((await call('/api/context?limit=1000')).data as Item[]).length, 200);
  });

  test('游标按 (at, seq)：同一时刻的几条，从中间翻只拿排在前面的', async () => {
    const { context, call } = await serve();
    await context.append(
      userEntry('甲', { at: T0 + 5000 }),
      userEntry('乙', { at: T0 + 5000 }),
      userEntry('丙', { at: T0 + 5000 }),
      userEntry('更早', { at: T0 }),
      userEntry('更晚', { at: T0 + 9000 }),
    );
    const all = (await call('/api/context?limit=10')).data as Item[];
    assert.deepEqual(texts(all), ['更早', '甲', '乙', '丙', '更晚']);
    const middle = all[2];
    assert.deepEqual(texts((await call(`/api/context?limit=10&before=${cursor(middle)}`)).data), ['更早', '甲']);
    // 游标可以是任意时刻，不必是某一条
    assert.deepEqual(texts((await call(`/api/context?limit=10&before=${T0 + 1}:0`)).data), ['更早']);
    assert.deepEqual((await call(`/api/context?limit=10&before=${T0}:0`)).data, []);
  });

  test('翻页的游标写错回 400；日志末尾全是不显示的条目时，取最新一页也能往里找', async () => {
    const { context, call } = await serve();
    for (const before of ['abc', '12', '1:', ':2', '1:2:3', '-1:x']) {
      assert.deepEqual(await call(`/api/context?before=${before}`), {
        status: 400,
        data: { error: 'before 要写成 <at>:<seq>' },
      });
    }
    await context.append(userEntry('很久以前的一句', { at: T0 }), assistantEntry('回你', { at: T0 + 1 }));
    // 600 条不显示的事件把它们挤出末尾 500 条
    await context.append(...Array.from({ length: 600 }, (_, n) => eventEntry('noise', { at: T0 + 2 + n })));
    assert.deepEqual(texts((await call('/api/context?limit=5')).data), ['很久以前的一句', '回你']);
  });

  test('小卡片可以按类型和时间取：往前翻时取更早的', async () => {
    const { repos, call } = await serve();
    // 测试用的库里每条记录的时间都是 T0，这里只验类型筛和 limit、before 参数传到了
    repos.activity.record({ type: 'whisper' });
    repos.activity.record({ type: 'task-add', id: 1, title: '甲' });
    repos.activity.record({ type: 'schedule-add', title: '喝水' });
    const cards = (await call('/api/activity?limit=200&types=schedule-add,task-add,approval-ask')).data as {
      type: string;
    }[];
    assert.deepEqual(
      cards.map((card) => card.type),
      ['task-add', 'schedule-add'],
    );
    assert.deepEqual(
      (await call(`/api/activity?types=task-add&before=${encodeURIComponent(new Date(T0).toISOString())}`)).data,
      [],
    );
    const after = new Date(T0 + 1000).toISOString();
    assert.equal(
      ((await call(`/api/activity?types=task-add&before=${encodeURIComponent(after)}`)).data as unknown[]).length,
      1,
    );
  });
});
