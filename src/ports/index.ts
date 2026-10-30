/**
 * 应用依赖的外部能力，只有接口。实现放在 `src/adapters/`，由 `src/app/container.ts` 组装。
 * 换平台、换服务商、写测试替身，都只需要另给一份实现。
 */
import type {
  ActivityEvent,
  ActivityRecord,
  AgentTask,
  AgentTaskInput,
  AgentTaskPatch,
  AgentTaskState,
  Approval,
  ApprovalInput,
  ApprovalPatch,
  ApprovalState,
  Artifact,
  ClipEntry,
  Contact,
  MemePack,
  PetChatMessage,
  PetSaying,
  ScheduleItem,
  SpokenEntry,
  WorkStatus,
} from '../kernel/types.ts';
import type { PaceDecision, PaceInput } from '../kernel/pace.ts';

/** 说完一句碎碎念以后，决定隔多久说下一句。不抛错：没判成就返回 `fallback`。 */
export interface WhisperPacer {
  readonly name: string;
  next(input: PaceInput, signal?: AbortSignal): Promise<PaceDecision>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string): void;
}

// ---------- 舞台：谁来显示气泡和做动作 ----------

export interface StageLine {
  readonly text: string;
  readonly durationMs: number;
  readonly action: string;
  readonly imageUrl?: string;
}

export interface Stage {
  /**
   * 占住舞台，弹气泡、点播动作，然后执行 `during`（通常是播放语音），最后放开。
   * 占不到或气泡失败要抛错；动作失败只告警，不抛错。
   */
  present(line: StageLine, during?: () => Promise<void>): Promise<void>;
  /** 不占舞台地播一段动作，例如开始听之前转向屏幕。失败会 reject，调用方决定是否忽略。 */
  cue(action: string): Promise<void>;
}

export interface ChatBinding {
  /** 桌宠对话要改用的 OpenAI 兼容地址（yoyo 本机网关）。 */
  readonly baseUrl: string;
  readonly model: string;
  /** 给桌宠的密钥。网关模式下是本机临时令牌，不是真密钥。 */
  readonly apiKey: string;
}

/** 桌宠宿主：舞台之外，还有对话记忆、工作状态、右键菜单、气泡变化和对话渠道。 */
export interface PetHost extends Stage {
  readonly name: string;
  chatHistory(rounds: number): Promise<readonly PetChatMessage[]>;
  workStatus(): Promise<WorkStatus | null>;
  /** 注册菜单并持续等待点击，产出被点的菜单项文字，直到 signal 中止。 */
  menu(owner: string, labels: readonly string[], signal: AbortSignal): AsyncIterable<string>;
  /** 持续产出气泡里新出现的句子，直到 signal 中止。第一条是当前已有的那句（initial: true）。 */
  sayings(signal: AbortSignal): AsyncIterable<PetSaying>;
  /** 让桌宠右键对话改走 yoyo 的渠道。返回桌宠确认后的模型名。 */
  bindChat(binding: ChatBinding): Promise<{ readonly model: string }>;
}

// ---------- 声音 ----------

export interface Synthesizer {
  /** 合成并返回音频文件路径。同一句（含情绪标签）走缓存。没配语音时返回空字符串，调用方只出字不播放。 */
  synthesize(text: string, cue: string): Promise<string>;
}

export interface PlayOptions {
  /** 0–1，缺省 1。 */
  readonly volume?: number;
}

export interface AudioPlayer {
  /** 播放到结束。失败要 reject。 */
  play(file: string, options?: PlayOptions): Promise<void>;
  /** 后台播放，不等待、不报错。 */
  fire(file: string, options?: PlayOptions): void;
}

export interface Recorder {
  /** 录 `seconds` 秒到 `file`（16 kHz 单声道 wav），返回文件路径。 */
  record(file: string, seconds: number): Promise<string>;
}

export interface Transcriber {
  /** 识别一段 wav，返回清理过的文字；没听清返回空字符串。 */
  transcribe(file: string): Promise<string>;
}

export interface SfxPlayer {
  /** 按动作放一段很轻的配音。失败不影响台词。 */
  play(action: string): void;
}

// ---------- 系统 ----------

export interface Clipboard {
  /** 当前粘贴板文字；读不到返回空字符串。 */
  read(): string;
}

export interface UrlOpener {
  open(url: string): void;
  /** 在访达里选中这个文件；只有 macOS 有。 */
  reveal?(path: string): void;
}

export interface WebSearch {
  /** 返回压缩成一段的搜索结果文字。 */
  search(query: string, options?: { readonly maxResults?: number }): Promise<string>;
}

