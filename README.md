# feishu-code-channel

用飞书遥控本机 Claude Code：手机派活、进度回传、同一个会话反复往返。

为在中国大陆使用而写——Anthropic Dispatch、Claude Code Remote Control、官方 Channels 的
Telegram/Discord/iMessage 通道在这里都不可靠，而飞书是可用的。

## 一、先把问题定义清楚

"手机上指挥电脑里的 AI"听起来是一件事，其实是三件，它们的难度和实现方式完全不同：

| 能力 | 含义 | 难点 |
|---|---|---|
| **派活** | 人不在电脑前，从手机发起一个任务 | 需要一个常驻的东西接收消息 |
| **回信** | 进度和结果回到手机 | 需要知道"什么时候算说完了" |
| **连续性** | 电脑上开的工作，出门手机接着推，回来再接着干，**始终是同一个会话** | 最难——大部分方案在这里断掉 |

绝大多数开源方案只解决前两件。它们的做法是：收到消息 → 起一个新的 CLI 进程 → 干完回消息。
这类方案（bridge 型）每次都是**新会话**，你在电脑上干到一半的上下文它接不上；
反过来手机上派的活，回电脑也是另一个孤立的记录。

连续性之所以难，是因为它要求**同一个进程既能被终端喂输入、又能被 IM 喂输入**。

## 二、为什么是 Channel 而不是 Bridge

