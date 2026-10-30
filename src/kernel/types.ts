/**
 * yoyo 的领域类型。这里只有类型，不依赖任何 IO，所有层都可以引用。
 */

/** 四档语气，按钟点选。 */
export type Tone = 'lively' | 'warm' | 'calm' | 'brisk';

/**
 * 一句台词从哪来：
 * - `whisper` 预制碎碎念
 * - `generated` 模型现写的碎碎念
 * - `reply` 听写之后模型的回复
 * - `weather` 快下班天气
 * - `reminder` 闹钟和任务提醒
 */
export type LineKind = 'whisper' | 'generated' | 'reply' | 'weather' | 'reminder';

/** 要表演的一句话。 */
export interface Line {
  readonly text: string;
  readonly tone: Tone;
  /** Fish Audio S2 句首情绪标签，例如 `[happy]`。 */
  readonly cue: string;
  /** dsh-pet 动作池里的名字，由导演点播。 */
  readonly action: string;
  readonly kind: LineKind;
  /** 随气泡显示的表情包地址。 */
  readonly imageUrl?: string;
}

/** 已经说过的句子，3 小时内不再抽。 */
export interface SpokenEntry {
  readonly text: string;
  readonly at: number;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  /** 对方 yoyo 的地址，例如 `yoyo://xiaowang@example`。 */
  readonly yoyo: string;
  readonly note: string;
  readonly createdAt: string;
}

export interface ContactInput {
  readonly name?: string;
  readonly yoyo?: string;
  readonly note?: string;
}

export type ScheduleKind = 'alarm' | 'task';
export type Repeat = 'daily' | 'weekdays' | 'weekly';

export interface ScheduleItem {
  readonly id: string;
  readonly title: string;
  readonly kind: ScheduleKind;
  /** `HH:MM`。 */
  readonly time: string;
  /** 一次性日程的日期 `YYYY-MM-DD`；周期日程为 null。 */
  readonly date: string | null;
  readonly repeat: Repeat | null;
  /** `weekly` 用，0 是周日。 */
  readonly weekday: number | null;
  readonly enabled: boolean;
  /** 最近一次响过的那一次：`YYYY-MM-DDTHH:MM`。 */
  readonly lastFired: string | null;
}

export interface ScheduleInput {
  readonly title?: string;
  readonly time?: string;
  readonly date?: string | null;
  readonly repeat?: string | null;
  readonly weekday?: number;
  readonly kind?: string;
}

/** 改一条日程：没写的项不动。`repeat` 写 null 或空是改成一次性（要有日期）。 */
export interface SchedulePatch {
  readonly title?: string;
  readonly time?: string;
  readonly date?: string | null;
  readonly repeat?: string | null;
  readonly weekday?: number | null;
  readonly kind?: string;
  /** false 是暂停，true 是恢复。 */
  readonly enabled?: boolean;
}

/** yoyo 运行期间看到的一次粘贴板变化。 */
export interface ClipEntry {
  readonly text: string;
  /** ISO 时间。 */
  readonly at: string;
}

export interface MemeItem {
  readonly url: string;
}

export interface MemePack {
  /** ISO 时间。 */
  readonly fetchedAt: string;
  readonly query: string;
  readonly items: readonly MemeItem[];
}

export interface Place {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface WeatherHour {
  readonly hour: number;
  readonly tempC: number;
  readonly rainPct: number;
  readonly code: number;
}

export type ActivityValue = string | number | boolean | null | undefined;

/** 一条行为记录。`type` 之外的字段原样存进 payload；不写密钥。 */
export interface ActivityEvent {
  readonly type: string;
  readonly [field: string]: ActivityValue;
}

export interface ActivityRecord extends ActivityEvent {
  /** ISO 时间。 */
  readonly at: string;
}

/** 桌宠对话记忆里的一条。 */
export interface PetChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** 写入时间（毫秒）。 */
  readonly ts: number;
}

export interface WorkStatus {
  readonly state: string | null;
  readonly task: string | null;
}

/** 桌宠气泡里出现的一句话。`initial` 是启动时已经在气泡里的那句。 */
export interface PetSaying {
  readonly text: string;
  readonly initial: boolean;
}

/** 从命令行或按键交给导演的请求。 */
export type InboxRequest = 'listen' | 'whisper';

export interface InboxMessage {
  readonly type: InboxRequest;
  readonly at?: number;
}

