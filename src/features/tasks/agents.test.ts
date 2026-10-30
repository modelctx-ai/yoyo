import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  AgentFileError,
  BUILTIN_AGENTS,
  TASK_TOOL_NAMES,
  agentMenu,
  agentTools,
  mergeAgents,
  parseAgentFile,
} from './agents.ts';

const REVIEWER = `---
name: reviewer
description: 帮主人看 PR 描述写得清不清楚
tools: [web_search, "github__*"]
model: claude-haiku-5-5
---
你是看 PR 描述的子 agent。
挑出说不清的地方，给改法。
`;

describe('子 agent 类型', () => {
  test('内置三种：general 全部工具，research 只读，writer 不上网', () => {
    assert.deepEqual(
      BUILTIN_AGENTS.map((profile) => profile.name),
      ['general', 'research', 'writer'],
    );
    assert.equal(BUILTIN_AGENTS[0]?.tools, null);
    assert.ok(!BUILTIN_AGENTS[1]?.tools?.includes('add_alarm'));
    assert.ok(!BUILTIN_AGENTS[2]?.tools?.includes('web_search'));
  });

  test('解析 agent 文件：照 Claude Code 的格式，frontmatter 加正文', () => {
    const profile = parseAgentFile(REVIEWER, 'whatever', '/a/reviewer.md');
    assert.deepEqual(profile, {
      name: 'reviewer',
      description: '帮主人看 PR 描述写得清不清楚',
      instructions: '你是看 PR 描述的子 agent。\n挑出说不清的地方，给改法。',
      tools: ['web_search', 'github__*'],
      model: 'claude-haiku-5-5',
      source: '/a/reviewer.md',
    });
    const plain = parseAgentFile('---\ndescription: 随便\n---\n做事', 'helper', 'helper.md');
    assert.equal(plain.name, 'helper', '没写 name 用文件名');
    assert.equal(plain.tools, null, '没写 tools 是全部');
    assert.equal(plain.model, null);
  });

  test('写错的说清楚哪个文件哪里不对', () => {
    assert.throws(() => parseAgentFile('没有 frontmatter', 'x', 'x.md'), /x\.md：开头要有 --- 包着的 frontmatter/);
    assert.throws(
      () => parseAgentFile('---\nname: Bad Name\ndescription: d\n---\n正文', 'x', 'x.md'),
      /只能用小写字母/,
    );
    assert.throws(() => parseAgentFile('---\nname: ok\n---\n正文', 'x', 'x.md'), /要写 description/);
    assert.throws(() => parseAgentFile('---\ndescription: d\n---\n', 'ok', 'x.md'), AgentFileError);
  });

  test('合并：主人的同名盖掉内置的，general 排在最前，其余按名字', () => {
    const custom = parseAgentFile('---\nname: research\ndescription: 我的查资料\n---\n查', 'research', 'r.md');
    const merged = mergeAgents([parseAgentFile(REVIEWER, 'reviewer', 'v.md'), custom]);
    assert.deepEqual(
      merged.map((profile) => profile.name),
      ['general', 'research', 'reviewer', 'writer'],
    );
    assert.equal(merged[1]?.description, '我的查资料');
  });

  test('挑工具：清单里有的加上任务工具，* 按前缀，没有的跳过；全部就是 true', () => {
    const available = [
      'web_search',
      'add_alarm',
      'github__list_prs',
      'github__get_pr',
      'gitlab__x',
      ...TASK_TOOL_NAMES,
    ];
    const reviewer = parseAgentFile(REVIEWER, 'reviewer', 'v.md');
    assert.deepEqual(agentTools(reviewer, available), [
      'web_search',
      'github__list_prs',
      'github__get_pr',
      ...TASK_TOOL_NAMES,
    ]);
    assert.deepEqual(agentTools(BUILTIN_AGENTS[2]!, available), [...TASK_TOOL_NAMES], 'recall 没有就跳过');
    assert.equal(agentTools(BUILTIN_AGENTS[0]!, available), true);
  });

  test('bash 只有 general 有：research、writer 的清单里没有，要用自己在 tools 里写', () => {
    const available = ['read', 'write', 'edit', 'bash', 'recall', 'yoyo'];
    assert.equal(agentTools(BUILTIN_AGENTS[0]!, available), true);
    for (const name of ['research', 'writer']) {
      const profile = BUILTIN_AGENTS.find((item) => item.name === name)!;
      assert.ok(!(agentTools(profile, available) as string[]).includes('bash'), name);
    }
    const custom = parseAgentFile(REVIEWER.replace('[web_search, "github__*"]', 'read, bash'), 'x', 'x.md');
    assert.ok((agentTools(custom, available) as string[]).includes('bash'));
  });

  test('给主线程看的清单：名字和什么时候用', () => {
    assert.match(agentMenu(BUILTIN_AGENTS), /^general：什么都能做.*\nresearch：上网查.*\nwriter：把给的材料/);
  });
});
