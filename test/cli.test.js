import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dispatch, findDomains } from '../src/cli.js';
import { notePaste } from '../src/clipboard.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const domains = [
  {
    name: 'alarm',
    summary: '闹钟和周期性日程',
    detail: '到点后 15 分钟内说一次。',
    verbs: [
      { name: 'list', summary: '列出日程' },
      { name: 'add', summary: '新增', flags: ['title', 'time', 'repeat', 'date', 'kind'] },
    ],
  },
  {
    name: 'clip',
    summary: '粘贴板和复制历史',
    verbs: [
      { name: 'get', summary: '当前内容' },
      { name: 'history', summary: '最近复制' },
    ],
  },
];

describe('cli', () => {
  test('顶层只给领域，不展开参数', () => {
    const result = dispatch(domains, []);
    assert.match(result.text, /^yoyo <领域>/);
    assert.match(result.text, /alarm/);
    assert.equal(result.text.includes('--title'), false);
  });

  test('领域只列动作，inspect 才给参数', () => {
    const listed = dispatch(domains, ['alarm']);
    assert.match(listed.text, /list/);
    assert.equal(listed.text.includes('--title'), false);
    const inspected = dispatch(domains, ['inspect', 'alarm']);
    assert.match(inspected.text, /--title/);
  });

  test('find 按词找到领域', () => {
    assert.equal(findDomains(domains, '粘贴').map((item) => item.name).join(), 'clip');
    assert.match(dispatch(domains, ['find', '没有的词']).text, /^没有/);
  });

  test('粘贴板内容变了才记一条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-clip-'));
    assert.ok(notePaste(dir, '第一段'));
    assert.equal(notePaste(dir, '第一段'), null);
    assert.ok(notePaste(dir, '第二段'));
  });
});