/** 子任务的状态：排队、在做、等回答、做完、没做成、取消。 */
export type AgentTaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
/** 子任务里一项 todo 的状态。 */
export type TodoState = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface Todo {
  readonly text: string;
  readonly state: TodoState;
  /** 做完或跳过时的一句说明。 */
  readonly note?: string;
}

/** 验收时逐条对的结果。 */
export interface CriterionCheck {
  readonly criterion: string;
  readonly met: boolean;
  readonly evidence: string;
}

/** 主线程派给子 agent 的一件事：目标、验收标准，做的时候自己拆成 todo，做完交回结果。 */
export interface AgentTask {
  readonly id: number;
  readonly title: string;
  readonly goal: string;
  /** 验收标准，一条一句。 */
  readonly criteria: readonly string[];
  /** 哪种子 agent 来做，见 `features/tasks/agents.ts`。 */
  readonly agent: string;
  readonly state: AgentTaskState;
  readonly todos: readonly Todo[];
  readonly result: string | null;
  readonly checks: readonly CriterionCheck[];
  readonly error: string | null;
  /** 谁开的：`main`（主线程的工具）、`cli`、`web`。 */
  readonly origin: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly updatedAt: number;
  /** 做完以后告诉过主人没有。 */
  readonly announcedAt: number | null;
  /** 子 agent 最近问的那个问题；`waiting` 时是在等回答的那个，之后留着。 */
  readonly question: string | null;
  readonly askedAt: number | null;
  /** 主人对那个问题的回答；问了新问题就清掉。 */
  readonly answer: string | null;
  readonly answeredAt: number | null;
  /** 那个问题转告过主人没有；问了新问题就清掉。 */
  readonly questionAnnouncedAt: number | null;
}

export interface AgentTaskInput {
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly agent: string;
  readonly origin: string;
}

/** 子任务交的文件：存在 `artifacts/<子任务>/<文件名>`，同一个子任务里文件名不重复。 */
export interface Artifact {
  readonly id: number;
  readonly task: number;
  readonly name: string;
  /** content-type，按扩展名定。 */
  readonly type: string;
  /** 字节数。 */
  readonly size: number;
  readonly createdAt: number;
}

/** 要主人批准的一次工具调用：等批准、批准了、拒绝了、过期了。 */
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * 模型调了开关是 `ask` 的工具（`files.read`、`write`、`edit`、`bash`）：不当场做，记成一条等主人在工作台里批准。
 * 批准了由常驻进程照原参数做一次，结果交回主线程（或等批准的子任务）。
 */
export interface Approval {
  readonly id: number;
  /** 工具名：`read`、`write`、`edit`、`bash`。 */
  readonly tool: string;
  /** 给人看的一句：「写 notes/周报.md（新建，12 行）」「跑命令：python plot.py」。 */
  readonly summary: string;
  /** 完整参数，JSON。 */
  readonly input: string;
  /** 子任务里要的是哪个子任务；主线程那一轮是 null。 */
  readonly task: number | null;
  /** 哪一轮要的（运行编号），记下来对账；没有就是 null。 */
  readonly runId: string | null;
  readonly state: ApprovalState;
  readonly createdAt: number;
  /** 批准、拒绝或过期的时间。 */
  readonly decidedAt: number | null;
  /** 开始照做的时间；批准了才有，进程停在中途也留着，不会做第二遍。 */
  readonly ranAt: number | null;
  /** 照做以后工具回的话。 */
  readonly result: string | null;
  /** 过期的原因，例如等太久、子任务已经取消。 */
  readonly note: string | null;
  /** 结果交回主线程（或子任务）的时间。 */
  readonly announcedAt: number | null;
}

export interface ApprovalInput {
  readonly tool: string;
  readonly summary: string;
  readonly input: string;
  readonly task: number | null;
  readonly runId: string | null;
}

/** 能改的字段。 */
export type ApprovalPatch = Partial<Pick<Approval, 'result' | 'note' | 'announcedAt'>>;

/** 能改的字段。 */
export type AgentTaskPatch = Partial<
  Pick<
    AgentTask,
    | 'state'
    | 'todos'
    | 'result'
    | 'checks'
    | 'error'
    | 'startedAt'
    | 'finishedAt'
    | 'announcedAt'
    | 'question'
    | 'askedAt'
    | 'answer'
    | 'answeredAt'
    | 'questionAnnouncedAt'
  >
>;
