/**
 * 用 dsh-pet 官方接口当舞台：占锁、投喂文字、点播动作，再读它的对话记忆、工作状态和右键菜单。
 */
import { createPetClient } from '@yoyo/dsh-pet';
import type { PetClient, SayData } from '@yoyo/dsh-pet';

import type { PetConfig } from '../../app/config.ts';
import { errorText } from '../../app/log.ts';
import type { PetChatMessage, PetSaying, WorkStatus } from '../../kernel/types.ts';
import type { Logger, PetHost } from '../../ports/index.ts';

export interface DshPetHostOptions {
  readonly pet: PetConfig;
  readonly logger: Logger;
  /** 测试替身；缺省按 `pet` 建一个，令牌每次从运行状态文件读。 */
  readonly client?: PetClient;
}

/** 气泡里的正文。清空指令（`clear: true`）和空文本不算。 */
function sayText(data: SayData | null | undefined): string {
  if (!data || data.clear === true || typeof data.text !== 'string') return '';
  return data.text.trim();
}

function toChatMessage(item: unknown): PetChatMessage | null {
  if (typeof item !== 'object' || item === null) return null;
  const { role, content, ts } = item as { role?: unknown; content?: unknown; ts?: unknown };
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof content !== 'string' || !content) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return { role, content, ts };
}

export function createDshPetHost(options: DshPetHostOptions): PetHost {
  const { pet, logger } = options;
  const client = options.client ?? createPetClient({ baseUrl: pet.baseUrl, pet: pet.id, surface: pet.surface });

  async function* sayings(signal: AbortSignal): AsyncGenerator<PetSaying, void> {
    let first = true;
    let counter: number | undefined;
    for await (const state of client.watchState(signal)) {
      const leaf = state.pets[pet.id]?.say;
      const seen = typeof leaf?.counter === 'number' ? leaf.counter : undefined;
      if (first) {
        // 启动时气泡里已有的那句：只记基线，交给调用方认领
        first = false;
        counter = seen;
        const text = sayText(leaf?.data);
        if (text) yield { text, initial: true };
        continue;
      }
      if (seen === undefined || seen === counter) continue;
      counter = seen;
      const text = sayText(leaf?.data);
      if (text) yield { text, initial: false };
    }
  }

  return {
    name: 'dsh-pet',

    async present(line, during) {
      const { lockId } = await client.lock();
      try {
        await client.broadcast(lockId, {
          text: line.text,
          durationMs: line.durationMs,
          ...(line.imageUrl ? { imageUrl: line.imageUrl } : {}),
          anim: false,
        });
        try {
          await client.anim(line.action, { lockId });
        } catch (error) {
          logger.warn(`动作没播成（${line.action}）：${errorText(error)}`);
        }
        await during?.();
      } finally {
        await client.release(lockId);
      }
    },

    async cue(action) {
      await client.anim(action);
    },

    async chatHistory(rounds) {
      const messages: readonly unknown[] = await client.chat(rounds);
      return messages.map(toChatMessage).filter((message): message is PetChatMessage => message !== null);
    },

    async workStatus(): Promise<WorkStatus | null> {
      const data = (await client.state()).sections.workStatus?.data;
      if (!data) return null;
      return {
        state: typeof data.state === 'string' ? data.state : null,
        task: typeof data.task === 'string' ? data.task : null,
      };
    },

    menu(owner, labels, signal) {
      return client.watchMenu(owner, labels, {
        target: 'desktop',
        signal,
        onRegistered: () => logger.info(`右键里已有 ${owner}：${labels.join('、')}`),
        onError: (error) => logger.error(`菜单没挂上：${errorText(error)}`),
      });
    },

    sayings,

    async bindChat(binding) {
      const baseUrl = binding.baseUrl.trim().replace(/\/+$/, '');
      if (!baseUrl || !binding.model || !binding.apiKey) throw new Error('config.json 的 llm 不完整');
      // 只接右键对话，不打开桌宠自己的周期碎碎念：碎碎念由 yoyo 发
      const saved = await client.setStandaloneAi({
        protocol: 'openai-compatible',
        baseUrl,
        model: binding.model,
        apiKey: binding.apiKey,
        enabled: true,
        automaticWhispers: false,
      });
      if (!saved.enabled) throw new Error('对话渠道没有接上');
      return { model: saved.model || binding.model };
    },
  };
}