Claude Code 有一个官方机制叫 [Channels](https://code.claude.com/docs/en/channels)：
一个 MCP server 声明 `claude/channel` capability 后，可以把外部事件**推进一个正在运行的会话**，
而不是另起一个。这正是连续性需要的东西。

```
bridge 型：飞书消息 ──► 新起 CLI 进程 ──► 回消息 ──► 进程结束
                        （每次都是新会话，接不上你手上的活）

channel 型：飞书消息 ──► 推进「已经在跑的那个会话」──► 回消息
                        （同一个会话，终端和手机都能喂它）
```

官方只提供了 Telegram / Discord / iMessage 三个 channel。这个项目是飞书版的实现。

代价是自建 channel 不在官方 allowlist，必须用 `--dangerously-load-development-channels` 启动，
每次开会话要过一次全屏警告。这是研究预览期的限制。

## 三、三个设计决策

### 1. 会话跑在真正的终端窗口里

连续性要求"回来能接着干"，所以这个会话必须**看得见、能直接敲**。

试过三条路：

- 后台进程（`nohup` / `script` 伪终端）：能跑，但没有窗口，回来只能靠日志，谈不上"继续工作"。
- `screen`：macOS 自带的是 4.00.03（2006 年），撑不住现代 TUI——进程起得来，窗口渲染是空的，
  channel 加载不了。管道喂 stdin 和 `-X stuff` 两种注入方式都试过。
- `tmux`：可行，但要先装包管理器。

最后用 `osascript` 在 **Terminal.app** 里开窗口。零依赖、真 TTY、随时切回去接着敲。
代价是没有开机自启——但自启的会话看不见，与"回来能继续"直接冲突。

### 2. 回信靠 Stop hook，不靠模型自觉

给模型一个 `reply` 工具让它"需要时回复"是不可靠的：它只在**觉得该回话**时才调，
你在电脑上敲的那些轮次它根本不会想着往手机发。

改用 Claude Code 的 `Stop` hook——每轮结束必触发，读 transcript 取最后一条回复发出去。
不管这轮是从手机来的还是你在电脑上敲的，都同步。这是确定性的，不依赖模型行为。

hook 通过 `--settings` 只挂在这个会话上，不污染你其它会话。

### 3. 一个会话 = 一个飞书话题

多个会话的输出全发进同一个聊天窗口，很快就分不清哪条是哪个项目的。加标题前缀治标不治本——
它们仍然挤在一个消息流里。

飞书的**话题群**才是对应物：每个话题是一个独立的消息流。所以：

- 会话第一轮结束时，发一条消息开一个话题，记下它的 `message_id` 作为该会话的 root
- 之后每轮 `reply-in-thread` 挂到同一个话题下
- 你在某个话题里 `@bot` 说话，事件带 `root_id`，正好等于那条 root 的 id

于是路由变得很简单：**每个 channel server 只处理 `root_id` 等于自己那条 root 的消息**。

这个设计顺带解决了一个麻烦：多个会话同时跑时，每个都在消费同一条飞书事件流，
原本会导致一条指令被执行多次。按 root_id 认领之后天然去重，多会话可以并存。

## 四、数据流

```
                    ┌─────────────────────────────────┐
  飞书私聊 ─────────►│  server.mjs (MCP channel)       │
  飞书话题 ─@bot────►│   · 消费 lark-cli 事件流         │──► 推进会话
                    │   · 按 chatId / root_id 路由     │
                    │   · 转发权限审批                 │
                    └─────────────────────────────────┘
                                   ▲
                                   │ 同一个 Claude Code 进程
                                   ▼
  Terminal 窗口 ◄────► claude --dangerously-load-development-channels
                                   │
                                   │ 每轮结束
                                   ▼
                    ┌─────────────────────────────────┐
                    │  sync-hook.mjs (Stop hook)      │──► 飞书话题
                    │   · 读 transcript 取本轮回复     │
                    │   · 首轮开话题，之后 reply 挂上   │
                    └─────────────────────────────────┘
```

收发飞书消息复用 [lark-cli](https://github.com/larksuite/lark-cli)（飞书官方 CLI），
不用自建应用凭据管理、不处理 token 刷新、不开公网端口。

## 五、实测踩到的坑

这些都是调试了很久才定位的，写下来省得别人再踩：

**lark-cli 相关**

1. `event consume` 只支持 `--as bot`，默认走 user 身份会直接报错。
2. **`consume` 把 stdin EOF 当退出信号**（为 AI 子进程调用设计的防孤儿机制）。
   spawn 时 stdin 用 `'ignore'` 会导致它一起来就退出，配合重连逻辑变成死循环。必须 `'pipe'` 并保持打开。
3. 事件载荷**已被扁平化**：`sender_id` 是裸字符串、`content` 是纯文本，
   不是飞书原始 webhook 的 `event.sender.sender_id.open_id` 嵌套结构。按官方文档写解析器会全部落空。

**飞书平台限制**

4. **用户身份不能给 bot 发私聊**（`code 230001`）。所以自动化测试只能走群 @，
   但你本人在客户端私聊是正常的。
5. **群消息必须 @bot 才推送事件**。应用拿到的权限是「获取群组中用户@机器人消息」，
   不 @ 的消息服务端根本不推。私聊没这个限制。

**Claude Code 相关**

6. 自建 channel 注册进全局 `~/.claude.json` 会让**每个** Claude Code 实例（含桌面版）
   都 spawn 一个 server，多份同时消费事件流。用 `--mcp-config` 指定独立配置。
7. MCP server 被 Claude Code spawn 时 stderr 不可见，没有文件日志就无法排障。

## 六、安装

需要 macOS、Node ≥ 20、[Claude Code](https://claude.com/claude-code)、
[lark-cli](https://github.com/larksuite/lark-cli)（已完成 `auth login`）。

```bash
git clone <this-repo> && cd feishu-code-channel
mkdir -p ~/.claude/channels/lark
cp src/*.mjs ~/.claude/channels/lark/
cp config.example.json ~/.claude/channels/lark/config.json
cp mcp.example.json ~/.claude/channels/lark/mcp.json
cd ~/.claude/channels/lark && npm install @modelcontextprotocol/sdk zod
```

飞书侧准备：应用需开启机器人能力、订阅 `im.message.receive_v1` 事件（长连接模式）、
具备 `im:message` 与 `im:message:send_as_bot` 权限。

填 `config.json`：

| 字段 | 含义 | 怎么拿 |
|---|---|---|
| `chatId` | 与 bot 的私聊 | `lark-cli im +chat-messages-list --as user --user-id <bot_open_id>`，取返回里的 `chat_id` |
| `boardChatId` | 话题群（`--chat-mode topic` 建） | `lark-cli im +chat-create` 的返回 |
| `allowedSenders` | 允许指挥的人 | `lark-cli auth status` 里的 `openId` |
| `autoApprove` | 是否免审批 | 见下方安全说明 |

Stop hook 需要挂到会话上，做法是准备一份 settings（可基于你现有的 `~/.claude/settings.json`），
在 `hooks.Stop` 里加一条 `node ~/.claude/channels/lark/sync-hook.mjs`，
然后启动时用 `--settings` 指向它。`bin/claude-lark` 已经串好了这套参数。

```bash
cp bin/claude-lark ~/.local/bin/ && chmod +x ~/.local/bin/claude-lark
claude-lark ~/你的项目目录
```

## 七、安全边界

这套东西让 IM 消息能在你的机器上执行命令，务必理解清楚：

- **门禁只有两道**：`allowedSenders`（按 open_id 的发送者白名单）和会话/话题匹配。
  白名单必须按**人**配，不能只按会话——群里任何人都能发消息，而能回复的人就能批准工具调用。
- `autoApprove: true` 表示**所有工具调用自动放行**，配合 `--permission-mode bypassPermissions`
  意味着一条 IM 消息可以在你机器上做任何事，没有任何确认。默认值是 `false`，
  开启前请确认你清楚代价。审计记录写在 `debug.log`。
- server 只服务 `config.chatId` 一个私聊来源。放开多来源会让"最近一条入站消息的来源"
  在消息交错时把 A 的回复发到 B——私聊内容可能落到群里。

## 八、已知限制

- 话题里必须 `@bot`（飞书事件权限所致），私聊不用。
- 没有开机自启：会话跑在 Terminal 窗口里，重启后需手动起。这是换取"看得见"的代价。
- 自建 channel 需要 `--dangerously-load-development-channels`，每次启动过一次警告框。
- 只做了 Claude Code。Codex CLI 没有等价的 channel 机制。
- `bin/claude-to-desktop` 用模拟按键执行 `/desktop` 把会话搬进 Claude 桌面版
  （直接往桌面版元数据目录写文件无效，它只认自己写的索引）。靠模拟按键，TUI 改版即失效。

## License

MIT
