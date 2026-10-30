/**
 * 先问：开关是 `ask` 的工具（`files.read`、`write`、`edit`、`bash`）不当场做，记成一条批准请求，
 * 等主人在工作台里批准或拒绝。这里是不碰模型和文件的那部分：建请求、批准、拒绝、过期，每一步先查状态对不对，
 * 还有给人看（命令行）和给模型看（交回主线程的话、转告、子任务的回答）的文字。工具、常驻进程、命令行和工作台走同一套，规则只有一份。
 * 批准只是放行：照原参数做一次，做之前范围规则还会再查一遍，批准不能扩大范围。
 */
import { TONE_CUES, toneForHour } from '../../kernel/tone.ts';
import type { Approval, ApprovalState, Line } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';

export const SUMMARY_MAX = 200;
/** 交回主线程的结果最多多少字；再长的留头尾，全文在批准请求里。 */
export const RESULT_KEEP = 4000;
/** 交回等批准的子任务的话最多多少字（所有请求合在一起）。 */
export const TASK_ANSWER_KEEP = 12_000;
/** 子任务提问里列出的请求最多多少字。 */
const QUESTION_KEEP = 560;

/** 规则不让做的事：一句话说清楚。工具把它交回模型，命令行打出来。 */
export class ApprovalError extends Error {}

export const STATE_LABELS: Readonly<Record<ApprovalState, string>> = {
  pending: '等批准',
  approved: '批准了',
  denied: '拒绝了',
  expired: '过期了',
};

type ApprovalRepos = Pick<Repos, 'approvals' | 'activity'>;

export interface NewApproval {
  readonly tool: string;
  readonly summary: string;
  /** 工具的参数，存成 JSON。 */
  readonly input: unknown;
  readonly task: number | null;
  readonly runId?: string | undefined;
}

/** 谁要的：主线程那一轮，或者哪个子任务。 */
export function originOf(approval: Pick<Approval, 'task'>): string {
  return approval.task === null ? '主线程' : `子任务 #${approval.task}`;
}

/** 记一条等批准的请求。 */
export function requestApproval(repos: ApprovalRepos, input: NewApproval, now: Date): Approval {
  const summary = input.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
  const approval = repos.approvals.create(
    {
      tool: input.tool,
      summary,
      input: JSON.stringify(input.input),
      task: input.task,
      runId: input.runId ?? null,
    },
    now.getTime(),
  );
  repos.activity.record({
    type: 'approval-ask',
    id: approval.id,
    tool: approval.tool,
    text: summary,
    ...(approval.task !== null ? { task: approval.task } : {}),
  });
  return approval;
}

function found(repos: ApprovalRepos, id: number): Approval {
  const approval = Number.isInteger(id) ? repos.approvals.get(id) : null;
  if (!approval) throw new ApprovalError(`没有批准请求 #${id}`);
  return approval;
}

/** 主人批准或拒绝：只对等批准的有效。`via` 记是在哪里点的（`web`、`cli`）。 */
export function decideApproval(
  repos: ApprovalRepos,
  id: number,
  verdict: 'approved' | 'denied',
  now: Date,
  via: string,
): Approval {
  const before = found(repos, id);
  const decided = repos.approvals.decide(id, verdict, now.getTime());
  if (!decided) throw new ApprovalError(`批准请求 #${id} 已经「${STATE_LABELS[before.state]}」，不能再改`);
  repos.activity.record({
    type: verdict === 'approved' ? 'approval-approve' : 'approval-deny',
    id,
    tool: decided.tool,
    text: decided.summary,
    via,
  });
  return decided;
}

/** 没等到：按拒绝算，不做。`note` 说原因。 */
export function expireApproval(repos: ApprovalRepos, id: number, note: string, now: Date): Approval | null {
  const expired = repos.approvals.decide(id, 'expired', now.getTime(), note);
  if (expired) {
    repos.activity.record({ type: 'approval-expire', id, tool: expired.tool, text: expired.summary, note });
  }
  return expired;
}

/** 等批准等了多久还没批，算过期。`timeoutMs` 为 0 不过期。 */
export function approvalTimedOut(approval: Pick<Approval, 'state' | 'createdAt'>, now: number, timeoutMs: number) {
  return approval.state === 'pending' && timeoutMs > 0 && now - approval.createdAt >= timeoutMs;
}

export function timeoutNote(timeoutMs: number): string {
  const hours = Math.round((timeoutMs / 3_600_000) * 10) / 10;
  return `等了 ${hours} 小时没批准`;
}

/** 批准了、还没做完（没开始，或者开始了还没回话）。 */
export function running(approval: Pick<Approval, 'state' | 'result'>): boolean {
  return approval.state === 'approved' && approval.result === null;
}

/** 有结论了：拒绝、过期，或者批准了而且做完了。 */
export function settled(approval: Pick<Approval, 'state' | 'result'>): boolean {
  return (
    approval.state === 'denied' || approval.state === 'expired' || (approval.state === 'approved' && !running(approval))
  );
}

/** 太长的留头尾，中间写省略了多少字。 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n……中间省略了 ${text.length - max} 字……\n${text.slice(-tail)}`;
}

/** 列表里的一行：编号、状态、工具、谁要的、摘要。 */
export function approvalRow(approval: Approval): string {
  return `#${approval.id}\t${STATE_LABELS[approval.state]}\t${approval.tool}\t${originOf(approval)}\t${approval.summary}`;
}

