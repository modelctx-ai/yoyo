import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import type { AnysearchConfig } from '../../app/config.ts';
import { clipSearch, createAnysearch } from './anysearch.ts';

/** 假的 anysearch：把收到的参数和密钥原样打印出来。 */
const PRINT = 'console.log(JSON.stringify({ argv: process.argv.slice(1), key: process.env.ANYSEARCH_API_KEY }))';

function config(overrides: Partial<AnysearchConfig>): AnysearchConfig {
  return { script: '', apiKey: '', maxResults: 3, ...overrides };
}

async function withEnv<T>(changes: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(changes);
  try {
    return await work();
  } finally {
    apply(saved);
  }
}

describe('anysearch', () => {
  test('结果压成一段，空白合并，最多 700 字', () => {
    assert.equal(clipSearch('  # 标题\n\n- 第一条\t结果  \n'), '# 标题 - 第一条 结果');
    assert.equal(clipSearch('字'.repeat(800)).length, 700);
    assert.equal(clipSearch('abcdef', 3), 'abc');
  });

  test('给了 command 就照它的 argv 调，密钥只走环境变量', async () => {
    const search = createAnysearch(config({ apiKey: 'k-1', command: [process.execPath, '-e', PRINT] }));
    assert.deepEqual(JSON.parse(await search.search('今天 海淀 天气')), {
      argv: ['search', '今天 海淀 天气', '--max_results', '3'],
      key: 'k-1',
    });
  });

  test('每次调用可以改条数', async () => {
    const search = createAnysearch(config({ maxResults: 2, command: [process.execPath, '-e', PRINT] }));
    const { argv } = JSON.parse(await search.search('可爱表情包 png', { maxResults: 5 })) as { argv: string[] };
    assert.deepEqual(argv, ['search', '可爱表情包 png', '--max_results', '5']);
  });

  test('没给 command 就是 node <script>', async () => {
    const script = join(mkdtempSync(join(tmpdir(), 'yoyo-')), 'anysearch.mjs');
    writeFileSync(script, PRINT);
    const path = [dirname(process.execPath), process.env['PATH']].filter(Boolean).join(delimiter);
    const result = await withEnv({ PATH: path }, () => createAnysearch(config({ script, command: [] })).search('新闻'));
    assert.deepEqual(JSON.parse(result).argv, [script, 'search', '新闻', '--max_results', '3']);
  });

  test('配置里没密钥就用环境变量里的', async () => {
    const search = createAnysearch(config({ command: [process.execPath, '-e', PRINT] }));
    assert.equal(JSON.parse(await withEnv({ ANYSEARCH_API_KEY: 'env-key' }, () => search.search('q'))).key, 'env-key');
    assert.equal(JSON.parse(await withEnv({ ANYSEARCH_API_KEY: undefined }, () => search.search('q'))).key, '');
  });

  test('退出码不是 0 时报 stderr，没有就报退出码', async () => {
    const noisy = createAnysearch(
      config({ command: [process.execPath, '-e', "process.stderr.write('搜索服务挂了\\n'); process.exit(2)"] }),
    );
    await assert.rejects(noisy.search('q'), { message: '搜索服务挂了' });
    const quiet = createAnysearch(config({ command: [process.execPath, '-e', 'process.exit(4)'] }));
    await assert.rejects(quiet.search('q'), { message: 'anysearch 退出 4' });
  });
});
