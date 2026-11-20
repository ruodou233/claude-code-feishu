# 飞书遥控 Claude Code｜Claude Code Remote Control via Feishu/Lark

Continue the same desktop Claude Code session from your phone through Feishu / Lark.

出门前电脑上开的活，到手机上就接不上了？这个项目用飞书把**正在运行的那个 Claude Code 会话**接到手机上：桌面版和终端里每个会话自动在飞书话题群里开一个话题，每轮回复贴进来；你在话题里回一句，就注入那个会话接着干。回到电脑前，对话就在原处，不用再讲一遍前情。

## 离开电脑以后怎么用

- **出门前没干完**：“接着刚才的方案做，先把第一部分完成。”在那个会话的话题里回一句，桌面上的原会话接着干。
- **路上想到新要求**：“刚才那个页面再加一个筛选项。”发进对应话题，Claude 带着已有上下文处理。
- **等长任务出结果**：每轮回复自动贴到飞书，你在电脑上敲的轮次也会回传，不用一直盯着屏幕。
- **几个会话同时在跑**：一个会话一个话题，在哪个话题里说话就指挥哪个会话，结果各回各处。
- **手机上临时开个新活**：在群里发一个新话题，后台起一个命令行会话去做，在同一话题里接着聊。

项目为中国大陆环境而写：官方的 Remote Control、Channels 都要求 claude.ai 账号或 Console API key，用中转或第三方模型服务时用不了；飞书在国内稳定，长连接也不需要公网 IP。

## 三步装好

