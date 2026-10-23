/**
 * dsh-pet 官方第三方接口。这里只投喂文字和点播动作，不改宠物自己的代码。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function runtimeToken() {
  const path = process.env.YOYO_PET_RUNTIME || join(homedir(), '.dsh', 'dsh-pet', 'standalone-runtime.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data.token !== 'string' || !data.token) throw new Error('桌宠运行状态里没有令牌，先确认独立模式已经启动');
  return data.token;
}

/** 右键「对话」走桌宠自己的接口。这里只把 yoyo 的渠道写进去，不替它生成回复。 */
export function chatSettingsBody(llm) {
  return {
    protocol: 'openai-compatible',
    baseUrl: String(llm.baseUrl ?? '').replace(/\/+$/, ''),
    model: llm.model,
    apiKey: llm.apiKey,
    enabled: true,
    automaticWhispers: false,
  };
}

export async function syncChatChannel(pet, llm, fetcher = fetch) {
  const body = chatSettingsBody(llm);
  if (!body.baseUrl || !body.model || !body.apiKey) throw new Error('config.json 的 llm 不完整');
  const origin = new URL(pet.baseUrl).origin;
  const response = await fetcher(`${origin}/standalone-ai/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-pet-token': runtimeToken(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.enabled !== true) {
    throw new Error(data.message || data.error || `对话渠道没有接上（${response.status}）`);
  }
  return { model: data.model, hasKey: data.hasKey === true };
}

export function createPet(pet) {
  const root = pet.baseUrl.replace(/\/+$/, '');

  async function post(path, body) {
    const response = await fetch(`${root}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-pet-token': runtimeToken(),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { ok: false, reason: 'bad-response', message: raw.slice(0, 180) };
      }
    }
    if (!response.ok) {
      throw new Error(`dsh-pet ${response.status} ${path}`);
    }
    return data;
  }

  async function get(path, timeoutMs = 15_000) {
    const response = await fetch(`${root}${path}`, {
      headers: { 'x-dsh-pet-token': runtimeToken() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`dsh-pet ${response.status} ${path}`);
    return response.json();
  }

  function query(extra = '') {
    const params = new URLSearchParams({ pet: pet.id, surface: pet.surface });
    if (extra) params.set('lock', extra);
    return `?${params.toString()}`;
  }

  return {
    async lock() {
      const data = await post(`/lock${query()}`, {});
      if (!data.ok || typeof data.lockId !== 'string') {
        throw new Error(data.message || data.reason || '拿不到桌宠占用锁');
      }
      return data.lockId;
    },
    async release(lockId) {
      await post(`/lock/release${query()}`, { lockId }).catch(() => {});
    },
    async broadcast(lockId, text, durationMs, imageUrl) {
      const body = { text, anim: false, duration: durationMs };
      if (imageUrl) body.url = imageUrl;
      const data = await post(`/broadcast${query(lockId)}`, body);
      if (!data.ok) throw new Error(data.message || data.reason || '投喂失败');
    },
    get,
    async anim(lockId, name) {
      const data = await post(`/anim${query(lockId)}`, { name });
      if (!data.ok) throw new Error(data.message || data.reason || `动作不在池内：${name}`);
      return data.playbackId;
    },
  };
}
