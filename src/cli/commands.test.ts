import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { assistantEntry, eventEntry, userEntry } from '@modelctx-ai/ctx';

import type { AppOverrides } from '../app/container.ts';
import { resolvePaths, type Paths } from '../app/paths.ts';
import type { UpdateSystem } from '../app/update.ts';
import { createYoyoContext, taskSession } from '../brain/context.ts';
import { openMemoryStore } from '../brain/memory.ts';
import { requestApproval } from '../features/approvals/approvals.ts';
import { deliverArtifact } from '../features/tasks/artifacts.ts';
import { askTask } from '../features/tasks/tasks.ts';
import { localDateKey } from '../kernel/time.ts';
import { directorAlive, drain, writePid } from '../runtime/inbox.ts';
import {
  fakeHost,
  fakePlayer,
  fakeSearch,
  fakeSfx,
  fakeSynthesizer,
  memoryLogger,
  type MemoryLogger,
} from '../runtime/testing.ts';
import { buildDomains, createCommandEnv, type CommandEnv } from './commands.ts';
import { agentDomains, dispatch } from './registry.ts';

const NOW = new Date(2026, 9, 24, 15, 0, 0);

interface Cli {
  readonly env: CommandEnv;
  readonly paths: Paths;
  readonly lines: string[];
  readonly logger: MemoryLogger;
  /** 跑一条命令，返回这条命令打印的行。 */
  readonly run: (...argv: string[]) => Promise<string[]>;
}

function cli(
  options: {
    readonly config?: unknown;
    readonly overrides?: AppOverrides;
    readonly updater?: UpdateSystem;
    readonly installed?: string | null;
    readonly app?: string;
    /** 当成包在这里（里面有 `lib/swap.sh`）。 */
    readonly root?: string;
  } = {},
): Cli {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const paths: Paths = {
    ...resolvePaths({
      YOYO_HOME: home,
      YOYO_CONFIG: join(home, 'config.json'),
      ...(options.app ? { YOYO_APP: options.app } : {}),
    }),
    ...(options.root ? { root: options.root } : {}),
  };
  if (options.config !== undefined) writeFileSync(paths.configFile, JSON.stringify(options.config));
  const lines: string[] = [];
  const logger = memoryLogger();
  const env = createCommandEnv(paths, {
    out: (text) => void lines.push(text),
    logger,
    now: () => NOW,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.updater ? { updater: options.updater } : {}),
    ...(options.installed !== undefined ? { installed: options.installed } : {}),
  });
  const domains = buildDomains(env);
  return {
    env,
    paths,
    lines,
    logger,
    run: async (...argv) => {
      const start = lines.length;
      const result = dispatch(domains, argv);
      if (result.kind === 'text') lines.push(result.text);
      else await result.verb.run(result.flags, result.args);
      return lines.slice(start);
    },
  };
}

/** 能直接当导演跑的配置：控制台舞台，语音配齐，没有模型。 */
const CONSOLE_CONFIG = { stage: 'console', speech: { apiKey: 'fish-key', referenceId: 'ref' } };

function quietServices(calls: string[]): AppOverrides {
  return { synthesizer: fakeSynthesizer(calls), player: fakePlayer(calls), sfx: fakeSfx(calls) };
}

