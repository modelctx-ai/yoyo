import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** yoyo 读写的所有位置。测试时用 `YOYO_HOME`、`YOYO_CONFIG` 指到临时目录。 */
export interface Paths {
  /** 仓库根目录。 */
  readonly root: string;
  readonly configFile: string;
  /** 本地数据目录，缺省 `~/.yoyo`。 */
  readonly dataDir: string;
  readonly dbFile: string;
  readonly inboxFile: string;
  readonly pidFile: string;
  readonly speechCacheDir: string;
  readonly sfxDir: string;
  readonly modelsDir: string;
  readonly binDir: string;
  /** 按键助手。缺省第一次启动时从 `hotkeySource` 编译到 `bin/yoyo-hotkey`；`YOYO_HOTKEY` 指向编好的（安装包里带的）。 */
  readonly hotkeyBin: string;
  readonly hotkeySource: string;
  /** 从 yoyo.app 里跑时是这个 app 的位置（启动脚本给 `YOYO_APP`），别的时候是 null。 */
  readonly appBundle: string | null;
  /** yoyo.app 的外壳在跑时写下自己的进程号，更新时要等它退出。 */
  readonly appPidFile: string;
  /** 主人自己加的子 agent 类型，一个 `.md` 一种。 */
  readonly agentsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dataDir = env['YOYO_HOME'] || join(homedir(), '.yoyo');
  return {
    root,
    configFile: env['YOYO_CONFIG'] || join(root, 'config.json'),
    dataDir,
    dbFile: join(dataDir, 'yoyo.db'),
    inboxFile: join(dataDir, 'inbox.jsonl'),
    pidFile: join(dataDir, 'director.pid'),
    speechCacheDir: join(dataDir, 'speech-cache'),
    sfxDir: join(dataDir, 'sfx'),
    modelsDir: join(dataDir, 'models'),
    binDir: join(dataDir, 'bin'),
    hotkeyBin: env['YOYO_HOTKEY'] || join(dataDir, 'bin', 'yoyo-hotkey'),
    hotkeySource: join(root, 'src', 'adapters', 'platform', 'hotkey.swift'),
    appBundle: env['YOYO_APP'] || null,
    appPidFile: join(dataDir, 'app.pid'),
    agentsDir: join(dataDir, 'agents'),
  };
}
