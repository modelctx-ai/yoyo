import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { resolvePaths } from './paths.ts';

describe('paths', () => {
  test('按键助手缺省编译到数据目录的 bin/，YOYO_HOTKEY 指向编好的', () => {
    const home = join('/tmp', 'yoyo-home');
    assert.equal(resolvePaths({ YOYO_HOME: home }).hotkeyBin, join(home, 'bin', 'yoyo-hotkey'));
    assert.equal(
      resolvePaths({ YOYO_HOME: home, YOYO_HOTKEY: '/opt/yoyo/lib/bin/yoyo-hotkey' }).hotkeyBin,
      '/opt/yoyo/lib/bin/yoyo-hotkey',
    );
  });

  test('配置文件缺省在根目录，YOYO_CONFIG 可以换', () => {
    const paths = resolvePaths({ YOYO_HOME: '/tmp/yoyo-home' });
    assert.equal(paths.configFile, join(paths.root, 'config.json'));
    assert.equal(resolvePaths({ YOYO_CONFIG: '/tmp/c.json' }).configFile, '/tmp/c.json');
  });
});
