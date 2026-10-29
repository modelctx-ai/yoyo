/**
 * 开桌宠（dsh-pet 独立模式），参数原样交过去（`--check`、`--port`）。
 * 先按 config.json 的 `pet.menu` 设好菜单的环境变量，再加载 dsh-pet 的入口，桌宠在这个进程里跑。
 * 入口缺省用依赖里打过补丁的那份；安装包由启动脚本用 `YOYO_PET_ENTRY` 指到 lib/dsh-pet。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PET_MENU_ENV, petMenuSpec } from './adapters/dsh-pet/patch.ts';
import { loadConfig, parseConfig, type Config } from './app/config.ts';
import { errorText } from './app/log.ts';
import { resolvePaths } from './app/paths.ts';
import { MENU_OWNER } from './runtime/daemon.ts';

function readConfig(): Config {
  try {
    return loadConfig(resolvePaths().configFile);
  } catch (error) {
    // 桌宠不靠配置也能开：读不到就按缺省的菜单
    console.error(`${errorText(error)}；右键菜单按缺省排`);
    return parseConfig({});
  }
}

function petEntry(): string {
  const entry = process.env['YOYO_PET_ENTRY'];
  if (entry) return entry;
  return join(dirname(fileURLToPath(import.meta.resolve('dsh-pet/package.json'))), 'lib', 'standalone.js');
}

process.env[PET_MENU_ENV] ??= petMenuSpec(readConfig().pet.menu, MENU_OWNER);
await import(pathToFileURL(petEntry()).href);
