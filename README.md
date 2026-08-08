# claude-code-lark

出门前电脑上开的活，到手机上就接不上了？这个项目用飞书把**正在运行的那个 Claude Code 会话**接到你手机上——出门用飞书接着指挥，回来切回终端接着敲，始终是同一个会话。

> 为中国大陆环境而写。Anthropic Dispatch、Claude Code Remote Control 和官方 Channels 的
> Telegram / Discord / iMessage 通道在这里都不可靠，飞书是可用的。

## 这是什么 / 解决什么问题

"手机上指挥电脑里的 AI"听起来是一件事，其实是三件：**派活**（人不在电脑前发起任务）、
**回信**（进度和结果回到手机）、**连续性**（同一份工作在电脑和手机之间反复往返）。

前两件不难，社区已有不少方案。难的是第三件，而它恰恰是日常最需要的——你在电脑上想到一半出门，
希望在路上接着推，回来再接着干。

`claude-code-lark` 专门解决第三件。

## 与现有方案的区别：channel 型 vs bridge 型

社区里绝大多数飞书/Telegram 遥控方案是 **bridge 型**：收到消息 → 起一个新的 CLI 进程 → 干完回消息。

```
bridge 型：飞书消息 ──► 新起进程 ──► 回消息 ──► 结束
                       每次都是新会话，接不上你手上的活

channel 型：飞书消息 ──► 推进「已经在跑的那个会话」──► 回消息
                       同一个会话，终端和手机都能喂它
```

