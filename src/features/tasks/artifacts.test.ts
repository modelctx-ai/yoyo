import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { memoryRepos } from '../../runtime/testing.ts';
import { createArtifactFiles } from '../../storage/artifacts.ts';
import {
  ARTIFACT_MAX,
  ARTIFACTS_PER_TASK,
  artifactName,
  artifactType,
  artifactView,
  deliverArtifact,
  removeArtifact,
} from './artifacts.ts';
import { createAgentTask, relayPrompt, resultNote, taskDetail, taskNotification } from './tasks.ts';

const NOW = new Date(2026, 9, 30, 15, 0, 0);

function rig() {
  const repos = memoryRepos({ now: () => NOW });
  const files = createArtifactFiles(join(mkdtempSync(join(tmpdir(), 'yoyo-artifacts-')), 'artifacts'));
  const task = createAgentTask(repos, { title: '整理周报', goal: '本周进展', origin: 'main' }, NOW);
  repos.agentTasks.update(task.id, { state: 'running' }, NOW.getTime());
  return { repos, files, task };
}

describe('交付物', () => {
  test('文件名只留最后一段，去掉控制字符；空的、. 开头的、太长的不收', () => {
    assert.equal(artifactName('../../etc/周报.md'), '周报.md');
    assert.equal(artifactName('C:\\\\Users\\\\x\\\\对比.csv'), '对比.csv');
    assert.equal(artifactName(' 周\u0000报.md '), '周报.md');
    assert.throws(() => artifactName('a/'), /不能空着/);
    assert.throws(() => artifactName('..'), /不能以 \. 开头/);
    assert.throws(() => artifactName('.env'), /不能以 \. 开头/);
    assert.throws(() => artifactName(`${'长'.repeat(101)}.md`), /太长/);
    assert.throws(() => artifactName(3), /不能空着/);
  });

  test('类型按扩展名；文本和图片能直接看，HTML、SVG 和别的只给下载', () => {
    assert.equal(artifactType('周报.MD'), 'text/markdown');
    assert.equal(artifactType('图.png'), 'image/png');
    assert.equal(artifactType('没扩展名'), 'application/octet-stream');
    assert.deepEqual(
      ['a.md', 'a.csv', 'a.json', 'a.png', 'a.html', 'a.svg', 'a.pdf', 'a.bin'].map((name) =>
        artifactView(artifactType(name)),
      ),
      ['text', 'text', 'text', 'image', 'file', 'file', 'file', 'file'],
    );
  });

  test('交给在做的子任务：写进它自己的目录，记一条；同名的换成新的，编号不变', () => {
    const { repos, files, task } = rig();
    const first = deliverArtifact(repos, files, { id: task.id, name: '../周报.md', content: '# 周报\nA' }, NOW);
    assert.deepEqual(first, {
      id: first.id,
      task: task.id,
      name: '周报.md',
      type: 'text/markdown',
      size: Buffer.byteLength('# 周报\nA'),
      createdAt: NOW.getTime(),
    });
    assert.equal(files.path(task.id, '周报.md').endsWith(join('artifacts', String(task.id), '周报.md')), true);
    assert.equal(Buffer.from(files.read(task.id, '周报.md')!).toString('utf8'), '# 周报\nA');

    const later = new Date(NOW.getTime() + 1000);
    const again = deliverArtifact(repos, files, { id: task.id, name: '周报.md', content: '# 新的' }, later);
    assert.equal(again.id, first.id);
    assert.equal(again.size, Buffer.byteLength('# 新的'));
    const png = deliverArtifact(
      repos,
      files,
      { id: task.id, name: '图.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
      NOW,
    );
    assert.equal(png.size, 8);
    assert.deepEqual(
      repos.artifacts.list({ task: task.id }).map((item) => item.name),
      ['周报.md', '图.png'],
    );
  });

  test('交不了的说清楚：没在做、空的、太大、太多', () => {
    const { repos, files, task } = rig();
    const queued = createAgentTask(repos, { title: '别的', goal: '做', origin: 'main' }, NOW);
    assert.throws(() => deliverArtifact(repos, files, { id: queued.id, name: 'a.md', content: 'x' }, NOW), /排队/);
    assert.throws(() => deliverArtifact(repos, files, { id: task.id, name: 'a.md', content: '' }, NOW), /不能空着/);
    assert.throws(
      () => deliverArtifact(repos, files, { id: task.id, name: 'a.md', content: 'x'.repeat(ARTIFACT_MAX + 1) }, NOW),
      /太大了：5 MB，单个最多 5 MB/,
    );
    for (let i = 0; i < ARTIFACTS_PER_TASK; i += 1) {
      deliverArtifact(repos, files, { id: task.id, name: `${i}.md`, content: 'x' }, NOW);
    }
    assert.throws(
      () => deliverArtifact(repos, files, { id: task.id, name: 'more.md', content: 'x' }, NOW),
      /最多交 20 个/,
    );
    assert.equal(
      deliverArtifact(repos, files, { id: task.id, name: '0.md', content: 'y' }, NOW).name,
      '0.md',
      '同名的照换',
    );
  });

  test('删：文件和记录一起删；没有的是 null', () => {
    const { repos, files, task } = rig();
    const item = deliverArtifact(repos, files, { id: task.id, name: '周报.md', content: 'x' }, NOW);
    assert.equal(removeArtifact(repos, files, item.id)?.name, '周报.md');
    assert.equal(files.read(task.id, '周报.md'), null);
    assert.equal(repos.artifacts.get(item.id), null);
    assert.equal(removeArtifact(repos, files, item.id), null);
  });

  test('详情、写回主线程的那条、通知和转告都列出交付物', () => {
    const { repos, task } = rig();
    repos.agentTasks.update(task.id, { state: 'done', result: 'A 上线' }, NOW.getTime());
    const done = repos.agentTasks.get(task.id)!;
    const delivered = [{ name: '周报.md', size: 1536 }];
    assert.match(taskDetail(done, delivered), /\n交付物：\n周报\.md（1\.5 KB）/);
    assert.match(resultNote(done, delivered), /A 上线\n交付物（在工作台里）：周报\.md（1\.5 KB）$/);
    assert.match(taskNotification(done, delivered), /<artifacts>\n周报\.md（1\.5 KB）\n<\/artifacts>/);
    assert.match(relayPrompt(done, delivered), /放在工作台里了/);
    assert.equal(taskNotification(done).includes('<artifacts>'), false);
  });
});
