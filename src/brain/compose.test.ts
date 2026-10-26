import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore,
  createToolRegistry,
  defineSource,
  tool,
  type ContextSource,
  type LanguageModel,
  type ToolRegistry,
} from '@modelctx-ai/ctx';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import type { Line } from '../kernel/types.ts';
import { generateReply, generateWhisper, parseWhisper } from './compose.ts';
import { recordLine, recordUser, yoyoProjection } from './context.ts';
import {
  COMPACT_INSTRUCTIONS,
  TONE_HINT,
  replyInstructions,
  searchPrompt,
  whisperInstructions,
  whisperPrompt,
} from './prompts.ts';

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): DoGenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
}

function toolCallResult(id: string, toolName: string, input: unknown): DoGenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

function spoken(kind: Line['kind'], text: string): Line {
  return { text, kind, tone: 'brisk', cue: '[confident]', action: '写代码' };
}

const FACTS: readonly ContextSource[] = [
  defineSource('task', () => '当前任务：修天气地点'),
  defineSource('clipboard', () => '粘贴板：npm test'),
];

/** 碎碎念、用户这句、回复各一条，事实是当前任务和粘贴板。 */
async function seeded(options: { model?: LanguageModel; tools?: ToolRegistry; sources?: readonly ContextSource[] }) {
  const context = createContext({
    store: createMemoryStore(),
    session: 'pet:main',
    projection: yoyoProjection,
    sources: options.sources ?? FACTS,
    ...(options.model ? { model: options.model } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  await recordLine(context, spoken('whisper', '先把这一小步做完'), 1);
  await recordUser(context, '看一下测试', 2);
  await recordLine(context, spoken('reply', '好，我盯着'), 3);
  return context;
}

function alarmTools(calls: string[]): ToolRegistry {
  return createToolRegistry().addTool(
    'list_alarms',
    tool({
      description: '列出闹钟',
      inputSchema: z.object({}),
      execute: async () => {
        calls.push('list_alarms');
        return [{ title: '开周会', time: '08:00' }];
      },
    }),
  );
}

describe('brain/compose parseWhisper', () => {
  test('去掉引号和句首标签，并配上当前语气的动作', () => {
    const line = parseWhisper('「[happy] 今天的编译过了，可以歇一下。」', 'warm');
    assert.equal(line?.text, '今天的编译过了，可以歇一下。');
    assert.equal(line?.cue, '[relaxed]');
    assert.equal(line?.action, '碎碎念-对屏碎碎念');
    assert.equal(line?.kind, 'generated');
    assert.equal(line?.tone, 'warm');
  });

  test('太短或太长的结果丢掉', () => {
    assert.equal(parseWhisper('嗯', 'calm'), null);
    assert.equal(parseWhisper('啊'.repeat(81), 'calm'), null);
    assert.equal(parseWhisper(null, 'calm'), null);
    assert.equal(parseWhisper(undefined, 'calm'), null);
    assert.ok(parseWhisper('啊'.repeat(80), 'calm'));
  });

  test('代码块去掉，只取第一句非空行；回复的 kind 是 reply', () => {
    const line = parseWhisper('```\n不要这段\n```\n\n  "先喝口水再继续"\n第二行', 'brisk', 'reply');
    assert.deepEqual(line, {
      text: '先喝口水再继续',
      tone: 'brisk',
      cue: '[confident]',
      action: '写代码',
      kind: 'reply',
    });
  });
});

describe('brain/prompts', () => {
  test('语气说明仍在系统提示里', () => {
    assert.match(whisperInstructions('brisk'), /confident/);
    for (const tone of ['lively', 'warm', 'calm', 'brisk'] as const) {
      assert.ok(whisperInstructions(tone).endsWith(TONE_HINT[tone]));
      assert.ok(replyInstructions(tone).endsWith(TONE_HINT[tone]));
    }
    assert.match(whisperInstructions('calm'), /^你是主人桌面上的 Q 版蓝发小女仆，在说一句碎碎念。/);
    assert.match(replyInstructions('calm'), /有搜索结果时只用里面的事实，没有就不要编新闻或数字。/);
  });

  test('碎碎念提示：事实各占一行，最后一行请她再说一句', () => {
    assert.equal(whisperPrompt([]), '请再说一句碎碎念。');
    assert.equal(
      whisperPrompt([
        { source: 'task', text: '当前任务：修天气地点' },
        { source: 'clipboard', text: '粘贴板：npm test' },
      ]),
      '当前任务：修天气地点\n粘贴板：npm test\n请再说一句碎碎念。',
    );
  });

  test('搜索结果为空就不带', () => {
    assert.equal(searchPrompt(undefined), undefined);
    assert.equal(searchPrompt('  \n '), undefined);
    assert.equal(searchPrompt(' 台北晴，28 度 '), '搜索结果：\n台北晴，28 度');
  });

  test('压缩说明是中文，要求不编、只出摘要', () => {
    assert.match(COMPACT_INSTRUCTIONS, /摘要/);
    assert.match(COMPACT_INSTRUCTIONS, /不要编/);
    assert.match(COMPACT_INSTRUCTIONS, /名字和数字/);
  });
});

describe('brain/compose generateWhisper', () => {
  test('指令是人设加语气，历史是上下文视图，最后一条是事实加请求；不给工具，不写日志', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('「[happy] 先把测试跑一遍再说」') });
    const context = await seeded({ model, tools: alarmTools([]) });
    const line = await generateWhisper(context, { tone: 'brisk' });
    assert.deepEqual(line, {
      text: '先把测试跑一遍再说',
      tone: 'brisk',
      cue: '[confident]',
      action: '写代码',
      kind: 'generated',
    });
    const call = model.doGenerateCalls[0]!;
    assert.deepEqual(call.prompt[0], { role: 'system', content: whisperInstructions('brisk') });
    assert.deepEqual(
      call.prompt.map((message) => message.role),
      ['system', 'assistant', 'user', 'assistant', 'user'],
    );
    assert.deepEqual(call.prompt[1]?.content, [{ type: 'text', text: '碎碎念：\n先把这一小步做完' }]);
    assert.deepEqual(call.prompt.at(-1)?.content, [
      { type: 'text', text: '当前任务：修天气地点\n粘贴板：npm test\n请再说一句碎碎念。' },
    ]);
    assert.equal(call.temperature, 0.8);
    assert.equal(call.tools, undefined);
    assert.equal((await context.entries()).length, 3, 'record:false，说出口以后才由导演记');
  });

  test('没有事实时最后一条只有请求', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('这会儿好安静呀，我陪着你') });
    const context = await seeded({ model, sources: [] });
    await generateWhisper(context, { tone: 'calm' });
    assert.deepEqual(model.doGenerateCalls[0]!.prompt.at(-1)?.content, [{ type: 'text', text: '请再说一句碎碎念。' }]);
  });

  test('没有可用的句子、或者和历史里的句子重复，就报错', async () => {
    const empty = await seeded({ model: new MockLanguageModelV4({ doGenerate: textResult('嗯') }) });
    await assert.rejects(generateWhisper(empty, { tone: 'brisk' }), { message: '模型没有返回可用的碎碎念' });
    const repeated = await seeded({
      model: new MockLanguageModelV4({ doGenerate: textResult('[happy] 先把这一小步做完') }),
    });
    await assert.rejects(generateWhisper(repeated, { tone: 'brisk' }), { message: '模型重复了最近说过的句子' });
    const echoed = await seeded({ model: new MockLanguageModelV4({ doGenerate: textResult('好，我盯着') }) });
    await assert.rejects(generateWhisper(echoed, { tone: 'brisk' }), { message: '模型重复了最近说过的句子' });
  });

  test('调用方给的模型优先于上下文的缺省模型', async () => {
    const fallback = new MockLanguageModelV4({ doGenerate: textResult('不该用到我这个模型') });
    const chosen = new MockLanguageModelV4({ doGenerate: textResult('我偷偷伸了个懒腰') });
    const context = await seeded({ model: fallback });
    assert.equal((await generateWhisper(context, { tone: 'lively', model: chosen })).text, '我偷偷伸了个懒腰');
    assert.equal(fallback.doGenerateCalls.length, 0);
    assert.equal(chosen.doGenerateCalls.length, 1);
  });
});

