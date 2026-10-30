// 第一条：先装警告过滤，再加载用到 node:sqlite 的模块（静态 import 按顺序执行）
import '../app/warnings.ts';

import { AGENT_ENV } from '../app/cli.ts';
import { errorText } from '../app/log.ts';
import { resolvePaths } from '../app/paths.ts';
import { buildDomains, createCommandEnv } from './commands.ts';
import { agentDomains, dispatch } from './registry.ts';

const domains = buildDomains(createCommandEnv(resolvePaths()));
// agent 经 `yoyo` 工具来调时只看得到、只调得了标了 agent 的动作
const result = dispatch(process.env[AGENT_ENV] === '1' ? agentDomains(domains) : domains, process.argv.slice(2));
if (result.kind === 'text') {
  console.log(result.text);
} else {
  try {
    await result.verb.run(result.flags, result.args);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
