/**
 * dsh-pet 独立模式接口的数据形状，照 openapi.yaml 写，只收客户端用得到的字段。
 */

/** 调用方期望的显示端（`SurfaceQuery`）。 */
export type Surface = 'web' | 'desktop' | 'both' | 'any';

/** `/state` 里的一个叶子。`counter` 变了就是更新了；`data` 为 null 表示从没写过。 */
export interface Leaf<T> {
  readonly counter: number;
  readonly data: T | null;
}

/** `pets.<id>.say` 的两种形态：弹气泡（`Say`）或清空（`{ clear: true }`）。 */
export interface SayData {
  readonly text?: string;
  readonly image?: string;
  readonly url?: string;
  readonly duration?: number;
  readonly anim?: boolean;
  readonly clear?: boolean;
}

/** `WorkStatusSnapshot`：state 为 null 是空闲。 */
export interface WorkStatusData {
  readonly state: string | null;
  readonly task: string | null;
}

export interface PetSlots {
  readonly say: Leaf<SayData>;
  readonly anim: Leaf<unknown>;
  readonly position: Leaf<unknown>;
  readonly throw: Leaf<unknown>;
  readonly lock: Leaf<{ readonly locked: boolean; readonly expiresAt?: number }>;
}

/** 统一状态 S。顶层 `counter` 是整份的版本号，长轮询时回传成 `since`。 */
export interface PollState {
  readonly counter: number;
  readonly sections: { readonly workStatus?: Leaf<WorkStatusData>; readonly [name: string]: Leaf<unknown> | undefined };
  /** 键是宠物 id，可含点号，不要切分。 */
  readonly pets: { readonly [id: string]: PetSlots | undefined };
}

/** 桌宠对话记忆里的一条（`GET /chat`）。 */
export interface ChatMemoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** 写入时间（毫秒）。 */
  readonly ts: number;
}

/** `POST /standalone-ai/settings` 的请求体。没给的字段沿用桌宠里已存的值。 */
export interface StandaloneAiInput {
  readonly protocol?: 'openai-compatible' | 'anthropic';
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly enabled?: boolean;
  readonly automaticWhispers?: boolean;
}

/** 桌宠保存后回的公开设置（不含密钥）。 */
export interface StandaloneAiResult {
  readonly enabled: boolean;
  readonly model: string;
  readonly hasKey: boolean;
}
