import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { MASK, maskSecrets, readSettings, saveFields, saveSwitches, saveText, unmaskSecrets } from './settings.ts';

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
    assert.equal(settings.switches['app.launchAtLogin'], false);
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
    saveSwitches(file, { 'weather.enabled': false, 'memory.enabled': true, 'app.launchAtLogin': true });
    const saved = read(file) as typeof RAW & { weather: unknown; memory: unknown; app: unknown };
    assert.deepEqual(saved.weather, { enabled: false });
    assert.deepEqual(saved.app, { launchAtLogin: true });
    assert.equal(readSettings(file).switches['app.launchAtLogin'], true);
    assert.deepEqual(saved.memory, { enabled: true });
    assert.equal(saved.llm.apiKey, 'sk-real');
    assert.throws(() => saveSwitches(file, { 'web.enabled': false }), { message: 'web.enabled 不是能直接点的开关' });
    assert.throws(() => saveSwitches(file, { 'sfx.enabled': 'no' }), { message: 'sfx.enabled 只能是 true 或 false' });
  });

  test('表单：读到各项现在的值（按缺省值补齐），密钥只给码，没填的是空', () => {
    const { fields, text } = readSettings(configFile());
    assert.equal(fields['llm.model'], 'demo');
    assert.equal(fields['llm.baseUrl'], 'https://llm.example/v1');
    assert.equal(fields['llm.provider'], 'openai-compatible');
    assert.equal(fields['llm.apiKey'], MASK);
    assert.equal(fields['speech.apiKey'], '');
    assert.equal(fields['speech.referenceId'], 'voice-1');
    assert.equal(fields['speech.tone'], '');
    assert.equal(fields['intervalSec'], 300);
    assert.deepEqual(fields['pace.options'], [300, 900, 1800, 3600]);
    assert.equal(fields['pace.recent'], 6);
    assert.ok(!JSON.stringify(fields).includes('sk-real'));
    assert.ok(!text.includes('sk-real'));
  });

  test('表单：只改白名单里写了的项，其余的内容、键的顺序、认不得的键都不动', () => {
    const file = configFile();
    const before = read(file) as typeof RAW;
    saveFields(file, {
      'llm.model': ' demo-2 ',
      'llm.provider': 'anthropic',
      'speech.referenceId': 'voice-2',
      'speech.tone': 'calm',
      intervalSec: 600,
      'pace.recent': 0,
    });
    const saved = read(file) as typeof RAW & { intervalSec: number; speech: Record<string, unknown> };
    assert.equal(saved.llm.model, 'demo-2', '去掉首尾空白');
    assert.equal((saved.llm as Record<string, unknown>)['provider'], 'anthropic');
    assert.equal(saved.llm.apiKey, 'sk-real');
    assert.equal(saved.llm.baseUrl, before.llm.baseUrl);
    assert.deepEqual(saved.speech, { apiKey: '', referenceId: 'voice-2', tone: 'calm' });
    assert.equal(saved.intervalSec, 600);
    assert.deepEqual((saved as unknown as { pace: unknown }).pace, { recent: 0 });
    assert.deepEqual(saved.mcpServers, before.mcpServers);
    assert.deepEqual(saved.extra, before.extra);
    assert.deepEqual(Object.keys(saved), [...Object.keys(before), 'intervalSec', 'pace']);
    assert.deepEqual(Object.keys(saved.llm), ['baseUrl', 'apiKey', 'model', 'provider']);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // 语气留空：是不指定，把这一项拿掉
    saveFields(file, { 'speech.tone': '' });
    assert.deepEqual((read(file) as typeof saved).speech, { apiKey: '', referenceId: 'voice-2' });
    // 几档间隔去重排序
    saveFields(file, { 'pace.options': [1800, 300, 300, 900] });
    assert.deepEqual((read(file) as unknown as { pace: unknown }).pace, { recent: 0, options: [300, 900, 1800] });
  });

  test('表单的密钥：交回码或不交就还是原来的；换新的才存；交空是清掉；读出来的永远是码', () => {
    const file = configFile();
    saveFields(file, { 'llm.apiKey': MASK, 'llm.model': 'demo-3' });
    assert.equal((read(file) as typeof RAW).llm.apiKey, 'sk-real', '码不当成新密钥');
    saveFields(file, { 'llm.model': 'demo-4' });
    assert.equal((read(file) as typeof RAW).llm.apiKey, 'sk-real');
    saveFields(file, { 'llm.apiKey': ' sk-new ' });
    assert.equal((read(file) as typeof RAW).llm.apiKey, 'sk-new');
    assert.equal(readSettings(file).fields['llm.apiKey'], MASK);
    assert.ok(!JSON.stringify(readSettings(file)).includes('sk-new'));
    saveFields(file, { 'llm.apiKey': '' });
    assert.equal((read(file) as typeof RAW).llm.apiKey, '');
    assert.equal(readSettings(file).fields['llm.apiKey'], '');
    // 原来没有的，交回码是错的：不能把码当密钥存
    assert.throws(() => saveFields(file, { 'speech.apiKey': MASK }), {
      message: 'speech.apiKey 还是打码的样子，但原来没有这一项：填上真的值',
    });
  });

  test('表单写错：每一项说清楚是哪一项，错的不写，文件一个字不改，也不把值带进报错', () => {
    const file = configFile();
    const before = readFileSync(file, 'utf8');
    const cases: [Record<string, unknown>, string][] = [
      [{ 'web.port': 1 }, 'web.port 不是能在表单里改的项'],
      [{ mcpServers: {} }, 'mcpServers 不是能在表单里改的项'],
      [{ 'llm.provider': 'openai' }, 'llm.provider 只能是 openai-compatible 或 anthropic'],
      [{ 'llm.baseUrl': 'llm.example' }, 'llm.baseUrl 要以 http:// 或 https:// 开头，或者留空'],
      [{ 'llm.model': 3 }, 'llm.model 要是一段文字'],
      [{ 'llm.apiKey': 12345 }, 'llm.apiKey 要是一段文字'],
      [{ 'llm.tools': 'yes' }, 'llm.tools 只能是 true 或 false'],
      [{ 'speech.tone': 'angry' }, 'speech.tone 只能是 lively、warm、calm、brisk，或者留空'],
      [{ intervalSec: 30 }, 'intervalSec 要是 60 到 86400 之间的秒数'],
      [{ intervalSec: '600' }, 'intervalSec 要是 60 到 86400 之间的秒数'],
      [{ 'pace.options': [300] }, 'pace.options 要有 2 到 8 档，每档是 60 到 86400 之间的整数秒'],
      [{ 'pace.options': [300, 30] }, 'pace.options 要有 2 到 8 档，每档是 60 到 86400 之间的整数秒'],
      [{ 'pace.recent': 21 }, 'pace.recent 要是 0 到 20 之间的整数'],
      [{ 'pace.recent': 1.5 }, 'pace.recent 要是 0 到 20 之间的整数'],
      [{}, '没有要改的项'],
    ];
    for (const [values, message] of cases) {
      assert.throws(() => saveFields(file, values), { message, status: 400 }, JSON.stringify(values));
    }
    // 几项一起错：都说，且好的那项也不写
    assert.throws(() => saveFields(file, { 'llm.model': 'ok', intervalSec: 1, 'pace.recent': 99 }), {
      message: 'intervalSec 要是 60 到 86400 之间的秒数；pace.recent 要是 0 到 20 之间的整数',
    });
    assert.equal(readFileSync(file, 'utf8'), before, '一个字都没改');
    // 密钥写错的报错里没有值
    assert.throws(
      () => saveFields(file, { 'llm.apiKey': 12345 }),
      (error: Error) => !error.message.includes('12345'),
    );
  });

  test('表单：常驻进程起不来的配置不存；指纹对不上回 409，不盖掉别处刚改的', () => {
    const file = configFile();
    const before = readFileSync(file, 'utf8');
    const dsh = configFile({ stage: 'dsh-pet', speech: { apiKey: 'k', referenceId: 'r' } });
    assert.throws(() => saveFields(dsh, { 'speech.referenceId': '' }), /speech\.referenceId 还空着/);
    assert.equal(read(dsh)['stage'], 'dsh-pet');
    assert.equal((read(dsh).speech as { referenceId: string }).referenceId, 'r', '没存');

    const { version } = readSettings(file);
    assert.match(version, /^[0-9a-f]{16}$/);
    saveSwitches(file, { 'weather.enabled': false });
    assert.throws(() => saveFields(file, { 'llm.model': 'x' }, version), {
      message: 'config.json 在别处改过了：刷新一下再改',
      status: 409,
    });
    assert.equal((read(file) as typeof RAW).llm.model, 'demo', '没存');
    assert.notEqual(readFileSync(file, 'utf8'), before);
    saveFields(file, { 'llm.model': 'x' }, readSettings(file).version);
    assert.equal((read(file) as typeof RAW).llm.model, 'x');
    assert.deepEqual((read(file) as unknown as { weather: unknown }).weather, { enabled: false }, '开关还在');
  });

  test('config.json 已经坏了：先去编辑器里修', () => {
    const file = configFile();
    writeFileSync(file, '{ "stage": ');
    assert.throws(() => readSettings(file), /^Error: config\.json 现在读不了，先在编辑器里修好/);
  });
});