describe('brain/compose generateReply', () => {
  test('回复：事实接在指令后面，历史里有刚说的话，搜索结果放最后；不写日志', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('台北今天晴，28 度，出门记得防晒。') });
    const context = await seeded({ model });
    await recordUser(context, '台北今天天气怎么样', 4);
    const line = await generateReply(context, { tone: 'warm', searchText: ' 台北晴，28 度 ' });
    assert.deepEqual(line, {
      text: '台北今天晴，28 度，出门记得防晒。',
      tone: 'warm',
      cue: '[relaxed]',
      action: '碎碎念-对屏碎碎念',
      kind: 'reply',
    });
    const call = model.doGenerateCalls[0]!;
    assert.deepEqual(call.prompt[0], {
      role: 'system',
      content: `${replyInstructions('warm')}\n\n当前任务：修天气地点\n粘贴板：npm test`,
    });
    assert.deepEqual(call.prompt.at(-2)?.content, [{ type: 'text', text: '台北今天天气怎么样' }]);
    assert.deepEqual(call.prompt.at(-1)?.content, [{ type: 'text', text: '搜索结果：\n台北晴，28 度' }]);
    assert.equal(call.temperature, 0.7);
    assert.equal(call.tools, undefined);
    assert.equal((await context.entries()).length, 4);
  });

  test('没有搜索结果时最后一条就是用户刚说的话', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('在呢，你说。') });
    const context = await seeded({ model });
    await recordUser(context, '在吗', 4);
    await generateReply(context, { tone: 'warm', searchText: '' });
    assert.deepEqual(model.doGenerateCalls[0]!.prompt.at(-1)?.content, [{ type: 'text', text: '在吗' }]);
  });

  test('打开工具时交给模型，调完工具再回答；不打开就不给', async () => {
    const calls: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult('c1', 'list_alarms', {}), textResult('明早八点要开周会哦')],
    });
    const context = await seeded({ model, tools: alarmTools(calls) });
    await recordUser(context, '我明天有什么安排', 4);
    const line = await generateReply(context, { tone: 'warm', tools: true });
    assert.equal(line.text, '明早八点要开周会哦');
    assert.deepEqual(calls, ['list_alarms']);
    assert.equal(model.doGenerateCalls.length, 2);
    assert.deepEqual(
      model.doGenerateCalls[0]!.tools?.map((item) => item.name),
      ['list_alarms'],
    );
    assert.ok(model.doGenerateCalls[1]!.prompt.some((message) => message.role === 'tool'));
    assert.equal((await context.entries()).length, 4, '工具调用也不写日志');

    const plain = new MockLanguageModelV4({ doGenerate: textResult('明天好像没有安排') });
    await generateReply(context, { tone: 'warm', model: plain });
    assert.equal(plain.doGenerateCalls[0]!.tools, undefined);
  });

  test('工具最多走 4 步', async () => {
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult(`c${(step += 1)}`, 'list_alarms', {}),
    });
    const context = await seeded({ model, tools: alarmTools([]) });
    await assert.rejects(generateReply(context, { tone: 'warm', tools: true }), { message: '模型没有返回可用的回复' });
    assert.equal(model.doGenerateCalls.length, 4);
  });

  test('没有可用的回复就报错', async () => {
    const context = await seeded({ model: new MockLanguageModelV4({ doGenerate: textResult('   ') }) });
    await assert.rejects(generateReply(context, { tone: 'calm' }), { message: '模型没有返回可用的回复' });
  });
});