需要 macOS、Node ≥ 20、[Claude Code](https://claude.com/claude-code)（桌面版或终端版都行），以及一个飞书账号（个人版即可）。

```bash
git clone https://github.com/ruodou233/claude-code-feishu ~/claude-code-feishu
cd ~/claude-code-feishu && npm install
node bridge.mjs setup
```

`setup` 会打印一个链接。在浏览器或飞书手机端打开，点「立即创建」——这用的是飞书官方 CLI 同款的应用注册流程，机器人、消息权限、事件订阅、长连接一次配好，不用进开放平台后台。之后脚本自动建一个话题群「Claude」，你是群主。

**再开一项权限**：一键建的应用只能收到群里 @ 它的消息。想在话题里直接说话、不用每句 @，到 [开放平台](https://open.feishu.cn/app) → 你的应用 → 权限管理，开通「获取群组中所有消息」（`im:message.group_msg`）。个人版免审，开通即生效。不开也能用，每句 @ 一下机器人就行。

```bash
node bridge.mjs install
```

`install` 往 `~/.claude/settings.json` 挂五个钩子（SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd），并注册 launchd 开机自启。之后新开的会话会自动进群；已经开着的会话，下一轮也会自己登记上。

卸载：`node bridge.mjs uninstall`，摘掉钩子和自启，配置留在 `~/.claude/feishu-bridge/`。

整个项目就一个文件 [`bridge.mjs`](bridge.mjs)（约 370 行），唯一依赖是飞书官方 Node SDK。

> 用 CC Switch 之类会改写 `settings.json` 的工具切换供应商时，记得把这五个钩子也加进它的通用配置，否则切换后钩子会丢。

## 原理

```
 桌面版 / 终端的 Claude Code 会话
   │ 钩子：每个事件写一个小文件（会话 id、对话文件路径、收件地址）
   ▼
 bridge.mjs（launchd 常驻，不调用模型）
   ├─ Stop 事件 → 读对话文件，取本轮回复 → 贴进该会话的话题
   └─ 话题里有人回复 → 经会话的收件 socket 注入正在运行的那个会话
   ▲
   │ 飞书长连接（WebSocket，不需要公网 IP）
 手机飞书：话题群「Claude」，一个会话一个话题
```

### 为什么不用 Channels

上一版（v1）基于官方 [Channels](https://code.claude.com/docs/en/channels)：声明 `claude/channel` 的 MCP server 可以把消息推进运行中的会话。实际用下来有三个硬伤：

1. **要官方账号**。Channels 要求 claude.ai 登录或 Console API key，走中转、用第三方模型服务的人用不了。
2. **会话得专门起**。只有带 `--dangerously-load-development-channels` 启动的终端会话才能接，桌面版的会话一个都接不上，每次启动还要过一次警告框。
3. **回信要额外造轮子**。模型只在觉得该回话时才调回复工具，最后还是得靠 Stop 钩子兜底。

这一版换了思路：**Claude Code 每个会话本来就开着一个本地收件 socket**，跨会话消息就是从这里进来的。钩子是会话的子进程，环境里有这个 socket 的地址和令牌，顺手交给转发程序，手机上的消息就能送进任何一个正在运行的会话——桌面版、终端都行，不用改启动方式，也不挑登录方式。

### 实测踩到的坑

- **常驻进程发的消息会被静默丢掉**。收件端会核对发送进程，比会话启动得早的进程发过去，连错误都没有，消息就没了。所以每次注入都现起一个新进程去发（`bridge.mjs inject`），发完再看对话文件里有没有这条，没有就重试一次。
- **注入的消息在 Claude 看来是「另一个会话发来的」**，没法伪装成用户输入。转发程序在消息前加一句说明，请 Claude 当作用户本人的输入正常回复。它不会把这类消息当成批准待确认操作的同意——这是 Claude Code 自己的安全设计，也是对的。
- **`~/.claude/sessions/*.key` 里的令牌发的消息会被丢掉**，只有会话子进程环境里的 `CLAUDE_CODE_MESSAGING_TOKEN` 有效。这也是为什么必须靠钩子来登记。
- **一键建的应用收不到群里的普通消息**，只收 @ 机器人的。要么开 `im:message.group_msg`，要么每句 @。
- **只镜像交互会话**。钩子按 `CLAUDE_CODE_ENTRYPOINT` 只认桌面版（`claude-desktop`、`claude-desktop-3p`）和终端交互（`cli`），外加本程序自己拉起的会话；脚本里的 `claude -p`、Agent SDK 调用不会刷进群。

## 用起来要知道的

- **桌面会话没在运行时**（进程退出了），收件 socket 就没了。这时机器人会回「请在桌面打开它」，不会另起进程续写，免得一份对话分叉成两份。终端会话和手机开的命令行会话则用 `claude -p --resume` 在原对话文件上接着跑。
- **手机开的会话想回桌面版继续**：桌面版菜单 File → Import Claude Code CLI Sessions… 导入，导入后就是普通的桌面会话，话题不变。
- **手机上看到的是每轮里 Claude 写的文字**，工具调用和中间过程不转发；超过 12000 字分几条发。暂时只收文字消息。
- **Mac 睡眠时离线**。转发程序没在跑或断网时，钩子事件攒在 `events/` 里，恢复后按顺序补发（超过一小时的丢弃）。想一直在线，可以 `sudo pmset -c sleep 0`（接电源时不睡）。
- **Claude Code 升级后收件协议如果变了**（现在是 `type:auth` 和 `type:user` 两行 JSON），注入会失败，机器人会回「没在运行」，所以失效时看得出来。这是未公开的内部机制，2.1.3xx 实测可用。

## 安全边界

这东西让一条飞书消息能在你电脑上执行命令，务必想清楚：

- **只认群主本人**。转发程序只处理配置里那个话题群、只认 `owner_open_id`（setup 时由飞书返回，就是扫码的人）。群里拉了别人，他们的消息会被忽略。
- **手机开的新会话默认 `bypassPermissions`**：命令行会话没有人在旁边点确认，不放行就会卡住。想收紧就改 `config.json` 的 `permission_mode`（比如 `acceptEdits`，或配好 `permissions.allow` 后用 `default`）。注入到已有会话的消息，沿用那个会话自己的权限模式。
- **配置里有 App Secret**，`~/.claude/feishu-bridge/` 下的文件都是 600 权限。

## 配置

`~/.claude/feishu-bridge/config.json`，setup 自动生成：

| 字段 | 含义 |
|---|---|
| `app_id` / `app_secret` | 飞书应用凭证 |
| `owner_open_id` | 唯一允许指挥的人 |
| `chat_id` | 话题群 |
| `domain` | `feishu` 或 `lark`（国际版） |
| `claude` | `claude` 命令的路径，手机开新会话时用 |
| `workdir` | 手机开新会话的工作目录，默认家目录 |
| `permission_mode` | 手机开新会话的权限模式，默认 `bypassPermissions` |

同目录下还有 `state.json`（会话 ↔ 话题映射）、`events/`（钩子投递的事件）、`bridge.log`。

```bash
launchctl kickstart -k gui/$(id -u)/com.github.claude-code-feishu   # 重启
tail -f ~/.claude/feishu-bridge/bridge.log                           # 看日志
```

非 macOS：`install` 只挂钩子，转发程序用 systemd、pm2 之类常驻运行 `node bridge.mjs` 即可。

---

# claude-code-feishu (English)

Steer the **same** Claude Code session from your phone through Feishu / Lark: every desktop or terminal session gets its own topic in a Feishu topic group, each turn's reply is posted there, and anything you reply in the topic is injected into that running session.

> Written for users in mainland China. Anthropic's Remote Control and Channels require claude.ai or Console API-key auth and don't work behind third-party gateways; Feishu works reliably there and its long connection needs no public IP.

## Install

```bash
git clone https://github.com/ruodou233/claude-code-feishu ~/claude-code-feishu
cd ~/claude-code-feishu && npm install
node bridge.mjs setup     # open the printed link, click Create — app, bot, scopes, events all preconfigured; a topic group is created
node bridge.mjs install   # adds 5 hooks to ~/.claude/settings.json and a launchd agent
```

Optional: enable `im:message.group_msg` in the developer console so you can talk in topics without @-mentioning the bot.

## How it works

Every Claude Code session already listens on a local inbox socket (that's how cross-session messages arrive). Hooks run as children of the session, so they can see the socket path and the per-session `CLAUDE_CODE_MESSAGING_TOKEN`; they hand both to `bridge.mjs`, a small launchd daemon that holds the Feishu WebSocket. Replies are read from the transcript on `Stop`; phone messages are injected through the socket. No model calls, no Channels, works with the desktop app and with any auth method.

Field notes:

- The inbox silently drops messages from a sender process older than the session, so each injection spawns a fresh `bridge.mjs inject` process and then confirms delivery by checking the transcript.
- Injected messages are presented to Claude as coming from another session, so the bridge prefixes a note asking Claude to treat it as the user's own input. Claude still won't treat it as approval for a pending permission prompt — by design.
- If a desktop session's process has exited there is no socket; the bot asks you to reopen it rather than forking the conversation. Terminal and phone-started sessions resume with `claude -p --resume`.
- This relies on an undocumented internal protocol (tested on Claude Code 2.1.3xx). If it changes, the bot reports the session as not running.

Only the group owner's messages are accepted. Phone-started sessions default to `bypassPermissions`; change `permission_mode` in `~/.claude/feishu-bridge/config.json` to tighten it.

## License

MIT
