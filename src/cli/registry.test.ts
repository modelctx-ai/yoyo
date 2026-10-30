import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { agentDomains, dispatch, findDomains, inspectText, parseArgs, type Domain } from './registry.ts';

const noop = (): void => {};

const domains: Domain[] = [
  {
    name: 'alarm',
    summary: '闹钟和周期性日程',
    detail: '到点后 15 分钟内说一次。',
    verbs: [
      { name: 'list', summary: '列出日程', agent: true, run: noop },
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
  {
    name: 'search',
    summary: '在 yoyo 的数据里找',
    fallback: 'all',
    verbs: [{ name: 'all', summary: '哪儿都找', usage: '<词>', agent: true, run: noop }],
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
        'search     在 yoyo 的数据里找',
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

  test('动作后面的位置参数交给动作；inspect 列出写法', () => {
    const memory: Domain = {
      name: 'memory',
      summary: '桌宠记住的事',
      verbs: [{ name: 'forget', summary: '删一条', usage: '<id>', flags: ['force'], run: noop }],
    };
    const run = dispatch([memory], ['memory', 'forget', 'f-1', '--force']);
    assert.equal(run.kind, 'run');
    if (run.kind === 'run') {
      assert.deepEqual(run.args, ['f-1']);
      assert.deepEqual(run.flags, { force: true });
    }
    const plain = dispatch(domains, ['alarm', 'list']);
    assert.deepEqual(plain.kind === 'run' && plain.args, []);
    assert.match(inspectText(memory), /forget +删一条\n +<id> --force/);
  });

  test('领域后面不是动作的词交给 fallback 动作：yoyo search 周报 就是 yoyo search all 周报', () => {
    for (const argv of [
      ['search', '周报', '本周'],
      ['search', 'all', '周报', '本周'],
    ]) {
      const run = dispatch(domains, [...argv, '--limit', '3']);
      assert.equal(run.kind === 'run' && run.verb.name, 'all');
      assert.deepEqual(run.kind === 'run' && run.args, ['周报', '本周']);
    }
    assert.match(text(dispatch(domains, ['search'])), /^yoyo search <动作>/);
  });

  test('agent 只看得到、只调得了标了 agent 的动作', () => {
    const visible = agentDomains(domains);
    assert.deepEqual(
      visible.map((domain) => [domain.name, domain.verbs.map((verb) => verb.name)]),
      [
        ['alarm', ['list']],
        ['search', ['all']],
      ],
    );
    assert.equal(text(dispatch(visible, [])).includes('clip'), false);
    assert.match(text(dispatch(visible, ['alarm', 'add'])), /^yoyo alarm <动作>\n\nlist/);
    assert.match(text(dispatch(visible, ['listen'])), /^没有 listen/);
    assert.match(text(dispatch(visible, ['inspect', 'alarm'])), /list +列出日程$/m);
    assert.equal(dispatch(visible, ['search', '周报']).kind, 'run');
  });

  test('--key 后面没有值就记成 true', () => {
    assert.deepEqual(parseArgs(['alarm', 'add', '--title', '喝水', '--force', '--time', '15:30']), {
      position: ['alarm', 'add'],
      flags: { title: '喝水', force: true, time: '15:30' },
    });
  });
});
