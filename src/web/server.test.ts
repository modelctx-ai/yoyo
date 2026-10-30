import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, eventEntry, userEntry, type MemoryStore } from '@modelctx-ai/ctx';
import { createMemoryStore as createMemory } from '@modelctx-ai/ctx-memory';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { petChatEntries, sessionFor, taskSession, yoyoProjection } from '../brain/context.ts';
import { deliverArtifact } from '../features/tasks/artifacts.ts';
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
  let web: WebServer;
  const files = createArtifactFiles(paths.artifactsDir);
  const revealed: string[] = [];

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
      schedule: () => ({ nextWhisper: T0 + 60_000, lastTalk: 0 }),
      talk: async (text) => {
        if (text === '坏了') throw new Error('没配 llm，回不了话');
        return `收到：${text}`;
      },
      now: () => new Date(T0),
      files,
      reveal: (path) => void revealed.push(path),
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
    const items = (await call('GET', '/api/context')).data as { kind: string; task?: number; state?: string }[];
    assert.deepEqual(items.at(-1), {
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

  test('说一句、听一句交给收件箱，下一拍做', async () => {
    assert.equal((await call('POST', '/api/actions/whisper', {})).status, 200);
    assert.equal((await call('POST', '/api/actions/listen', {})).status, 200);
    assert.deepEqual(
      drain(paths.inboxFile).map((message) => message.type),
      ['whisper', 'listen'],
    );
  });
});