bridge 型每次都是**新会话**：你在电脑上干到一半的上下文它接不上，手机上派的活回电脑也是一条孤立记录。
本项目基于 Claude Code 官方的 [Channels](https://code.claude.com/docs/en/channels) 机制——
一个声明了 `claude/channel` capability 的 MCP server 可以把外部事件**推进正在运行的会话**。
官方只提供了 Telegram / Discord / iMessage，这是飞书版的实现。

## 核心功能/亮点

- **同一会话反复往返**：电脑 → 手机 → 电脑 → 手机，上下文不断。这是与 bridge 型方案的根本区别。
- **双向自动同步**：手机发的消息推进会话；会话每轮的回复由 `Stop` hook 自动同步回飞书——
  包括你**在电脑上敲的那些轮次**，不依赖模型"记得"调用回复工具。
- **一个会话 = 一个飞书话题**：多个会话的输出各自独立成话题，不挤在一个消息流里。
  在哪个话题里 `@bot` 说话就指挥哪个会话，回复也回到该话题。
- **按 root_id 路由**：多个会话并存时天然去重，不会一条指令被执行多次。
- **会话跑在真实终端窗口里**：随时切回去直接敲，"回来能继续"才成立。
- **零额外基础设施**：收发消息复用飞书官方 [lark-cli](https://github.com/larksuite/lark-cli)，
  不自建应用凭据管理、不处理 token 刷新、不开公网端口、不需要内网穿透。
- **权限审批可转发到手机**：工具调用需要批准时推到飞书，回 `y` / `n` 即可（也可配置为全自动放行）。

## 三个设计决策（以及为什么）

**1. 会话跑在 Terminal.app 窗口里，不做后台常驻**

连续性要求"回来能接着干"，所以会话必须看得见、能直接敲。后台伪终端能跑但没有窗口；
macOS 自带的 `screen 4.00.03`（2006 年）撑不住现代 TUI——进程起得来，窗口渲染是空的，channel 加载不了
（管道喂 stdin 和 `-X stuff` 两种注入都试过）；`tmux` 可行但要先装包管理器。
最后用 `osascript` 开 Terminal 窗口：零依赖、真 TTY。代价是没有开机自启——
但自启的会话看不见，与"回来能继续"直接冲突。

**2. 回信靠 Stop hook，不靠模型自觉**

给模型一个 `reply` 工具让它"需要时回复"不可靠：它只在**觉得该回话**时才调，
你在电脑上敲的轮次它根本不会想着往手机发。改用每轮必触发的 `Stop` hook，读 transcript 取回复发出去，
确定性的，与模型行为无关。hook 通过 `--settings` 只挂在这个会话上，不污染其它会话。

**3. 一个会话一个话题，按 root_id 认领**

加标题前缀治标不治本——消息仍挤在一个流里。飞书**话题群**才是对应物。
会话首轮结束时发一条消息开话题、记下 `message_id` 作为 root，之后每轮 `reply-in-thread` 挂上去。
你在话题里 `@bot` 时事件带 `root_id`，正好等于那条 root——于是每个 server 只处理自己那份，
顺带解决了多会话并存时的重复消费。

## 实测踩到的坑

调试很久才定位的，写下来省得别人再踩：

**lark-cli**
1. `event consume` 只支持 `--as bot`，默认走 user 身份直接报错。
2. **`consume` 把 stdin EOF 当退出信号**（为 AI 子进程调用设计的防孤儿机制）。
   spawn 时 stdin 用 `'ignore'` 会让它一起来就退出，配合重连逻辑变成死循环。必须 `'pipe'` 并保持打开。
3. 事件载荷**已被扁平化**：`sender_id` 是裸字符串、`content` 是纯文本，
   不是飞书原始 webhook 的嵌套结构。照官方 webhook 文档写解析器会全部落空。

**飞书平台**
4. **用户身份不能给 bot 发私聊**（`code 230001`）——自动化测试只能走群 `@`，但你本人在客户端私聊正常。
5. **群消息必须 `@bot` 才推送事件**（权限是「获取群组中用户@机器人消息」）。私聊没这个限制。

**Claude Code**
6. 自建 channel 注册进全局 `~/.claude.json` 会让**每个** Claude Code 实例（含桌面版）
   都 spawn 一个 server，多份同时消费事件流。要用 `--mcp-config` 指定独立配置。
7. MCP server 被 Claude Code spawn 时 stderr 不可见，没有文件日志无法排障。

## 安装

需要 macOS、Node ≥ 20、[Claude Code](https://claude.com/claude-code)、
[lark-cli](https://github.com/larksuite/lark-cli)（已完成 `auth login`）。

```bash
git clone https://github.com/ruodou233/claude-code-lark
cd claude-code-lark
mkdir -p ~/.claude/channels/lark
cp src/*.mjs ~/.claude/channels/lark/
cp config.example.json ~/.claude/channels/lark/config.json
cp mcp.example.json  ~/.claude/channels/lark/mcp.json
cd ~/.claude/channels/lark && npm install @modelcontextprotocol/sdk zod
```

飞书侧：应用需开启机器人能力、以长连接模式订阅 `im.message.receive_v1`、
具备 `im:message` 与 `im:message:send_as_bot` 权限。

填 `config.json`：

| 字段 | 含义 | 怎么拿 |
|---|---|---|
| `chatId` | 与 bot 的私聊 | `lark-cli im +chat-messages-list --as user --user-id <bot_open_id>`，取 `chat_id` |
| `boardChatId` | 话题群（`--chat-mode topic` 创建） | `lark-cli im +chat-create` 的返回 |
| `allowedSenders` | 允许指挥的人 | `lark-cli auth status` 里的 `openId` |
| `autoApprove` | 是否免审批（默认 false） | 见「安全边界」 |

Stop hook 需挂到会话：基于你现有的 `~/.claude/settings.json` 复制一份，
在 `hooks.Stop` 里加 `node ~/.claude/channels/lark/sync-hook.mjs`，启动时用 `--settings` 指向它。
`bin/claude-lark` 已把这套参数串好：

```bash
cp bin/claude-lark ~/.local/bin/ && chmod +x ~/.local/bin/claude-lark
claude-lark ~/your/project
```

## 安全边界

这套东西让 IM 消息能在你机器上执行命令，务必理解清楚：

- **门禁只有两道**：`allowedSenders`（按 open_id 的发送者白名单）+ 会话/话题匹配。
  白名单必须按**人**配而不能只按会话——群里任何人都能发消息，而能回复的人就能批准工具调用。
- `autoApprove: true` 配合 `--permission-mode bypassPermissions` 意味着**一条 IM 消息可以在你机器上做任何事**，
  没有任何确认。默认 `false`，开启前请确认你清楚代价。审计记录写在 `debug.log`。
- server 只服务 `config.chatId` 一个私聊来源。放开多来源会让"最近一条入站消息的来源"
  在消息交错时把 A 的回复发到 B——私聊内容可能落到群里。

## 已知限制

- 话题里必须 `@bot`（飞书事件权限所致），私聊不用。
- 没有开机自启：会话在 Terminal 窗口里，重启后需手动起。这是换取"看得见"的代价。
- 自建 channel 需 `--dangerously-load-development-channels`，每次启动过一次警告框
  （研究预览期限制，非本项目可控）。
- 只做了 Claude Code。Codex CLI 没有等价的 channel 机制。
- `bin/claude-to-desktop` 用模拟按键执行 `/desktop` 把会话搬进 Claude 桌面版
  （直接往桌面版元数据目录写文件无效，它只认自己写的索引）。靠模拟按键，TUI 改版即失效。

---

# claude-code-lark (English)

Control a **running** Claude Code session from your phone via Feishu/Lark — start work at your desk,
keep steering it from your phone, come back and continue in the same session.

> Written for users in mainland China, where Anthropic Dispatch, Claude Code Remote Control,
> and the official Telegram / Discord / iMessage channels are unreliable, but Feishu/Lark works.

## What problem this solves

"Control your AI from your phone" is really three separate capabilities: **dispatch** (start a task
while away), **replies** (get progress back), and **continuity** (move one piece of work back and
forth between desktop and phone). The first two are well covered by existing projects. The third
is the hard one — and the one you actually need day to day.

## channel-based, not bridge-based

Most Feishu/Telegram remote-control projects are **bridges**: message in → spawn a new CLI process →
reply → exit. Every message starts a *new* session, so it can't pick up the context you already have
open, and work you dispatch from your phone lands as an isolated record on your machine.

This project builds on Claude Code's official [Channels](https://code.claude.com/docs/en/channels):
an MCP server declaring the `claude/channel` capability pushes external events **into a session that
is already running**. Anthropic ships Telegram, Discord and iMessage channels; this is the Feishu/Lark one.

## Highlights

- **Round-trip continuity** — desktop → phone → desktop → phone, context preserved throughout.
- **Two-way sync** — inbound messages steer the session; a `Stop` hook syncs every turn's reply back
  to Feishu, **including turns you type on the desktop**. No reliance on the model remembering to call a tool.
- **One session = one Feishu topic** — outputs stay in separate threads. `@bot` inside a topic steers
  that session; replies return to the same topic.
- **Routing by `root_id`** — natural de-duplication when several sessions run at once.
- **Session lives in a real Terminal window** — you can switch back and type directly.
- **No extra infrastructure** — messaging goes through the official
  [lark-cli](https://github.com/larksuite/lark-cli); no credential management, no token refresh,
  no inbound ports, no tunneling.
- **Permission prompts forwarded to your phone** — reply `y` / `n`, or configure auto-approve.

## Field notes (hard-won)

- `lark-cli event consume` only supports `--as bot`; it treats **stdin EOF as a shutdown signal**,
  so spawning it with `stdio: 'ignore'` makes it exit immediately and loop forever against your restart logic.
- Its event payload is **flattened** (`sender_id` a bare string, `content` plain text) — parsers written
  against Feishu's raw webhook schema silently match nothing.
- A user identity **cannot DM a bot** (`code 230001`); group messages only reach you when the bot is `@`-mentioned.
- Registering a custom channel in the global `~/.claude.json` makes **every** Claude Code instance
  (including the desktop app) spawn its own server, all consuming the same event stream — use `--mcp-config`.

See the Chinese sections above for installation, security boundaries and known limitations.

## License

MIT
