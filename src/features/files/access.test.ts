import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { checkAccess, inside, type FileRules } from './access.ts';

const RULES: FileRules = {
  workspace: '/home/me/.yoyo/workspace',
  readable: ['/home/me/.yoyo/artifacts', '/home/me/Documents'],
  denied: ['/home/me/.yoyo', '/home/me/.ssh', '/home/me/Documents/secret'],
};

describe('读写文件的范围', () => {
  test('inside：自己和下面的算，名字前缀一样的不算', () => {
    assert.ok(inside('/a/b', '/a/b'));
    assert.ok(inside('/a/b/c.md', '/a/b'));
    assert.ok(!inside('/a/bc', '/a/b'));
    assert.ok(!inside('/a', '/a/b'));
  });

  test('工作区能读能写；只读目录只能读；别处都不行', () => {
    assert.equal(checkAccess(RULES, '/home/me/.yoyo/workspace/notes/a.md', 'write'), null);
    assert.equal(checkAccess(RULES, '/home/me/.yoyo/workspace', 'read'), null);
    assert.equal(checkAccess(RULES, '/home/me/Documents/plan.md', 'read'), null);
    assert.match(checkAccess(RULES, '/home/me/Documents/plan.md', 'write') ?? '', /只能写在工作区里/);
    assert.match(checkAccess(RULES, '/etc/hosts', 'read') ?? '', /读不到工作区和 files\.readable 以外/);
  });

  test('最具体的那条说了算：数据目录不给，它下面的工作区和交付物给；读得到的目录里禁读的那块不给', () => {
    assert.match(checkAccess(RULES, '/home/me/.yoyo/yoyo.db', 'read') ?? '', /不给读写/);
    assert.match(checkAccess(RULES, '/home/me/.yoyo/config.json', 'read') ?? '', /不给读写/);
    assert.equal(checkAccess(RULES, '/home/me/.yoyo/artifacts/3/周报.md', 'read'), null);
    assert.match(checkAccess(RULES, '/home/me/.yoyo/artifacts/3/周报.md', 'write') ?? '', /不给读写/);
    assert.match(checkAccess(RULES, '/home/me/Documents/secret/key.txt', 'read') ?? '', /不给读写/);
    assert.match(checkAccess(RULES, '/home/me/.ssh/id_ed25519', 'read') ?? '', /不给读写/);
  });

  test('一样深时不给', () => {
    const rules: FileRules = { workspace: '/w', readable: ['/r'], denied: ['/r'] };
    assert.match(checkAccess(rules, '/r/a', 'read') ?? '', /不给读写/);
  });
});
