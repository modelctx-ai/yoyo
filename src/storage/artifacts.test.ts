import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createArtifactFiles } from './artifacts.ts';

describe('交付物的文件', () => {
  test('按子任务分目录，只给自己读写；读不到的是 null；删了就没了', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'yoyo-files-')), 'artifacts');
    const files = createArtifactFiles(dir);
    const path = files.write(3, '周报.md', Buffer.from('# 周报'));
    assert.equal(path, join(dir, '3', '周报.md'));
    assert.equal(statSync(join(dir, '3')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(Buffer.from(files.read(3, '周报.md')!).toString('utf8'), '# 周报');
    assert.equal(files.read(3, '没有.md'), null);
    files.remove(3, '周报.md');
    assert.equal(files.read(3, '周报.md'), null);
    files.remove(3, '周报.md');
  });

  test('拼出来的路径出了子任务的目录就报错', () => {
    const files = createArtifactFiles(join(mkdtempSync(join(tmpdir(), 'yoyo-files-')), 'artifacts'));
    for (const name of ['../x.md', '../../x.md', 'a/b.md', '/etc/passwd', '.', '..']) {
      assert.throws(() => files.write(1, name, Buffer.from('x')), /文件名不对/, name);
    }
    assert.throws(() => files.path(0, 'a.md'), /子任务编号不对/);
  });
});
