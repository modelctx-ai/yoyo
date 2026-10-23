// 第一条：先装警告过滤，再加载用到 node:sqlite 的模块（静态 import 按顺序执行）
import './app/warnings.ts';

import { mkdirSync } from 'node:fs';

import { assertDirectorReady, loadConfig } from './app/config.ts';
import { createApp } from './app/container.ts';
import { errorText } from './app/log.ts';
import { resolvePaths } from './app/paths.ts';
import { runDaemon } from './runtime/daemon.ts';
import { writePid } from './runtime/inbox.ts';

const once = process.argv.includes('--once');
const bake = process.argv.includes('--bake');

try {
  const paths = resolvePaths();
  const config = loadConfig(paths.configFile);
  assertDirectorReady(config);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  writePid(paths.pidFile);
  const app = await createApp(config, paths);
  await runDaemon(app, { once, bake });
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
