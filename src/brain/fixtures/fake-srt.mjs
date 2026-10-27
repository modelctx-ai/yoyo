#!/usr/bin/env node
// 测试里替 srt 用：收 `[选项…] --settings <文件> -- <命令…>`，把收到的参数和设置文件的内容记一行 JSON 到
// FAKE_SRT_LOG（有这个环境变量时），再原样启动 `--` 后面的命令，stdio 透传，退出码照搬。它什么也不限制。
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = args.slice(0, split);
const command = args.slice(split + 1);
const settingsFile = options[options.indexOf('--settings') + 1];
if (process.env.FAKE_SRT_LOG) {
  const record = { options, command, cwd: process.cwd(), settings: JSON.parse(readFileSync(settingsFile, 'utf8')) };
  appendFileSync(process.env.FAKE_SRT_LOG, `${JSON.stringify(record)}\n`);
}
const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  process.stderr.write(`fake-srt: ${error.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
