import { spawn } from 'node:child_process';

import type { AnysearchConfig } from '../../app/config.ts';
import type { WebSearch } from '../../ports/index.ts';

/** 搜索结果压成一段，空白合并，最多 max 个字。 */
export function clipSearch(markdown: string, max = 700): string {
  return String(markdown ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 调本机 anysearch CLI。密钥只放环境变量，不放进命令参数。
 * 给了 command（argv 数组）就用它，否则是 `node <script>`。
 */
export function createAnysearch(options: AnysearchConfig): WebSearch {
  return {
    search(query, searchOptions) {
      const command = options.command?.length ? options.command : ['node', options.script];
      const maxResults = searchOptions?.maxResults ?? options.maxResults ?? 3;
      const args = [...command.slice(1), 'search', query, '--max_results', String(maxResults)];
      return new Promise((resolve, reject) => {
        const child = spawn(command[0] ?? 'node', args, {
          env: { ...process.env, ANYSEARCH_API_KEY: options.apiKey || process.env['ANYSEARCH_API_KEY'] || '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          err += chunk;
        });
        child.once('error', reject);
        // 等输出读完再收尾，结果才不会被截断
        child.once('close', (code) => {
          if (code !== 0) reject(new Error(err.trim().slice(0, 180) || `anysearch 退出 ${code}`));
          else resolve(clipSearch(out));
        });
      });
    },
  };
}
