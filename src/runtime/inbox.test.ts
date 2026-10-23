import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { directorAlive, drain, enqueue, writePid } from './inbox.ts';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-'));
}

describe('inbox', () => {
  test('请求按先后取出，取一次就清空', () => {
    const file = join(home(), 'nested', 'inbox.jsonl');
    enqueue(file, 'listen');
    enqueue(file, 'whisper');
    const taken = drain(file);
    assert.deepEqual(
      taken.map((message) => message.type),
      ['listen', 'whisper'],
    );
    assert.equal(typeof taken[0]?.at, 'number');
    assert.deepEqual(drain(file), []);
    assert.equal(existsSync(`${file}.taken`), false);
  });

  test('按键助手写的行没有时间，也照样认；坏行和不认识的请求跳过', () => {
    const file = join(home(), 'inbox.jsonl');
    writeFileSync(file, '{"type":"listen"}\n');
    appendFileSync(file, 'not json\n\n{"type":"dance"}\n{"type":"whisper","at":5}\n');
    assert.deepEqual(drain(file), [{ type: 'listen' }, { type: 'whisper', at: 5 }]);
  });

  test('没有收件箱时什么也不取', () => {
    assert.deepEqual(drain(join(home(), 'inbox.jsonl')), []);
  });

  test('pid 文件里的进程活着才算导演在跑', () => {
    const dir = home();
    const pidFile = join(dir, 'director.pid');
    assert.equal(directorAlive(pidFile), false);
    writePid(pidFile);
    assert.equal(readFileSync(pidFile, 'utf8'), String(process.pid));
    assert.equal(statSync(pidFile).mode & 0o777, 0o600);
    assert.equal(directorAlive(pidFile), true);
    writeFileSync(pidFile, '99999999');
    assert.equal(directorAlive(pidFile), false);
    writeFileSync(pidFile, 'garbage');
    assert.equal(directorAlive(pidFile), false);
    writeFileSync(pidFile, '');
    assert.equal(directorAlive(pidFile), false);
  });
});
