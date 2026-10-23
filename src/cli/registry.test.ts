import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dispatch, findDomains, inspectText, parseArgs, type Domain } from './registry.ts';

const noop = (): void => {};

const domains: Domain[] = [
  {
    name: 'alarm',
    summary: '闹钟和周期性日程',
    detail: '到点后 15 分钟内说一次。',
    verbs: [
      { name: 'list', summary: '列出日程', run: noop },
      { name: 'add', summary: '新增', flags: ['title', 'time', 'repeat', 'date', 'kind'], run: noop },
    ],
  },
  {
    name: 'clip',
    summary: '粘贴板和复制历史',
    verbs: [
      { name: 'get', summary: '当前内容', run: noop },
      { name: 'history', summary: '最近复制', run: noop },
    ],
  },
  {
    name: 'contact',
    aliases: ['contract'],
    summary: 'yoyo 联系人',
    verbs: [{ name: 'list', summary: '列出联系人', run: noop }],
  },
  {
    name: 'listen',
    summary: '马上听一句语音',
    verbs: [{ name: 'now', summary: '现在就开始听', run: noop }],
  },
];

function text(result: ReturnType<typeof dispatch>): string {
  assert.equal(result.kind, 'text');
  return result.kind === 'text' ? result.text : '';
}

describe('cli', () => {
  test('顶层只给领域，不展开参数', () => {
    const result = text(dispatch(domains, []));
    assert.match(result, /^yoyo <领域>/);
    assert.match(result, /alarm/);
    assert.equal(result.includes('--title'), false);
  });

  test('领域只列动作，inspect 才给参数', () => {
    const listed = text(dispatch(domains, ['alarm']));
    assert.match(listed, /list/);
    assert.equal(listed.includes('--title'), false);
    const inspected = text(dispatch(domains, ['inspect', 'alarm']));
    assert.match(inspected, /--title/);
  });

  test('find 按词找到领域', () => {
    assert.equal(
      findDomains(domains, '粘贴')
        .map((item) => item.name)
        .join(),
      'clip',
    );
    assert.match(text(dispatch(domains, ['find', '没有的词'])), /^没有/);
    assert.equal(text(dispatch(domains, ['find', '--query', '联系人'])), 'contact    yoyo 联系人');
  });

  test('输出和以前一字不差', () => {
    assert.equal(
      text(dispatch(domains, [])),
      [
        'yoyo <领域> [动作]',
        '',
        'alarm      闹钟和周期性日程',
        'clip       粘贴板和复制历史',
        'contact    yoyo 联系人',
        'listen     马上听一句语音',
        '',
        '下一步：yoyo <领域>    yoyo find <词>    yoyo inspect <领域>',
      ].join('\n'),
    );
    assert.equal(text(dispatch(domains, ['clip'])), 'yoyo clip <动作>\n\nget        当前内容\nhistory    最近复制');
    assert.equal(
      inspectText(domains[0]!),
      [
        'alarm  闹钟和周期性日程',
        '',
        'list       列出日程',
        'add        新增\n           --title --time --repeat --date --kind',
        '',
        '到点后 15 分钟内说一次。',
      ].join('\n'),
    );
    assert.equal(
      text(dispatch(domains, ['inspect', 'clip'])),
      'clip  粘贴板和复制历史\n\nget        当前内容\nhistory    最近复制',
    );
  });

  test('别名指向正式名字；不认识的给一句提示', () => {
    const run = dispatch(domains, ['contract', 'list']);
    assert.equal(run.kind === 'run' && run.domain.name, 'contact');
    assert.equal(text(dispatch(domains, ['dance'])), '没有 dance。试 yoyo find dance');
    assert.equal(text(dispatch(domains, ['inspect'])), '没有 。试 yoyo find ');
    assert.match(text(dispatch(domains, ['alarm', 'dance'])), /^yoyo alarm <动作>/);
  });

  test('只有一个 now 动作的领域可以直接跑，参数照样带上', () => {
    const run = dispatch(domains, ['listen', '--seconds', '3']);
    assert.equal(run.kind, 'run');
    if (run.kind === 'run') {
      assert.equal(run.verb.name, 'now');
      assert.deepEqual(run.flags, { seconds: '3' });
    }
  });

  test('--key 后面没有值就记成 true', () => {
    assert.deepEqual(parseArgs(['alarm', 'add', '--title', '喝水', '--force', '--time', '15:30']), {
      position: ['alarm', 'add'],
      flags: { title: '喝水', force: true, time: '15:30' },
    });
  });
});