/** 参数摊开成一行行：`键：值`，多行的值另起一段。 */
export function inputLines(approval: Pick<Approval, 'input'>): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(approval.input);
  } catch {
    return [approval.input];
  }
  if (typeof parsed !== 'object' || parsed === null) return [String(parsed)];
  return Object.entries(parsed).flatMap(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.includes('\n') ? [`${key}：`, text] : [`${key}：${text}`];
  });
}

/** 一条请求的全部：命令行的 `approval show` 用它，主线程经 `yoyo` 工具看到的也是这段。 */
export function approvalDetail(approval: Approval): string {
  const parts = [
    `#${approval.id} ${approval.summary}（${STATE_LABELS[approval.state]}，${approval.tool}，${originOf(approval)}）`,
    '',
    '参数：',
    ...inputLines(approval),
  ];
  if (approval.note) parts.push('', `没做：${approval.note}`);
  if (approval.result) parts.push('', '结果：', approval.result);
  return parts.join('\n');
}

/** 给模型的话：主线程那一轮调了要批准的工具，记下了，先别当作做完。 */
export function mainReply(approval: Approval): string {
  return (
    `这件事要主人在工作台里批准才会做：「${approval.summary}」（批准请求 #${approval.id}）。已经记下，现在还没做。` +
    `告诉主人去工作台批准（桌宠右键「管理」，在「待批准」里点批准或拒绝）；批准以后 yoyo 会照做，结果会回到这里。` +
    `别说成已经做了，也别为同一件事再调一遍。`
  );
}

/** 给模型的话：子任务里调了要批准的工具，子任务进入等回答，这一轮到此为止。 */
export function taskReply(approval: Approval): string {
  return (
    `这件事要主人批准才会做：「${approval.summary}」（批准请求 #${approval.id}），现在还没做。` +
    `子任务 #${approval.task ?? ''} 进入等回答，主人批准或拒绝以后接着做，结果写在下一条消息里。` +
    `这一轮到此为止：别再调别的工具，直接结束；也别为同一件事再调一遍。`
  );
}

/** 子任务提问的内容：把等批准的几件事列出来，主人在工作台里看到的就是这句。 */
export function approvalQuestion(pending: readonly Pick<Approval, 'id' | 'summary'>[]): string {
  const lines = pending.map((item) => `#${item.id} ${item.summary}`);
  const text = `想做下面这${pending.length > 1 ? '几件' : '件'}事，要你批准（在工作台的「待批准」里点批准或拒绝）：\n${lines.join('\n')}`;
  return text.length > QUESTION_KEEP ? `${text.slice(0, QUESTION_KEEP)}……` : text;
}

/** 做完以后写回主会话的那一段：主线程据此告诉主人。 */
export function approvalNote(approval: Approval): string {
  const head = `批准请求 #${approval.id}「${approval.summary}」`;
  if (approval.state === 'approved') {
    return `${head}：主人在工作台里批准了，已经照做。\n结果：\n${clip(approval.result ?? '', RESULT_KEEP)}`;
  }
  if (approval.state === 'denied') return `${head}：主人在工作台里拒绝了，没有做。`;
  return `${head}：${approval.note ?? '没等到主人批准'}，没有做。`;
}

/** 主线程被叫醒时收到的话：通知本身，加上该怎么转告。 */
export function approvalRelayPrompt(approval: Approval): string {
  const parts = [
    '<approval-notification>',
    `<id>${approval.id}</id>`,
    `<status>${approval.state}</status>`,
    `<tool>${approval.tool}</tool>`,
    `<summary>${approval.summary}</summary>`,
  ];
  if (approval.result) parts.push(`<result>\n${clip(approval.result, RESULT_KEEP)}\n</result>`);
  if (approval.note) parts.push(`<note>${approval.note}</note>`);
  parts.push('</approval-notification>');
  const how =
    approval.state === 'approved'
      ? '你之前想做的这件事，主人在工作台里批准了，已经照做。用一两句话把结果告诉主人，挑最要紧的说；细节在结果里，不用全念。'
      : approval.state === 'denied'
        ? '你之前想做的这件事，主人在工作台里拒绝了，没有做。用一句话告诉主人没做，问问要不要换个办法；别自己再试一遍。'
        : '你之前想做的这件事，主人一直没批准，已经过期，没有做。用一句话告诉主人没做，要做的话再说一声。';
  return `${parts.join('\n')}\n\n${how}`;
}

/** 转告没成（模型出错）时桌宠说的那句：只报一声，结果在主线程和工作台里。 */
export function approvalAnnounceLine(approval: Approval, now: Date): Line {
  const tone = toneForHour(now.getHours());
  const text =
    approval.state === 'approved'
      ? `「${approval.summary}」照你批准的做好了，结果在工作台里。`
      : approval.state === 'denied'
        ? `「${approval.summary}」你没批准，我就没做。`
        : `「${approval.summary}」没等到你批准，没做。`;
  return { text, tone, cue: TONE_CUES[tone], action: '碎碎念-对屏碎碎念', kind: 'reminder' };
}

/** 回给等批准的子任务的话：每一件做了没有、结果是什么。 */
export function approvalAnswer(approvals: readonly Approval[]): string {
  const each = Math.floor((TASK_ANSWER_KEEP - 500) / Math.max(1, approvals.length));
  return approvals
    .map((item) => {
      const head = `批准请求 #${item.id}「${item.summary}」`;
      if (item.state === 'approved') return `${head}：主人批准了，已经照做。结果：\n${clip(item.result ?? '', each)}`;
      if (item.state === 'denied') {
        return `${head}：主人没批准，没有做。别再试同一件事：换个办法，做不了就用 task_fail 说明。`;
      }
      return `${head}：${item.note ?? '没等到主人批准'}，没有做。`;
    })
    .join('\n\n');
}
