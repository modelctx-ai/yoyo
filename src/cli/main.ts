// 第一条：先装警告过滤，再加载用到 node:sqlite 的模块（静态 import 按顺序执行）
import '../app/warnings.ts';

import { errorText } from '../app/log.ts';
import { resolvePaths } from '../app/paths.ts';
import { buildDomains, createCommandEnv } from './commands.ts';
import { dispatch } from './registry.ts';

const result = dispatch(buildDomains(createCommandEnv(resolvePaths())), process.argv.slice(2));
if (result.kind === 'text') {
  console.log(result.text);
} else {
  try {
    await result.verb.run(result.flags);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
