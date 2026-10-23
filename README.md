# yoyo

个人桌宠导演。dsh-pet 保持官方行为，只负责显示气泡和播放动作。说什么、用什么语气、配哪段动作、语音怎么合成，都在这个仓库里决定。

## 它怎么驱动宠物

桌宠需要已经用官方独立模式跑起来，例如：

```sh
cd /path/to/dsh-pet/dsh-pet
npm run build && npm run standalone
```

独立模式的写接口要带本机令牌。yoyo 每次从 `~/.dsh/dsh-pet/standalone-runtime.json` 读取，不把令牌抄进自己的配置。

yoyo 只调用这些官方接口：

1. `POST /lock` 占住这只宠物，避免它自己的事件插进来。
2. `POST /broadcast` 投喂台词。`anim` 固定为 `false`，不让它从碎碎念池里随机抽动作。
3. `POST /anim` 点名播放和这句话匹配的动作。
4. 本机 `afplay` 播放事先合成好的 mp3。天气这种当场才知道的句子，第一次会现合成，之后同一句走缓存。
5. `POST /lock/release` 放开。

`/whisper` 和 `/chat` 不调用。独立模式下那两条本来也不会生成文字。

## 命令

设计原则在 [docs/cli-principles.md](docs/cli-principles.md)。运行时怎么让路、听写、记日志，在 [docs/runtime-principles.md](docs/runtime-principles.md)。文档索引是 [docs/index.md](docs/index.md)。

顶层只列领域，不把参数一次倒出来。要看某个领域怎么用，再 `inspect`。

```sh
node bin/yoyo.js
node bin/yoyo.js alarm
node bin/yoyo.js alarm add --title 喝水 --time 15:30 --repeat daily
node bin/yoyo.js inspect alarm
node bin/yoyo.js find 粘贴
node bin/yoyo.js contact list
node bin/yoyo.js clip history
node bin/yoyo.js listen
node bin/yoyo.js whisper
```

`contact` 也可以写成 `contract`。`listen` 和 `whisper` 只有一个动作，所以不用再写 `now`。导演正在跑的时候，这两条交给它，不会再开一个进程去抢桌宠。

右键菜单的 yoyo 分组里有「碎碎念」和「听一句」。宠物原来的「碎碎念」仍然只打到它自己的接口，独立模式下不会叫到 yoyo。主动听语音也可以按 Control+Option+Y，这需要系统允许辅助功能。

粘贴板有变化就记进 `~/.yoyo/clipboard.json`。生成碎碎念或回复时会带上最近一条。这不是系统级的全部复制历史，只包括 yoyo 运行期间看到的变化。

## 运行

复制 `config.example.json` 为 `config.json`，填上 Fish Audio 的 `apiKey` 和 `referenceId`。`config.json` 不进版本库。

```sh
npm test
npm run bake    # 把固定台词预先合成到 ~/.yoyo/speech-cache
npm start       # 马上说一句，之后按 intervalSec 重复，默认 5 分钟
npm run once    # 只说一句
```

工作日 17:00–18:59 每天先报一次未来几小时的天气。地点优先读 `~/.yoyo/place.json`。没有这个文件时，按系统时区选城市（这台机器的 `Asia/Taipei` 会用台北）。不在那个城市，就改 `place.json` 里的 `name`、`latitude`、`longitude`。

语气按钟点选：凌晨和深夜平静，早上和晚上温和，上午中午明快，下午活泼。每档里大约一半概率抽一段稍长的笑话。同一句在 3 小时内不会再说。预制台词用完后，用 `config.json` 里的 `llm` 按最近碎碎念、桌宠对话和任务再写一句。任务可以来自宠物的工作状态，也可以写在 `~/.yoyo/tasks.json` 的 `items` 数组里。地点在 `~/.yoyo/place.json`。

`listen.enabled` 打开后，碎碎念和模型现写的话念完会用麦克风听 5 秒，宠物同时面向你。素材里没有「侧耳听」这段动画，默认播 `碎碎念-对屏碎碎念`，可用 `listen.action` 改。识别用本机的 Whisper tiny（`~/.yoyo/models/ggml-tiny.bin`，由 `whisper-cli` 加载）。听写结果先弹出确认页，发送按钮倒计时 3 秒，没人动就用原文发送；有鼠标、键盘或改字就停下，等你自己发送或取消。听起来像提问时，用本机 anysearch 搜一下再回复。天气播报和闹钟不听。把 `listen.enabled` 设为 `false` 就关掉。

日常碎碎念如果 30 秒内还有别的对话或提醒，就顺延到那些话停下来之后 30 秒。中间又说话，就再顺延一次。

每个动作会同时放一段很轻的配音，写代码是轻轻的按键，伸懒腰是一声拉长，发呆几乎听不见。音量大约是说话的两成。

联系人记在 `~/.yoyo/contacts.json`。现在只保存名字和对方的 yoyo 地址，后面用这个地址去联系别人的 yoyo。

```sh
node src/main.js contacts
node src/main.js contact-add --name 小王 --yoyo yoyo://xiaowang@example --note 同事
```

日程记在 `~/.yoyo/schedule.json`。可以是每天、每个工作日、每周某天，或某一天的一次闹钟。到点后 15 分钟内会说一次。

```sh
node src/main.js alarms
node src/main.js alarm-add --title 喝水 --time 15:30 --repeat daily
node src/main.js alarm-add --title 周报 --time 18:00 --repeat weekdays --kind task
node src/main.js alarm-add --title 开会 --time 09:30 --date 2026-10-24
```

说过的话、听写、搜索、提醒、顺延、加联系人、加日程，都追加在 `~/.yoyo/activity.jsonl`。
