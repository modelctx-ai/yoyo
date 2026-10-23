/**
 * 预制碎碎念。句首标签来自 Fish Audio S2 的方括号情绪。
 * action 是 dsh-pet 动作池里的名字，由导演另外点播，不交给宠物随机抽。
 */

export const TONE_CUES = {
  lively: '[happy]',
  warm: '[relaxed]',
  calm: '[calm]',
  brisk: '[confident]',
};

/** @typedef {'lively' | 'warm' | 'calm' | 'brisk'} Tone */

/**
 * @typedef {Object} Line
 * @property {string} text
 * @property {Tone} tone
 * @property {string} cue
 * @property {string} action
 */

/** @type {readonly Line[]} */
export const LINES = [
  { text: '主人，我在这儿呢', tone: 'lively', cue: '[happy]', action: '碎碎念-对屏碎碎念' },
  { text: '嘿嘿，看我一眼嘛', tone: 'lively', cue: '[happy]', action: '照镜子' },
  { text: '今天的你也很棒', tone: 'lively', cue: '[delighted]', action: '工作状态-雀跃庆祝' },
  { text: '我在给你加油呢', tone: 'lively', cue: '[excited]', action: '点击回应-元气挥手' },
  { text: '想吃点甜的了', tone: 'lively', cue: '[curious]', action: '吃冰淇淋融化' },
  { text: '我偷偷伸了个懒腰', tone: 'lively', cue: '[happy]', action: '超大伸懒腰' },
  { text: '今天也要乖乖的哦', tone: 'warm', cue: '[relaxed]', action: '女仆屈膝礼仪' },
  { text: '要不要歇一会儿呀', tone: 'warm', cue: '[empathetic]', action: '原地小憩沉眠' },
  { text: '水记得喝一口哦', tone: 'warm', cue: '[relaxed]', action: '碎碎念-对屏碎碎念' },
  { text: '肩膀放松一点嘛', tone: 'warm', cue: '[relaxed]', action: '超大伸懒腰' },
  { text: '你忙你的，我看着', tone: 'warm', cue: '[grateful]', action: '东张西望' },
  { text: '这会儿好安静呀', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念' },
  { text: '我刚刚发了会儿呆', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念' },
  { text: '别皱眉，我在呢', tone: 'calm', cue: '[soft tone]', action: '待机呼吸休闲' },
  { text: '要是累了就靠会儿', tone: 'calm', cue: '[soft tone]', action: '哈欠连天' },
  { text: '有我在，别着急', tone: 'brisk', cue: '[confident]', action: '碎碎念-对屏碎碎念' },
  { text: '先把这一小步做完', tone: 'brisk', cue: '[confident]', action: '写代码' },
  { text: '我在旁边盯着呢', tone: 'brisk', cue: '[confident]', action: '东张西望' },
  {
    text: '讲个小笑话。我说今天一定早睡，桌面上的灰说它先躺下。结果灰赢了，我还在这儿陪你。',
    tone: 'lively',
    cue: '[happy]',
    action: '碎碎念-对屏碎碎念',
  },
  {
    text: '再讲一个。下班前最诚实的话是：这个明天再说。明天的我已经在门口排队，准备抗议。',
    tone: 'warm',
    cue: '[relaxed]',
    action: '碎碎念-对屏碎碎念',
  },
  {
    text: '夜里小声讲一个。有人数星星，数着数着打了个哈欠。星星说，你先睡，今晚我们替你值班。',
    tone: 'calm',
    cue: '[soft tone]',
    action: '碎碎念-发呆碎碎念',
  },
  {
    text: '工作上也有个笑话。进度条走到百分之九十九，剩下那一截叫再看一眼。我帮你盯着，你先保存。',
    tone: 'brisk',
    cue: '[confident]',
    action: '写代码',
  },
];

/** 凌晨、清晨、深夜平静；早上、傍晚、晚上温和；上午、中午明快；下午活泼。 */
export function toneForHour(hour) {
  if (hour < 5 || hour >= 23) return 'calm';
  if (hour < 7) return 'calm';
  if (hour < 9) return 'warm';
  if (hour < 13) return 'brisk';
  if (hour < 17) return 'lively';
  if (hour < 19) return 'warm';
  if (hour < 23) return 'warm';
  return 'calm';
}

/** 短句保持 10 秒。长句按字数把气泡留久一点，上限 40 秒。 */
export function bubbleMs(text) {
  if (text.length <= 20) return 10_000;
  return Math.min(40_000, 8_000 + text.length * 180);
}

/**
 * 只在当前语气里抽，避开上一句。有长句时大约一半概率抽长句。
 * @param {readonly Line[]} lines
 * @param {Tone} tone
 * @param {string | undefined} previous
 * @param {() => number} rand
 * @returns {Line | undefined}
 */
export function pickLine(lines, tone, previous, rand = Math.random) {
  const inTone = lines.filter((line) => line.tone === tone && line.text.trim() !== '');
  const usable = inTone.filter((line) => line.text !== previous);
  const base = usable.length > 0 ? usable : inTone;
  const longer = base.filter((line) => line.text.length >= 24);
  const list = longer.length > 0 && rand() < 0.5 ? longer : base;
  if (list.length === 0) return undefined;
  const index = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[index];
}
