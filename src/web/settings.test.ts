import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { MASK, maskSecrets, readSettings, saveSwitches, saveText, unmaskSecrets } from './settings.ts';

const RAW = {
  stage: 'console',
  llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-real', model: 'demo' },
  speech: { apiKey: '', referenceId: 'voice-1' },
  mcpServers: {
    github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp-real', LOG_LEVEL: 'info' } },
    remote: { url: 'https://mcp.example', headers: { Authorization: 'Bearer real' } },
  },
  extra: { keep: true },
};

function configFile(value: unknown = RAW): string {
  const file = join(mkdtempSync(join(tmpdir(), 'yoyo-settings-')), 'config.json');
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('管理页改配置', () => {
  test('名字像密钥的非空字符串打码；空的、别的照旧', () => {
    const masked = maskSecrets(RAW) as typeof RAW;
    assert.equal(masked.llm.apiKey, MASK);
    assert.equal(masked.speech.apiKey, '', '空的没什么可藏');
    assert.equal(masked.speech.referenceId, 'voice-1');
    assert.equal(masked.mcpServers.github.env.GITHUB_TOKEN, MASK);
    assert.equal(masked.mcpServers.github.env.LOG_LEVEL, 'info');
    assert.equal(masked.mcpServers.remote.headers.Authorization, MASK);
  });

  test('交回来还是码的，换回同一位置原来的值；原来那里没有就报错', () => {
    const back = unmaskSecrets(maskSecrets(RAW), RAW);
    assert.deepEqual(back, RAW);
    assert.throws(() => unmaskSecrets({ llm: { token: MASK } }, RAW), {
      message: 'llm.token 还是打码的样子，但原来没有这一项：填上真的值',
    });
  });

  test('读：打过码的原文，开关按缺省值补齐', () => {
    const settings = readSettings(configFile());
    assert.ok(!settings.text.includes('sk-real'));
    assert.ok(!settings.text.includes('ghp-real'));
    assert.ok(settings.text.includes(MASK));
    assert.equal(settings.switches['weather.enabled'], true);
    assert.equal(settings.switches['memory.enabled'], false);
    assert.equal(settings.switches['speech.autoplay'], true);
  });

  test('存整份：没动的密钥还是原来的，改了的存上，认不得的键留着；权限照旧', () => {
    const file = configFile();
    const edited = JSON.parse(readSettings(file).text) as typeof RAW & { intervalSec?: number };
    edited.intervalSec = 600;
    edited.llm.model = 'demo-2';
    saveText(file, JSON.stringify(edited));
    const saved = read(file) as typeof RAW & { intervalSec: number };
    assert.equal(saved.intervalSec, 600);
    assert.equal(saved.llm.model, 'demo-2');
    assert.equal(saved.llm.apiKey, 'sk-real');
    assert.equal(saved.mcpServers.github.env.GITHUB_TOKEN, 'ghp-real');
    assert.deepEqual(saved.extra, { keep: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test('存不进去的都说一句：不是 JSON、不是对象、常驻进程起不来', () => {
    const file = configFile();
    const before = readFileSync(file, 'utf8');
    assert.throws(() => saveText(file, '{'), /^Error: 不是合法的 JSON/);
    assert.throws(() => saveText(file, '[]'), { message: '整份配置要是一个对象' });
    assert.throws(() => saveText(file, JSON.stringify({ stage: 'dsh-pet' })), /speech\.\w+ 还空着/);
    assert.equal(readFileSync(file, 'utf8'), before, '一个字都没改');
  });

  test('存整份时带着读到时的指纹：在别处改过了就不存', () => {
    const file = configFile();
    const { text, version } = readSettings(file);
    assert.match(version, /^[0-9a-f]{16}$/);
    saveSwitches(file, { 'weather.enabled': false });
    assert.throws(() => saveText(file, text, version), {
      message: 'config.json 在别处改过了：刷新一下再改',
      status: 409,
    });
    assert.deepEqual((read(file) as { weather: unknown }).weather, { enabled: false }, '开关没被盖掉');
    const fresh = readSettings(file);
    saveText(file, fresh.text, fresh.version);
  });

  test('只改开关：别的原样留着；不认得的开关、不是 true/false 都不收', () => {
    const file = configFile();
    saveSwitches(file, { 'weather.enabled': false, 'memory.enabled': true });
    const saved = read(file) as typeof RAW & { weather: unknown; memory: unknown };
    assert.deepEqual(saved.weather, { enabled: false });
    assert.deepEqual(saved.memory, { enabled: true });
    assert.equal(saved.llm.apiKey, 'sk-real');
    assert.throws(() => saveSwitches(file, { 'web.enabled': false }), { message: 'web.enabled 不是能直接点的开关' });
    assert.throws(() => saveSwitches(file, { 'sfx.enabled': 'no' }), { message: 'sfx.enabled 只能是 true 或 false' });
  });

  test('config.json 已经坏了：先去编辑器里修', () => {
    const file = configFile();
    writeFileSync(file, '{ "stage": ');
    assert.throws(() => readSettings(file), /^Error: config\.json 现在读不了，先在编辑器里修好/);
  });
});
