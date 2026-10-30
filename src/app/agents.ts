/**
 * 读主人自己加的子 agent 类型：`~/.yoyo/agents/*.md`，一个文件一种，格式见 `features/tasks/agents.ts`。
 * 写错的跳过、记一行，别的照用；目录不在就只有内置的。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { AgentFileError, mergeAgents, parseAgentFile, type AgentProfile } from '../features/tasks/agents.ts';
import type { Logger } from '../ports/index.ts';

export function loadAgentProfiles(dir: string, logger: Pick<Logger, 'warn'>): AgentProfile[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return mergeAgents([]);
  }
  const custom: AgentProfile[] = [];
  for (const file of files.toSorted()) {
    const path = join(dir, file);
    try {
      custom.push(parseAgentFile(readFileSync(path, 'utf8'), basename(file, '.md'), path));
    } catch (error) {
      if (!(error instanceof AgentFileError)) throw error;
      logger.warn(`子 agent 文件写得不对，先不用：${error.message}`);
    }
  }
  return mergeAgents(custom);
}
