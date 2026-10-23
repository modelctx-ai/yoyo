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

## 运行

复制 `config.example.json` 为 `config.json`，填上 Fish Audio 的 `apiKey` 和 `referenceId`。`config.json` 不进版本库。

```sh
npm test
npm run bake    # 把固定台词预先合成到 ~/.yoyo/speech-cache
npm start       # 马上说一句，之后按 intervalSec 重复，默认 5 分钟
npm run once    # 只说一句
```

工作日 17:00–18:59 每天先报一次未来几小时的天气。地点优先读 `~/.yoyo/place.json`。没有这个文件时，按系统时区选城市（这台机器的 `Asia/Taipei` 会用台北）。不在那个城市，就改 `place.json` 里的 `name`、`latitude`、`longitude`。

语气按钟点选：凌晨和深夜平静，早上和晚上温和，上午中午明快，下午活泼。每档里大约一半概率抽一段稍长的笑话。
