import { spawn } from 'node:child_process';

const QUESTION = /[?？]|什么|谁|哪|怎么|如何|为什么|多少|天气|新闻|最新|搜索|查一下|帮我看/;

/** 像在提问或要事实时才去搜，普通应答不搜。 */
export function shouldSearch(text) {
  return QUESTION.test(String(text ?? '').trim());
}

export function clipSearch(markdown, max = 700) {
  return String(markdown ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 调本机 anysearch CLI。密钥只放环境变量，不放进命令参数。
 * command 是 argv 数组，第一项是 node。
 */
export function searchWeb(query, options) {
  const command = options.command?.length ? options.command : ['node', options.script];
  const args = [...command.slice(1), 'search', query, '--max_results', String(options.maxResults ?? 3)];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], args, {
      env: { ...process.env, ANYSEARCH_API_KEY: options.apiKey || process.env.ANYSEARCH_API_KEY || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(err.trim().slice(0, 180) || `anysearch 退出 ${code}`));
      else resolve(clipSearch(out));
    });
  });
}
