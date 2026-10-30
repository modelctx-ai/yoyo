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

  test('从 yoyo.app 里跑时认得出 app 在哪，进程号记在数据目录', () => {
    const home = join('/tmp', 'yoyo-home');
    assert.equal(resolvePaths({ YOYO_HOME: home }).appBundle, null);
    const paths = resolvePaths({ YOYO_HOME: home, YOYO_APP: '/Applications/yoyo.app' });
    assert.equal(paths.appBundle, '/Applications/yoyo.app');
    assert.equal(paths.appPidFile, join(home, 'app.pid'));
  });
});