// ---------- 本地库 ----------

export interface ContactRepo {
  list(): Contact[];
  insert(contact: Contact): void;
  /** 删掉一个；返回删没删掉。 */
  remove(id: string): boolean;
}

export interface ScheduleRepo {
  /** 按时间排序。 */
  list(): ScheduleItem[];
  insert(item: ScheduleItem): void;
  markFired(id: string, occurrence: string): void;
  /** 删掉一条；返回删没删掉。 */
  remove(id: string): boolean;
}

export interface ClipboardRepo {
  /** 最新的在前，最多 50 条。 */
  list(limit?: number): ClipEntry[];
  /** 写入并只保留最近 50 条。 */
  insert(entry: ClipEntry): void;
}

export interface MemeRepo {
  read(): MemePack | null;
  write(pack: MemePack): void;
}

/** 只看哪几类、哪个时间以前的行为记录。 */
export interface ActivityFilter {
  /** 只要这几种 `type`。 */
  readonly types?: readonly string[];
  /** 只要早于这个 ISO 时间的（不含）。 */
  readonly before?: string;
}

export interface ActivityRepo {
  record(event: ActivityEvent): void;
  /** 最近 `limit` 条（给了 `filter` 就在符合的里面数），按时间从旧到新。 */
  list(limit?: number, filter?: ActivityFilter): ActivityRecord[];
}

export interface SpokenRepo {
  /** 窗口内说过的句子。 */
  recent(now: number, windowMs: number): SpokenEntry[];
  /** 记下一句，同时丢掉窗口外的旧句子。 */
  remember(text: string, at: number, windowMs: number): void;
}

export interface KvRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface TaskRepo {
  list(): string[];
}

/** 子任务，id 从 1 往上数。 */
export interface AgentTaskRepo {
  create(input: AgentTaskInput, now: number): AgentTask;
  get(id: number): AgentTask | null;
  /** 新的在前。 */
  list(options?: { readonly states?: readonly AgentTaskState[]; readonly limit?: number }): AgentTask[];
  /** 改几个字段，顺带记 `updatedAt`；没有这个任务返回 null。 */
  update(id: number, patch: AgentTaskPatch, now: number): AgentTask | null;
}

/** 要主人批准的工具调用，id 从 1 往上数。状态只往前走：等批准 → 批准、拒绝、过期。 */
export interface ApprovalRepo {
  create(input: ApprovalInput, now: number): Approval;
  get(id: number): Approval | null;
  /** 新的在前；给了 `task` 只列这个子任务要的。 */
  list(options?: {
    readonly states?: readonly ApprovalState[];
    readonly task?: number;
    readonly limit?: number;
  }): Approval[];
  /** 等批准的改成 `to`（批准、拒绝、过期）；已经不是等批准的返回 null，常驻进程和命令行同时点不会做两遍。 */
  decide(id: number, to: Exclude<ApprovalState, 'pending'>, now: number, note?: string): Approval | null;
  /** 批准了、还没开始做的：记下开始做的时间并返回它；别处已经领走了返回 null。 */
  claim(id: number, now: number): Approval | null;
  /** 改结果、原因、交回的时间；没有这一条返回 null。 */
  update(id: number, patch: ApprovalPatch): Approval | null;
}

/** 子任务的交付物。同一个子任务里同名的再交一次，原来那条换成新的（编号不变）。 */
export interface ArtifactRepo {
  save(input: Omit<Artifact, 'id'>): Artifact;
  get(id: number): Artifact | null;
  /** 新的在前；给了 `task` 只列这个子任务的。 */
  list(options?: { readonly task?: number; readonly limit?: number }): Artifact[];
  remove(id: number): boolean;
}

/** 交付物的文件，放在 `<目录>/<子任务编号>/<文件名>`。文件名由调用的一方先洗干净。 */
export interface ArtifactFiles {
  /** 写进去（同名覆盖），返回完整路径。 */
  write(task: number, name: string, bytes: Uint8Array): string;
  /** 没有返回 null。 */
  read(task: number, name: string): Uint8Array | null;
  remove(task: number, name: string): void;
  path(task: number, name: string): string;
}

export interface Repos {
  readonly contacts: ContactRepo;
  readonly schedule: ScheduleRepo;
  readonly clipboard: ClipboardRepo;
  readonly memes: MemeRepo;
  readonly activity: ActivityRepo;
  readonly spoken: SpokenRepo;
  readonly kv: KvRepo;
  readonly tasks: TaskRepo;
  readonly agentTasks: AgentTaskRepo;
  readonly artifacts: ArtifactRepo;
  readonly approvals: ApprovalRepo;
}