describe('commands', () => {
  test('日程：加一条再列出来，格式和以前一样；没有 config.json 也能用', async () => {
    const { run } = cli();
    assert.deepEqual(await run('alarm', 'list'), ['还没有日程']);
    assert.deepEqual(await run('alarm', 'add', '--title', '喝水', '--time', '15:30', '--repeat', 'daily'), [
      'alarm\t15:30\t喝水',
    ]);
    assert.deepEqual(
      await run('alarm', 'add', '--title', '开会', '--time', '09:30', '--date', '2026-10-26', '--kind', 'task'),
      ['task\t09:30\t开会'],
    );
    const rows = await run('alarm', 'list');
    assert.match(rows[0] ?? '', /^task\t09:30\t2026-10-26\t开会\ts_\w+$/);
    assert.match(rows[1] ?? '', /^alarm\t15:30\tdaily\t喝水\ts_\w+$/);
    await assert.rejects(run('alarm', 'add', '--time', '15:30', '--repeat', 'daily'), /日程要有标题/);
    await assert.rejects(run('alarm', 'add', '--title', '周会', '--time', '10:00', '--repeat', 'weekly'), /weekday/);
  });

  test('日程：edit 只改写了的项，pause 和 resume 暂停恢复，list 标出暂停中', async () => {
    const { run } = cli();
    await run('alarm', 'add', '--title', '喝水', '--time', '15:30', '--repeat', 'daily');
    const id = (await run('alarm', 'list'))[0]!.split('\t')[4]!;
    assert.deepEqual(await run('alarm', 'edit', id, '--title', '喝温水', '--time', '16:00'), ['alarm\t16:00\t喝温水']);
    assert.deepEqual(await run('alarm', 'edit', id, '--repeat', 'weekly', '--weekday', '5'), ['alarm\t16:00\t喝温水']);
    assert.deepEqual(await run('alarm', 'edit', id, '--repeat', 'none', '--date', '2026-11-01', '--kind', 'task'), [
      'task\t16:00\t喝温水',
    ]);
    assert.deepEqual(await run('alarm', 'list'), [`task\t16:00\t2026-11-01\t喝温水\t${id}`]);

    assert.deepEqual(await run('alarm', 'pause', id), [`已暂停\t喝温水\t${id}`]);
    assert.deepEqual(await run('alarm', 'list'), [`task\t16:00\t2026-11-01\t喝温水\t${id}\t暂停中`]);
    assert.deepEqual(await run('alarm', 'resume', id), [`已恢复\t喝温水\t${id}`]);
    assert.deepEqual(await run('alarm', 'list'), [`task\t16:00\t2026-11-01\t喝温水\t${id}`]);

    await assert.rejects(run('alarm', 'edit', id, '--time', '3点'), /时间要写成 HH:MM/);
    await assert.rejects(run('alarm', 'edit', id, '--repeat', 'none', '--date', ''), /一次性日程要有日期/);
    await assert.rejects(run('alarm', 'edit', 's_nope', '--title', '喝水'), /没有这条日程：s_nope/);
    await assert.rejects(run('alarm', 'pause', 's_nope'), /没有这条日程：s_nope/);
    await assert.rejects(run('alarm', 'resume'), /要给日程编号/);
    const types = (await run('log', 'tail')).map((row) => row.split('\t')[1]);
    assert.deepEqual(types.slice(-6), [
      'schedule-add',
      'schedule-edit',
      'schedule-edit',
      'schedule-edit',
      'schedule-pause',
      'schedule-resume',
    ]);
  });

  test('联系人：contract 也能用；log tail 记着做过的事', async () => {
    const { run } = cli();
    assert.deepEqual(await run('contact', 'list'), ['还没有联系人']);
    assert.deepEqual(await run('log', 'tail'), ['还没有记录']);
    assert.deepEqual(
      await run('contract', 'add', '--name', '小王', '--yoyo', 'yoyo://xiaowang@example', '--note', '同事'),
      ['小王\tyoyo://xiaowang@example'],
    );
    assert.deepEqual(await run('contact', 'list'), ['小王\tyoyo://xiaowang@example\t同事']);
    const log = await run('log', 'tail');
    assert.equal(log.length, 1);
    assert.match(log[0] ?? '', /^\d{4}-\d{2}-\d{2}T[^\t]+\tcontact-add$/);
  });

  test('粘贴板：get 读当前内容，history 是 yoyo 记下的变化', async () => {
    let text = '  复制的一段话  ';
    const { run, env } = cli({ overrides: { clipboard: { read: () => text } } });
    assert.deepEqual(await run('clip', 'get'), ['复制的一段话']);
    text = '';
    assert.deepEqual(await run('clip', 'get'), ['粘贴板是空的']);
    assert.deepEqual(await run('clip', 'history'), ['还没有复制记录']);
    env.repos().clipboard.insert({ text: '第一行\n第二行', at: '2026-10-24T07:00:00.000Z' });
    assert.deepEqual(await run('clip', 'history'), ['2026-10-24T07:00:00.000Z\t第一行 第二行']);
  });

  test('表情包：list 看现在这套；refresh 现在就搜一套', async () => {
    const calls: string[] = [];
    const found = '看 https://example.com/a.png 和 https://example.com/b.gif';
    const { run, env } = cli({
      config: CONSOLE_CONFIG,
      overrides: { ...quietServices(calls), search: fakeSearch(calls, found) },
    });
    assert.deepEqual(await run('meme', 'list'), ['还没有表情包']);
    assert.deepEqual(await run('meme', 'refresh'), ['2张']);
    assert.deepEqual(calls, ['search:可爱表情包 png']);
    assert.deepEqual(await run('meme', 'list'), [
      `${NOW.toISOString()}\t2张`,
      'https://example.com/a.png',
      'https://example.com/b.gif',
    ]);
    assert.equal(env.repos().activity.list(5).at(-1)?.type, 'meme-pack');
  });

  test('context tail 只列消息和碎碎念的最后 12 条', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('context', 'tail'), ['还没有上下文']);
    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(eventEntry('whisper', { text: '最早的碎碎念', at: 1 }));
    for (let i = 0; i < 6; i += 1) {
      await context.append(
        userEntry(`第 ${i} 句\n换行`, { at: 10 + i * 2 }),
        assistantEntry(`回 ${i}`, { at: 11 + i * 2 }),
      );
    }
    await context.append(
      eventEntry('meme-pack', { text: '不列', at: 100 }),
      // 框架事件也不列
      eventEntry('ctx.compacted', { text: '不列', at: 100 }),
      eventEntry('whisper', { text: '最后一句', at: 101 }),
    );
    const rows = await run('context', 'tail');
    assert.equal(rows.length, 12);
    assert.equal(rows[0], 'assistant\t回 0');
    assert.equal(rows[1], 'user\t第 1 句 换行');
    assert.equal(rows.at(-1), 'whisper\t最后一句');
    assert.equal(rows.includes('meme-pack\t不列'), false);
    assert.equal(rows.includes('ctx.compacted\t不列'), false);
  });

  test('context tail 按时间排：后写进来的旧对话（桌宠对话导入）排回原来的位置', async () => {
    const { run, env } = cli();
    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(userEntry('现在说的', { at: 100 }), assistantEntry('现在回的', { at: 101 }));
    await context.append(userEntry('导入的旧话', { at: 10, key: 'pet:10:user:导入的旧话' }));
    assert.deepEqual(await run('context', 'tail'), ['user\t导入的旧话', 'user\t现在说的', 'assistant\t现在回的']);
  });

  test('context compact：没配模型就说一句', async () => {
    const { run } = cli({ config: {} });
    assert.deepEqual(await run('context', 'compact'), ['还没配好 llm，压缩要用模型']);
  });

  test('memory core：没有画像就说一句；有就打印更新时间和画像，不要 config.json', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('memory', 'core'), ['还没有画像']);
    await openMemoryStore(env.db()).core.set('主人叫小王，最近在写 yoyo。', NOW.getTime());
    assert.deepEqual(await run('memory', 'core'), [`更新于 ${NOW.toISOString()}`, '主人叫小王，最近在写 yoyo。']);
  });

  test('memory facts、history、forget：只读写本地库；history 列原文和取代关系', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('memory', 'facts'), ['还没有记住的事']);
    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(userEntry('我在做项目 X', { at: NOW.getTime() - 86_400_000 }));
    await context.append(assistantEntry('傍晚有雨', { at: NOW.getTime() - 86_400_000, meta: { kind: 'weather' } }));
    await context.append(assistantEntry('好，项目 X', { at: NOW.getTime() - 86_400_000 }));
    await context.append(userEntry('我换到项目 Y 了', { at: NOW.getTime() }));
    const store = openMemoryStore(env.db());
    const base = { subject: 'user', topic: 'work', confidence: 0.9, salience: 0.8 } as const;
    const x = await store.facts.add({
      ...base,
      text: '主人在做项目 X',
      validFrom: NOW.getTime() - 86_400_000,
      sources: [{ session: 'pet:main', from: 1, upTo: 3 }],
    });
    const y = await store.facts.add({
      ...base,
      text: '主人在做项目 Y',
      validFrom: NOW.getTime(),
      sources: [{ session: 'pet:main', from: 4, upTo: 4 }],
    });
    await store.facts.close(x.id, NOW.getTime(), { supersededBy: y.id });
    const cat = await store.facts.add({
      ...base,
      topic: 'taste',
      text: '主人喜欢猫的表情包',
      validFrom: NOW.getTime() - 3 * 86_400_000,
      sources: [{ session: 'pet:main', from: 1, upTo: 1 }],
    });
    await store.facts.touch([cat.id], NOW.getTime());

    assert.deepEqual(await run('memory', 'facts'), [
      `${cat.id}\ttaste\t主人喜欢猫的表情包\t2026-10-21 起\t召回 1 次`,
      `${y.id}\twork\t主人在做项目 Y\t2026-10-24 起\t召回 0 次`,
    ]);
    assert.deepEqual(await run('memory', 'facts', '--topic', 'work'), [
      `${y.id}\twork\t主人在做项目 Y\t2026-10-24 起\t召回 0 次`,
    ]);
    assert.deepEqual(await run('memory', 'facts', '--topic', 'people'), ['主题 people 下还没有记住的事']);

    assert.deepEqual(await run('memory', 'history', y.id), [
      `${y.id}\twork\t主人在做项目 Y`,
      '成立：2026-10-24 起',
      `取代了：${x.id}\t主人在做项目 X`,
      '原文：',
      'pet:main#4\tuser\t我换到项目 Y 了',
    ]);
    assert.deepEqual(await run('memory', 'history', x.id), [
      `${x.id}\twork\t主人在做项目 X`,
      '成立：2026-10-23 起，到 2026-10-24',
      `被取代：${y.id}\t主人在做项目 Y`,
      '原文：',
      'pet:main#1\tuser\t我在做项目 X',
      'pet:main#3\tassistant\t好，项目 X',
    ]);
    assert.deepEqual(await run('memory', 'history'), ['要给事实的 id：yoyo memory history <id>']);
    assert.deepEqual(await run('memory', 'history', 'nope'), ['没有这条事实：nope']);

    assert.deepEqual(await run('memory', 'forget', cat.id), [`忘掉了 ${cat.id}，下一次整理时画像跟着改`]);
    assert.deepEqual(await run('memory', 'forget', cat.id), [`没有这条事实或程序：${cat.id}`]);
    assert.equal(
      (await store.facts.list()).some((fact) => fact.id === cat.id),
      false,
      '真删除，不是归档',
    );
    const forgot = env.repos().activity.list(5).at(-1);
    assert.deepEqual([forgot?.type, forgot?.['id'], forgot?.text], ['memory-forget', cat.id, undefined]);
  });

  test('memory consolidate：不用模型，只做衰减和画像的缺省渲染，笔记留给常驻进程', async () => {
    const { run, env } = cli({
      config: { llm: { apiKey: 'sk-unused', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' } },
    });
    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(userEntry('记住，我不喜欢狗的表情包', { at: NOW.getTime() }));
    const store = openMemoryStore(env.db());
    await store.notes.add([{ session: 'pet:main', from: 1, upTo: 1, at: NOW.getTime(), salience: 0.9 }]);
    await store.facts.add({
      subject: 'user',
      text: '主人在台北',
      topic: 'routine',
      validFrom: NOW.getTime(),
      confidence: 0.9,
      salience: 0.8,
      sources: [{ session: 'pet:main', from: 1, upTo: 1 }],
    });
    assert.deepEqual(await run('memory', 'consolidate'), [
      '整理了 0 条笔记：新增 0 条事实，并入 0，取代 0，归档 0；程序新增 0，确认 0；画像重写了',
      '还有 1 条笔记要用模型提取，留给常驻进程夜里整理',
    ]);
    assert.match((await run('memory', 'core')).join('\n'), /主人在台北/);
    assert.equal(env.repos().activity.list(5).at(-1)?.type, 'memory-consolidate');
  });

  test('memory rules、tail：生效的程序和最近的笔记', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('memory', 'rules'), ['还没有程序']);
    assert.deepEqual(await run('memory', 'tail'), ['还没有笔记']);
    const store = openMemoryStore(env.db());
    const evidence = [{ session: 'pet:main', from: 1, upTo: 1 }];
    const once = await store.procedures.add({ topic: 'fix', when: '报天气', do: '用摄氏度', evidence, at: 1 });
    const twice = await store.procedures.add({ topic: 'fix', when: '称呼主人', do: '别叫老板', evidence, at: 2 });
    await store.procedures.confirm(twice.id, [{ session: 'pet:main', from: 2, upTo: 2 }]);
    const retired = await store.procedures.add({ when: '早上', do: '先报天气', evidence, at: 3 });
    await store.procedures.retire(retired.id, 4);
    assert.deepEqual(await run('memory', 'rules'), [
      `${once.id}\tfix\t报天气 → 用摄氏度\t确认 1 次\t待确认`,
      `${twice.id}\tfix\t称呼主人 → 别叫老板\t确认 2 次\t生效`,
    ]);

    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(assistantEntry('傍晚有雨', { at: 1, meta: { kind: 'weather' } }));
    await context.append(userEntry('别叫我老板', { at: 2 }));
    await context.append(userEntry('今天好累', { at: 3 }));
    const at = NOW.getTime();
    await store.notes.add([
      { session: 'pet:main', from: 1, upTo: 2, at, salience: 0.82, kind: 'fail', topic: 'fix' },
      { session: 'pet:main', from: 3, upTo: 3, at, salience: 0.31, settledAt: at },
    ]);
    const [first] = await store.notes.list();
    await store.notes.add([{ session: 'pet:main', from: 3, upTo: 3, at: at + 1, salience: 0.7, topic: 'owner' }]);
    await store.notes.settle([(await store.notes.list()).at(-1)!.id], at + 2);
    assert.equal(first?.settledAt, undefined);
    const iso = NOW.toISOString();
    assert.deepEqual(await run('memory', 'tail'), [
      `${iso}\tpet:main#1-2\t0.82\tfix\tfail\t待整理\t别叫我老板`,
      `${iso}\tpet:main#3-3\t0.31\t-\t-\t不记\t今天好累`,
      `${new Date(at + 1).toISOString()}\tpet:main#3-3\t0.70\towner\t-\t已整理\t今天好累`,
    ]);
  });

  test('chat sync：导演没在跑就提示；在跑就用记下的渠道接上', async () => {
    const calls: string[] = [];
    const { run, env, paths } = cli({
      config: { llm: { baseUrl: 'https://llm.example/v1', apiKey: 'llm-key', model: 'mock-model' } },
      overrides: { host: fakeHost(calls) },
    });
    assert.deepEqual(await run('chat', 'sync'), ['导演没在跑，上下文代理还没起来']);
    env.repos().kv.set('channel-base', 'http://127.0.0.1:4567/v1');
    env.repos().kv.set('channel-token', 'local-token');
    assert.deepEqual(await run('chat', 'sync'), ['导演没在跑，上下文代理还没起来'], '记下的渠道是上次的');
    writePid(paths.pidFile);
    assert.deepEqual(await run('chat'), ['yoyo chat <动作>\n\nsync       把渠道接到桌宠对话']);
    assert.deepEqual(await run('chat', 'sync'), ['已接上 mock-model']);
    assert.deepEqual(calls, ['bind:http://127.0.0.1:4567/v1']);
  });

  test('web open：常驻进程在跑才打开记下的地址；关掉 web 就说一声', async () => {
    const opened: string[] = [];
    const { run, env, paths } = cli({ overrides: { opener: { open: (url) => void opened.push(url) } } });
    assert.deepEqual(await run('web', 'open'), ['常驻进程没在跑，管理页跟着它开']);
    env.repos().kv.set('web-url', 'http://127.0.0.1:4568/#token=t');
    assert.deepEqual(await run('web', 'open'), ['常驻进程没在跑，管理页跟着它开'], '记下的地址是上次的');
    writePid(paths.pidFile);
    assert.deepEqual(await run('web', 'open'), ['http://127.0.0.1:4568/#token=t']);
    assert.deepEqual(opened, ['http://127.0.0.1:4568/#token=t']);
    const off = cli({ config: { web: { enabled: false } } });
    assert.deepEqual(await off.run('web', 'open'), ['config.json 的 web.enabled 关着，没有管理页']);
  });

  test('web url 只打地址，没开着时报错；从 yoyo.app 里跑时 web open 打开 app', async () => {
    const opened: string[] = [];
    const { run, env, paths } = cli({
      overrides: { opener: { open: (url) => void opened.push(url) } },
      app: '/Applications/yoyo.app',
    });
    await assert.rejects(run('web', 'url'), /常驻进程没在跑/);
    env.repos().kv.set('web-url', 'http://127.0.0.1:4568/#token=t');
    writePid(paths.pidFile);
    assert.deepEqual(await run('web', 'url'), ['http://127.0.0.1:4568/#token=t']);
    assert.deepEqual(await run('web', 'open'), ['http://127.0.0.1:4568/#token=t']);
    assert.deepEqual(opened, ['/Applications/yoyo.app']);
  });

  test('update check：从 Release 取最新版本，--json 给 app 读，带更新说明', async () => {
    const updater: UpdateSystem = {
      fetch: async () =>
        Response.json({
          tag_name: 'v0.2.0',
          html_url: 'https://github.com/modelctx-ai/yoyo/releases/tag/v0.2.0',
          body: '## 更新\n* 下载有进度了',
          assets: [{ name: 'yoyo-0.2.0-macos-arm64.dmg', browser_download_url: 'https://x/y.dmg', size: 1 }],
        }),
      run: () => {},
      spawnDetached: () => {},
      alive: () => false,
      kill: () => {},
      arch: 'arm64',
    };
    assert.deepEqual(await cli({ updater }).run('update', 'check'), ['最新的是 0.2.0；从源码跑的用 git pull 更新']);
    const { run } = cli({ updater, installed: '0.1.0' });
    assert.deepEqual(await run('update', 'check'), ['0.2.0 可以更新了，现在是 0.1.0', 'yoyo update install 换上新版']);
    assert.deepEqual(JSON.parse((await run('update', 'check', '--json'))[0]!), {
      current: '0.1.0',
      latest: '0.2.0',
      available: true,
      page: 'https://github.com/modelctx-ai/yoyo/releases/tag/v0.2.0',
      body: '## 更新\n* 下载有进度了',
      message: '0.2.0 可以更新了，现在是 0.1.0',
    });
    await assert.rejects(run('update', 'install'), /只有 yoyo\.app 能自己更新/);
    assert.deepEqual(await cli({ updater, installed: '0.2.0' }).run('update', 'install'), ['已经是最新的 0.2.0']);
  });

  describe('update install 的进度', () => {
    const DMG = Buffer.alloc(40 * 1024 * 1024, 1);
    const name = 'yoyo-0.2.0-macos-arm64.dmg';
    const sha = createHash('sha256').update(DMG).digest('hex');

    /** 下载分 40 块，每块 1 MB；`ditto` 照着放一个假的 app。 */
    function installer(options: { readonly broken?: boolean } = {}): {
      updater: UpdateSystem;
      app: string;
      root: string;
    } {
      const dir = mkdtempSync(join(tmpdir(), 'yoyo-inst-'));
      const root = join(dir, 'yoyo.app', 'Contents', 'Resources');
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib', 'VERSION'), '0.1.0\n');
      writeFileSync(join(root, 'lib', 'swap.sh'), '#!/bin/bash\n');
      const updater: UpdateSystem = {
        fetch: async (url) => {
          if (url.includes('api.github.com')) {
            return Response.json({
              tag_name: 'v0.2.0',
              html_url: 'https://github.com/modelctx-ai/yoyo/releases/tag/v0.2.0',
              assets: [{ name, browser_download_url: `https://dl/${name}`, size: DMG.length, digest: `sha256:${sha}` }],
            });
          }
          if (options.broken) return new Response('no', { status: 500 });
          const chunks = Array.from({ length: 40 }, (_, i) => DMG.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024));
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { headers: { 'content-length': String(DMG.length) } },
          );
        },
        run(command, args) {
          if (command !== 'ditto') return;
          const lib = join(args[1]!, 'Contents', 'Resources', 'lib');
          mkdirSync(lib, { recursive: true });
          writeFileSync(join(lib, 'VERSION'), '0.2.0\n');
        },
        spawnDetached: () => {},
        alive: () => false,
        kill: () => {},
        arch: 'arm64',
      };
      return { updater, app: join(dir, 'yoyo.app'), root };
    }

    test('终端里每 5% 一行，不是每一块一行', async () => {
      const { updater, app, root } = installer();
      const { run } = cli({ updater, installed: '0.1.0', app, root });
      const lines = await run('update', 'install');
      const percents = lines.filter((line) => line.startsWith('下载 ') && line.includes('%'));
      assert.equal(percents.length, 20);
      assert.equal(percents[0], '下载 5%（2/40 MB）');
      assert.equal(percents.at(-1), '下载 100%（40/40 MB）');
      assert.deepEqual(lines.slice(0, 1), [`下载 ${name}`]);
      assert.equal(lines.at(-1), '0.2.0 装好了');
    });

    test('--json：一行一个事件，step、每 1% 一条 progress、最后 done', async () => {
      const { updater, app, root } = installer();
      const { run } = cli({ updater, installed: '0.1.0', app, root });
      const events = (await run('update', 'install', '--json')).map(
        (line) => JSON.parse(line) as { type: string; done?: number; total?: number; text?: string },
      );
      assert.deepEqual(events[0], { type: 'step', text: `下载 ${name}` });
      const progress = events.filter((event) => event.type === 'progress');
      assert.deepEqual(progress[0], { type: 'progress', done: 0, total: DMG.length });
      assert.deepEqual(progress.at(-1), { type: 'progress', done: DMG.length, total: DMG.length });
      assert.ok(progress.length <= 102 && progress.length >= 40);
      assert.ok(
        progress.every((event, i) => i === 0 || event.done! > progress[i - 1]!.done!),
        '只涨不降',
      );
      assert.deepEqual(events.at(-1), { type: 'done', updated: true, message: '0.2.0 装好了' });
      assert.deepEqual(events.at(-2), { type: 'step', text: '取出新的 yoyo.app' });
    });

    test('--json：没有新版本给 done；出错先给 error 再以非 0 退出', async () => {
      const { updater, app, root } = installer();
      assert.deepEqual(await cli({ updater, installed: '0.2.0', app, root }).run('update', 'install', '--json'), [
        JSON.stringify({ type: 'done', updated: false, message: '已经是最新的 0.2.0' }),
      ]);
      const bad = installer({ broken: true });
      const failing = cli({ updater: bad.updater, installed: '0.1.0', app: bad.app, root: bad.root });
      await assert.rejects(failing.run('update', 'install', '--json'), /安装包没下下来：500/);
      const last = JSON.parse(failing.lines.at(-1)!) as { type: string; message: string };
      assert.deepEqual(last, { type: 'error', message: '安装包没下下来：500' });
    });
  });

  test('app login：看和改登录时自动打开，和设置页是同一项', async () => {
    const { run, paths } = cli({
      config: { stage: 'console', app: { keep: 1 } },
    });
    assert.deepEqual(await run('app', 'login'), ['登录时自动打开：关着']);
    assert.deepEqual(await run('app', 'login', 'on'), [
      '登录时会自动打开 yoyo',
      '注意：现在不是从 yoyo.app 跑的，这一项只在 yoyo.app 里管用',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(paths.configFile, 'utf8')).app, { keep: 1, launchAtLogin: true });
    const again = cli({ config: { stage: 'console', app: { launchAtLogin: true } }, app: '/Applications/yoyo.app' });
    assert.deepEqual(await again.run('app', 'login'), ['登录时自动打开：开着']);
    assert.deepEqual(await again.run('app', 'login', 'off'), ['登录时不再自动打开 yoyo']);
    assert.deepEqual(JSON.parse(readFileSync(again.paths.configFile, 'utf8')).app, { launchAtLogin: false });
    await assert.rejects(again.run('app', 'login', 'maybe'), /要写 on 或 off/);
  });

  test('task：自己派、列、看、看它一步步做了什么、取消；规则不让做的报一句话', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('task', 'list'), ['还没有子任务']);
    assert.deepEqual(
      await run('task', 'add', '--title', '整理周报', '--goal', '本周进展', '--criteria', '三个项目都有；每项三行内'),
      ['开了子任务 #1，交给 general，常驻进程在跑就会去做'],
    );
    assert.deepEqual(await run('task', 'list'), ['#1\t排队\t-\t整理周报']);
    const [detail] = await run('task', 'show', '1');
    assert.match(detail!, /验收标准：\n1\. 三个项目都有\n2\. 每项三行内/);
    assert.equal(env.repos().agentTasks.get(1)?.origin, 'cli');
    assert.deepEqual(await run('task', 'log', '1'), ['还没开始做']);

    const context = await createYoyoContext({ db: env.db(), petId: 'default' });
    await context.store.append(taskSession(1), [
      userEntry('子任务 #1：整理周报', { at: NOW.getTime() }),
      assistantEntry('先拆一下', { at: NOW.getTime() }),
    ]);
    const log = await run('task', 'log', '1');
    assert.deepEqual(
      log.map((line) => line.split('\t').slice(1).join(' ')),
      ['收到 子任务 #1：整理周报', '说 先拆一下'],
    );

    assert.deepEqual(await run('task', 'cancel', '1'), ['取消了子任务 #1']);
    await assert.rejects(run('task', 'cancel', '1'), /已经「取消了」/);
    await assert.rejects(run('task', 'show', 'x'), /要给子任务编号/);
    await assert.rejects(run('task', 'add', '--title', '没目标'), /目标不能空着/);
  });

  test('task answer：回答在等回答的子任务，show 看得到问题和回答；不在等的、没写回答的报一句话', async () => {
    const { run, env } = cli();
    await run('task', 'add', '--title', '做封面', '--goal', '做封面');
    await assert.rejects(run('task', 'answer', '1', '蓝色'), /现在是「排队」，没有在等回答/);
    env.repos().agentTasks.update(1, { state: 'running' }, NOW.getTime());
    askTask(env.repos(), 1, '封面用蓝色还是绿色？', NOW);
    assert.deepEqual(await run('task', 'list', '--state', 'waiting'), ['#1\t等回答\t-\t做封面']);
    assert.match((await run('task', 'show', '1'))[0]!, /问题（等主人回答）：\n封面用蓝色还是绿色？/);
    await assert.rejects(run('task', 'answer', '1'), /回答不能空着/);
    await assert.rejects(run('task', 'answer', 'x', '蓝'), /要给子任务编号/);
    assert.deepEqual(await run('task', 'answer', '1', '蓝色', '吧'), ['回答交给子任务 #1 了，常驻进程在跑就会接着做']);
    assert.equal(env.repos().agentTasks.get(1)?.answer, '蓝色 吧');
    assert.equal(env.repos().agentTasks.get(1)?.state, 'queued');
    assert.match((await run('task', 'show', '1'))[0]!, /问过：\n封面用蓝色还是绿色？\n\n主人的回答：\n蓝色 吧/);
    await assert.rejects(run('task', 'answer', '1', '蓝'), /没有在等回答/);
  });

  test('approval：list 等批准的在前，show 看完整参数，approve、deny 只能点一次；批准的人是命令行', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('approval', 'list'), ['还没有批准请求']);
    const repos = env.repos();
    const write = requestApproval(
      repos,
      {
        tool: 'write',
        summary: '写 notes/周报.md（新建，2 行，11 B）',
        input: { path: 'notes/周报.md', content: '# 周报\nA\n' },
        task: null,
      },
      NOW,
    );
    const bash = requestApproval(
      repos,
      { tool: 'bash', summary: '跑命令：python plot.py', input: { command: 'python plot.py' }, task: 3 },
      NOW,
    );
    requestApproval(
      repos,
      { tool: 'edit', summary: '改 a.md（换 1 处）', input: { path: 'a.md', old: 'x', new: 'y' }, task: null },
      NOW,
    );
    assert.deepEqual(await run('approval', 'list'), [
      '#3\t等批准\tedit\t主线程\t改 a.md（换 1 处）',
      '#2\t等批准\tbash\t子任务 #3\t跑命令：python plot.py',
      '#1\t等批准\twrite\t主线程\t写 notes/周报.md（新建，2 行，11 B）',
    ]);
    assert.equal(
      (await run('approval', 'show', '#1'))[0],
      '#1 写 notes/周报.md（新建，2 行，11 B）（等批准，write，主线程）\n\n参数：\npath：notes/周报.md\ncontent：\n# 周报\nA\n',
    );
    assert.deepEqual(await run('approval', 'approve', String(write.id)), [
      '批准了 #1「写 notes/周报.md（新建，2 行，11 B）」，常驻进程在跑就会照做',
    ]);
    assert.deepEqual(await run('approval', 'deny', String(bash.id)), ['拒绝了 #2「跑命令：python plot.py」']);
    await assert.rejects(run('approval', 'deny', '1'), /已经「批准了」，不能再改/);
    await assert.rejects(run('approval', 'approve', '2'), /已经「拒绝了」，不能再改/);
    await assert.rejects(run('approval', 'approve', '9'), /没有批准请求 #9/);
    await assert.rejects(run('approval', 'approve'), /要给批准请求的编号/);
    assert.deepEqual(await run('approval', 'list', '--state', 'denied'), [
      '#2\t拒绝了\tbash\t子任务 #3\t跑命令：python plot.py',
    ]);
    await assert.rejects(
      run('approval', 'list', '--state', 'x'),
      /没有「x」这种状态，有：pending、approved、denied、expired/,
    );
    assert.deepEqual(
      repos.activity
        .list(10)
        .filter((e) => e.type.startsWith('approval-'))
        .map((e) => [e.type, e.id, e['via'] ?? null]),
      [
        ['approval-ask', 1, null],
        ['approval-ask', 2, null],
        ['approval-ask', 3, null],
        ['approval-approve', 1, 'cli'],
        ['approval-deny', 2, 'cli'],
      ],
    );
  });

  test('task list --state 只列这几种状态；写错的说清楚有哪些', async () => {
    const { run, env } = cli();
    for (const title of ['一', '二', '三']) await run('task', 'add', '--title', title, '--goal', '做');
    env.repos().agentTasks.update(1, { state: 'running' }, NOW.getTime());
    env.repos().agentTasks.update(2, { state: 'running' }, NOW.getTime());
    assert.deepEqual(await run('task', 'list', '--state', 'running'), ['#2\t在做\t-\t二', '#1\t在做\t-\t一']);
    assert.deepEqual(await run('task', 'list', '--state', 'queued,running'), [
      '#3\t排队\t-\t三',
      '#2\t在做\t-\t二',
      '#1\t在做\t-\t一',
    ]);
    assert.deepEqual(await run('task', 'list', '--state', 'done'), ['没有「done」的子任务']);
    await assert.rejects(run('task', 'list', '--state', 'busy'), /没有「busy」这种状态，有：queued、running/);
  });

  test('search：对话、子任务、记住的事、日程、联系人一起找，几个词都要有；--in 只找哪几类', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('search'), ['yoyo search <动作>\n\nall        找一个词：yoyo search 周报']);
    assert.deepEqual(await run('search', '周报'), ['没找到「周报」']);
    const context = await createYoyoContext({ db: env.db(), petId: env.settings().pet.id });
    await context.append(
      userEntry('帮我整理本周周报', { at: NOW.getTime() - 60_000 }),
      assistantEntry('好，周报交给子任务', { at: NOW.getTime() }),
      userEntry('今天天气怎么样', { at: NOW.getTime() }),
    );
    await run('task', 'add', '--title', '整理本周周报', '--goal', '三个项目');
    await run('task', 'add', '--title', '订机票', '--goal', '周报写完以后订');
    await run('alarm', 'add', '--title', '写周报', '--time', '17:00', '--repeat', 'weekly', '--weekday', '5');
    await run('contact', 'add', '--name', '小王', '--yoyo', 'yoyo://wang@example', '--note', '周报找他');
    await openMemoryStore(env.db()).facts.add({
      subject: 'user',
      topic: 'work',
      confidence: 0.9,
      salience: 0.8,
      text: '主人每周五交周报',
      validFrom: NOW.getTime(),
      sources: [{ session: 'pet:main', from: 1, upTo: 1 }],
    });
    const rows = await run('search', '周报');
    assert.deepEqual(
      rows.map((row) => row.split('\t')[0]),
      [
        '对话',
        '对话',
        '子任务',
        '子任务',
        '事实',
        '日程',
        '联系人',
        '',
        '下一步：yoyo task show <编号>    yoyo memory history <id>',
      ],
    );
    assert.match(rows[0]!, /^对话\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}\tyoyo\t好，周报交给子任务$/);
    assert.match(rows[1]!, /\t主人\t帮我整理本周周报$/);
    assert.equal(rows[2], '子任务\t#2\t排队\tgeneral\t订机票：周报写完以后订');
    assert.equal(rows[3], '子任务\t#1\t排队\tgeneral\t整理本周周报');
    assert.match(rows[4]!, /^事实\t\S+\twork\t主人每周五交周报$/);
    assert.match(rows[5]!, /^日程\ts_\w+\t每周 17:00\talarm\t写周报$/);
    assert.equal(rows[6], '联系人\t小王\tyoyo://wang@example\t周报找他');

    assert.deepEqual(await run('search', '本周', '周报', '--in', 'tasks'), [
      '子任务\t#1\t排队\tgeneral\t整理本周周报',
      '',
      '下一步：yoyo task show <编号>',
    ]);
    assert.deepEqual(await run('search', 'all', '周报', '--in', 'chat', '--limit', '1'), [
      rows[0],
      '对话\t还有 1 条，加 --limit 看更多',
    ]);
  });

  test('artifact：列、打出内容、删；task show 和 search 里也有', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('artifact', 'list'), ['还没有交付物']);
    await run('task', 'add', '--title', '整理周报', '--goal', '本周');
    env.repos().agentTasks.update(1, { state: 'running' }, NOW.getTime());
    const md = deliverArtifact(env.repos(), env.files(), { id: 1, name: '周报.md', content: '# 周报\nA 上线' }, NOW);
    const png = deliverArtifact(
      env.repos(),
      env.files(),
      { id: 1, name: '图.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
      NOW,
    );
    assert.deepEqual(await run('artifacts', 'list', '--task', '#1'), [
      `${png.id}\t#1\t8 B\timage/png\t图.png`,
      `${md.id}\t#1\t17 B\ttext/markdown\t周报.md`,
    ]);
    assert.deepEqual(await run('artifact', 'list', '--task', '2'), ['子任务 #2 没交文件']);
    assert.deepEqual(await run('artifact', 'show', String(md.id)), ['# 周报\nA 上线']);
    assert.deepEqual(await run('artifact', 'show', String(png.id)), [
      `图.png\timage/png\t${env.files().path(1, '图.png')}`,
    ]);
    assert.match((await run('task', 'show', '1'))[0]!, /\n交付物：\n图\.png（8 B）\n周报\.md（17 B）/);
    assert.deepEqual(await run('search', '周报', '--in', 'files'), [
      `交付物\t${md.id}\t#1\t周报.md`,
      '',
      '下一步：yoyo artifact show <编号>',
    ]);
    assert.deepEqual(await run('artifact', 'rm', String(md.id)), ['删了 周报.md']);
    assert.equal(env.files().read(1, '周报.md'), null);
    await assert.rejects(run('artifact', 'show', String(md.id)), /没有交付物/);
    await assert.rejects(run('artifact', 'rm', 'x'), /要给交付物编号/);
  });

  test('agent 那部分：只读的查询，不含改东西、碰桌宠和网络的', () => {
    const { env } = cli();
    assert.deepEqual(
      agentDomains(buildDomains(env)).map(
        (domain) => `${domain.name} ${domain.verbs.map((verb) => verb.name).join(',')}`,
      ),
      [
        'alarm list',
        'contact list',
        'context tail',
        'memory core,facts,history,rules',
        'task list,show,log,agents',
        'approval list,show',
        'artifact list,show',
        'search all',
        'log tail',
      ],
    );
  });

  test('task agents 列出类型；task add --agent 挑一种，~/.yoyo/agents 里加的也认', async () => {
    const { run, paths } = cli();
    const builtin = await run('task', 'agents');
    assert.deepEqual(
      builtin.map((line) => line.split('\t')[0]),
      ['general', 'research', 'writer'],
    );
    assert.match(builtin[0]!, /\t全部工具\t内置$/);
    mkdirSync(paths.agentsDir, { recursive: true });
    writeFileSync(
      join(paths.agentsDir, 'reviewer.md'),
      '---\ndescription: 看 PR\ntools: web_search\nmodel: m2\n---\n看',
    );
    assert.ok((await run('task', 'agents')).some((line) => line.startsWith('reviewer\t看 PR\tweb_search\tm2\t')));
    assert.deepEqual(await run('task', 'add', '--title', '看', '--goal', '看 PR', '--agent', 'reviewer'), [
      '开了子任务 #1，交给 reviewer，常驻进程在跑就会去做',
    ]);
    await assert.rejects(
      run('task', 'add', '--title', '看', '--goal', '看', '--agent', 'coder'),
      /没有「coder」这种子 agent/,
    );
  });

  test('listen、whisper：导演在跑就交给它', async () => {
    const { run, paths } = cli();
    writePid(paths.pidFile);
    assert.equal(directorAlive(paths.pidFile), true);
    assert.deepEqual(await run('whisper'), ['已交给正在运行的 yoyo：whisper']);
    assert.deepEqual(await run('listen', 'now'), ['已交给正在运行的 yoyo：listen']);
    assert.deepEqual(
      drain(paths.inboxFile).map((message) => message.type),
      ['whisper', 'listen'],
    );
  });

  test('whisper：导演没在跑就当场说一句；驱动桌宠时语音没配好先报出来', async () => {
    const calls: string[] = [];
    const { run, env, logger } = cli({ config: CONSOLE_CONFIG, overrides: quietServices(calls) });
    // 导演用真时钟：先记下今天报过天气，免得赶上下班时间去联网查
    env.repos().kv.set('weather-date', localDateKey(new Date()));
    assert.deepEqual(await run('whisper'), []);
    assert.equal(calls[0]?.startsWith('synth:'), true);
    assert.ok(calls.some((call) => call.startsWith('play:')));
    assert.ok(
      logger.lines.some((line) => line.startsWith('[')),
      '控制台舞台把台词打印出来',
    );
    assert.deepEqual(
      env
        .repos()
        .activity.list(10)
        .map((event) => event.type)
        .slice(-1),
      ['sfx'],
    );

    // 驱动桌宠时语音必须配好；控制台舞台不用，没配就只打印台词
    const bare = cli({ config: {} });
    await assert.rejects(bare.run('whisper'), /speech\.apiKey 还空着/);
    const quiet = cli({ config: { stage: 'console' }, overrides: { platform: 'linux' } });
    quiet.env.repos().kv.set('weather-date', localDateKey(new Date()));
    assert.deepEqual(await quiet.run('whisper'), []);
    assert.ok(quiet.logger.lines.some((line) => line.startsWith('[')));
    assert.deepEqual(
      quiet.env
        .repos()
        .activity.list(10)
        .map((event) => event.type)
        .slice(-1),
      ['sfx'],
    );
  });
});