describe('brain/compose 模型报错', () => {
  test('接口报错带上状态码和正文片段，密钥抹掉', async () => {
    const failure = new APICallError({
      message: 'Unauthorized',
      url: 'https://llm.example/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 401,
      responseBody: '{"error":"bad key sk-secret-123"}',
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw failure;
      },
    });
    const context = await seeded({ model });
    const error = await generateWhisper(context, { tone: 'brisk', secrets: ['sk-secret-123'] }).catch(
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, '模型接口返回 401：{"error":"bad key ***"}');
    assert.equal(error.cause, failure);
    await assert.rejects(generateReply(context, { tone: 'brisk', secrets: ['sk-secret-123'] }), {
      message: '模型接口返回 401：{"error":"bad key ***"}',
    });
  });

  test('没有正文时只有状态码；别的错误说模型没回', async () => {
    const bare = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: 'Forbidden', url: 'u', requestBodyValues: {}, statusCode: 403 });
      },
    });
    await assert.rejects(generateWhisper(await seeded({ model: bare }), { tone: 'calm' }), {
      message: '模型接口返回 403',
    });
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('socket hang up');
      },
    });
    await assert.rejects(generateReply(await seeded({ model: broken }), { tone: 'calm' }), {
      message: '模型没回：socket hang up',
    });
  });
});
