yoyo：让桌宠 dsh-pet 真正陪着你。

这个目录里什么都带着：yoyo、桌宠、Node、录音和听写的程序、听写模型。不用另外安装。

第一次用

1. 打开「终端」，进到这个目录，运行：

     ./yoyo start

   第一次会把示例配置放到 ~/.yoyo/config.json，然后停下。

2. 在 ~/.yoyo/config.json 里填上 Fish Audio 的 speech.apiKey 和 speech.referenceId。
   想让模型现写碎碎念、回复你，再填 llm 的 baseUrl、apiKey、model。

3. 再运行一次 ./yoyo start。桌宠出来、开口说话就好了。Control+C 停下，桌宠一起关掉。

第一次听你说话时，系统会问终端能不能用麦克风；第一次按 Control+Option+Y 时，会要终端的「辅助功能」权限。

常用命令

  ./yoyo start          桌宠没开就先开桌宠，再常驻
  ./yoyo once           只说一句
  ./yoyo log tail       最近做过的事
  ./yoyo                全部命令

开关

说完要不要听你回应（listen.enabled）、报天气（weather.enabled）、表情包（memes.enabled）、
动作音效（sfx.enabled）、读粘贴板（clipboard.enabled）、快捷键（hotkey.enabled）都在 config.json 里，
写 true 或 false。改完重新 ./yoyo start。

换新版本

下载新的压缩包，解压，替换掉这个目录。配置和数据都在 ~/.yoyo，不受影响。

完整说明：https://github.com/modelctx-ai/yoyo/blob/main/docs/product/getting-started.md
各个程序的许可在 lib/licenses/，版本在 lib/VERSIONS.txt。
