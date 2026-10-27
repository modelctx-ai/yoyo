import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { assistantEntry, eventEntry, userEntry } from '@modelctx-ai/ctx';

import type { AppOverrides } from '../app/container.ts';
import { resolvePaths, type Paths } from '../app/paths.ts';
import { createYoyoContext } from '../brain/context.ts';
import { openMemoryStore } from '../brain/memory.ts';
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
import { dispatch } from './registry.ts';

const NOW = new Date(2026, 9, 24, 15, 0, 0);

interface Cli {
  readonly env: CommandEnv;
  readonly paths: Paths;
  readonly lines: string[];
  readonly logger: MemoryLogger;
  /** 跑一条命令，返回这条命令打印的行。 */
  readonly run: (...argv: string[]) => Promise<string[]>;
}

function cli(options: { readonly config?: unknown; readonly overrides?: AppOverrides } = {}): Cli {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  if (options.config !== undefined) writeFileSync(paths.configFile, JSON.stringify(options.config));
  const lines: string[] = [];
  const logger = memoryLogger();
  const env = createCommandEnv(paths, {
    out: (text) => void lines.push(text),
    logger,
    now: () => NOW,
    ...(options.overrides ? { overrides: options.overrides } : {}),
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
    assert.deepEqual(await run('alarm', 'list'), ['task\t09:30\t2026-10-26\t开会', 'alarm\t15:30\tdaily\t喝水']);
    await assert.rejects(run('alarm', 'add', '--time', '15:30', '--repeat', 'daily'), /日程要有标题/);
    await assert.rejects(run('alarm', 'add', '--title', '周会', '--time', '10:00', '--repeat', 'weekly'), /weekday/);
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
