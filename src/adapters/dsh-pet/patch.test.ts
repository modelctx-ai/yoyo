import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, test } from 'vite-plus/test';

import { parseConfig } from '../../app/config.ts';
import { petMenuSpec } from './patch.ts';

// 依赖里的 dsh-pet 装的时候已经打了补丁；这里直接跑补丁带进去的那段菜单代码
const helperDir = join(
  dirname(fileURLToPath(import.meta.resolve('dsh-pet/package.json'))),
  'runtime',
  'electron-helper',
);

interface Arranged {
  top: { label: string; action: string; owner: string }[];
  tools: { label: string; action?: string }[];
  items: { owner: string; label: string }[];
}

const TOOLS = [
  { label: '打开网站', action: 'open-site' },
  { label: '查看余额', action: 'show-balance' },
  { label: '碎碎念', action: 'whisper' },
  { label: '对话', action: 'chat' },
  { label: '显示位置', children: [] },
];
const ITEMS = [
  { owner: 'yoyo', label: '碎碎念' },
  { owner: 'yoyo', label: '听一句' },
  { owner: 'other', label: '别的' },
];

function arrange(spec: string | null): Arranged {
  const source = readFileSync(join(helperDir, 'yoyo-menu.js'), 'utf8');
  const query = spec === null ? '' : `?yoyoMenu=${encodeURIComponent(spec)}`;
  const sandbox = { params: new URLSearchParams(query), tools: TOOLS, items: ITEMS };
  // 结果来自另一个 realm，转一道 JSON 再比
  return JSON.parse(runInNewContext(`${source}\nJSON.stringify(yoyoArrangeMenu(tools, items))`, sandbox)) as Arranged;
}

describe('桌宠补丁', () => {
  test('补丁打进了依赖里的 dsh-pet', () => {
    assert.match(readFileSync(join(helperDir, 'sprite.js'), 'utf8'), /yoyoArrangeMenu\(tools, this\.menuItems\)/);
    assert.match(readFileSync(join(helperDir, 'main.js'), 'utf8'), /yoyoMenu: process\.env\.YOYO_PET_MENU/);
    const html = readFileSync(join(helperDir, 'index.html'), 'utf8');
    const menuScript = html.indexOf('<script src="./yoyo-menu.js">');
    assert.ok(
      menuScript > 0 && menuScript < html.indexOf('<script src="./sprite.js">'),
      'yoyo-menu.js 要在 sprite.js 之前加载',
    );
  });

  test('缺省藏掉网站、余额和桌宠自己的碎碎念，yoyo 的项提到第一层', () => {
    const arranged = arrange(petMenuSpec(parseConfig({}).pet.menu, 'yoyo'));
    assert.deepEqual(
      arranged.top.map((node) => [node.label, node.action, node.owner]),
      [
        ['碎碎念', 'third-party', 'yoyo'],
        ['听一句', 'third-party', 'yoyo'],
      ],
    );
    assert.deepEqual(
      arranged.tools.map((node) => node.label),
      ['对话', '显示位置'],
    );
    assert.deepEqual(arranged.items, [{ owner: 'other', label: '别的' }]);
  });

  test('top 关掉、hide 写空：只是原样', () => {
    const arranged = arrange(petMenuSpec(parseConfig({ pet: { menu: { hide: [], top: false } } }).pet.menu, 'yoyo'));
    assert.deepEqual(arranged.top, []);
    assert.equal(arranged.tools.length, TOOLS.length);
    assert.equal(arranged.items.length, ITEMS.length);
  });

  test('没设或写坏了：和上游一样', () => {
    for (const spec of [null, '', '不是 JSON', '42']) {
      const arranged = arrange(spec);
      assert.deepEqual(arranged.top, []);
      assert.equal(arranged.tools.length, TOOLS.length);
      assert.equal(arranged.items.length, ITEMS.length);
    }
  });
});
