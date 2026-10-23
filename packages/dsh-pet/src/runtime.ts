import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 独立模式启动时写下的运行状态文件，里面有写接口要用的令牌。 */
export function defaultRuntimePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['YOYO_PET_RUNTIME'] || join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json');
}

/** 每次都重新读：桌宠重启会换令牌。 */
export function readRuntimeToken(path: string = defaultRuntimePath()): string {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const token = typeof data === 'object' && data !== null ? (data as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || !token) throw new Error('桌宠运行状态里没有令牌，先确认独立模式已经启动');
  return token;
}
