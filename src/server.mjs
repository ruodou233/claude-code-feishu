#!/usr/bin/env node
/**
 * lark-channel — 飞书 Channel for Claude Code
 *
 * 把飞书群消息推进正在运行的 Claude Code 会话，并把权限请求转发到飞书审批。
 * 收发消息复用本机已认证的 lark-cli，不另建飞书应用、不处理 token 刷新。
 *
 * 启动：claude --dangerously-load-development-channels server:lark
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { spawn, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'

const LARK_CLI = process.env.LARK_CLI || join(homedir(), '.local/bin/lark-cli')
const CONFIG = JSON.parse(readFileSync(join(homedir(), '.claude/channels/lark/config.json'), 'utf8'))
// 按发送者 open_id 白名单，不按会话 —— 群里任何人都能发消息，按会话等于没有门禁，
// 而能回复的人就能批准工具调用。会话不做限制，私聊和群都能用。
const ALLOWED_SENDERS = new Set(CONFIG.allowedSenders || [])
// 只服务 config.chatId 这一个会话。跨审阻断项：若放开多来源，
// 全局 replyTarget 会在消息交错时把 A 的回复发到 B（私聊内容可能落到群里）。
// 单来源从根上消除交错，不需要会话路由表。
const CHAT_ID = CONFIG.chatId              // 私聊：指挥主会话
const BOARD = CONFIG.boardChatId           // 话题群：每个会话一个话题
const INSTANCE = process.env.LARK_INSTANCE || ''
const IS_MAIN = process.env.LARK_SYNC_FULL === '1'
if (!CHAT_ID) { console.error('[lark-channel] config.chatId 未设置，拒绝启动'); process.exit(1) }

// 本会话在话题群里的 root message id。由 Stop hook 在首轮结束后写入 threads.json，
// 所以要动态读——server 启动时它还不存在。
function myRoot() {
  if (!INSTANCE) return null
  try {
    const m = JSON.parse(readFileSync(join(homedir(), '.claude/channels/lark/threads.json'), 'utf8'))
    for (const v of Object.values(m)) {
      if (v && typeof v === 'object' && v.instance === INSTANCE) return v.root
    }
  } catch {}
  return null
}

// 回复目标随消息来源走：话题里问的就回到那个话题，私聊问的就回私聊
let replyTarget = CHAT_ID
let replyRoot = null

// 同时写文件：被 Claude Code spawn 时 stderr 不可见，没有日志就无法诊断
const LOG_FILE = join(homedir(), '.claude/channels/lark/debug.log')
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`
  console.error('[lark-channel]', ...a)
  try { appendFileSync(LOG_FILE, line) } catch {}
}

/** 发消息到飞书。失败只记日志，不能让出站问题拖垮 channel。 */
function send(text) {
  return new Promise(resolve => {
    if (!replyTarget) { log('send skipped: no reply target yet'); return resolve() }
    const args = replyRoot
      ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyRoot, '--reply-in-thread', '--text', text]
      // 用 bot 身份发，否则消息显示成用户自己发的；回环由 sender_type 检查挡住
      : ['im', '+messages-send', '--as', 'bot', '--chat-id', replyTarget, '--text', text]
    execFile(LARK_CLI, args,
      { timeout: 20000 },
      err => { if (err) log('send failed:', err.message); resolve() })
  })
}

const mcp = new Server(
  { name: 'lark-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      '飞书消息以 <channel source="lark-channel" sender="..."> 的形式到达。' +
      '你每轮的回答会由 Stop hook 自动同步到飞书，**不要**主动调用 lark_reply。' +
      'lark_reply 仅用于一轮之内需要中途播报进度的场合。' +
      '你的回复应当简洁，适合在手机上阅读。',
  },
)

// ---- reply 工具：Claude 用它把话说回飞书 ----
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'lark_reply',
    description: '把消息发回飞书群（用户正在手机上看）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要发送的消息内容' } },
      required: ['text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'lark_reply') {
    await send(String(req.params.arguments?.text ?? ''))
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// ---- 权限转发：Claude Code 在弹审批框时通知这里 ----
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // autoApprove：全部自动放行，不打断。静默处理——Claude 最终会用 lark_reply 汇报，
  // 每步都推一条通知只会把手机刷屏。审计留在 debug.log。
  if (CONFIG.autoApprove) {
    log('auto-approve', params.tool_name, '|', (params.input_preview || '').slice(0, 120))
    await sendVerdict(params.request_id, true)
    return
  }
  pendingRequestId = params.request_id
  const preview = (params.input_preview || '').slice(0, 1200)
  await send(
    `🔐 需要批准 ${params.tool_name}\n${params.description}\n\n${preview}\n\n` +
    `回复 y 批准 / n 拒绝（多个待审时用「y ${params.request_id}」指定）`
  )
})

async function sendVerdict(id, allow) {
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: id, behavior: allow ? 'allow' : 'deny' },
  })
  if (pendingRequestId === id) pendingRequestId = null
  log('verdict', id, allow ? 'allow' : 'deny')
}

await mcp.connect(new StdioServerTransport())
log('connected, chat:', CHAT_ID, 'allowed senders:', ALLOWED_SENDERS.size)

// ---- 入站：消费飞书事件流 ----
// 五个小写字母、不含 l —— 与 Claude Code 生成的 request_id 字母表一致
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
// 裸 y/n：手机上敲五位随机 ID 太别扭，直接批最近一个待审请求
const BARE_VERDICT_RE = /^\s*(y|yes|n|no|批准|同意|拒绝)\s*$/i
let pendingRequestId = null

// lark-cli 已把飞书事件扁平化：sender_id/chat_id 是裸字符串，content 是纯文本
// （实测 im.message.receive_v1 载荷，非飞书原始 webhook 的嵌套结构）
async function handleEvent(ev) {
  if (ev.type && ev.type !== 'im.message.receive_v1') return
  if (ev.sender_type !== 'user') return                 // 忽略 bot 自己的消息，防回环
  // 路由：私聊只喂主会话；话题群按 root_id 认领——每个 server 只处理自己那个话题，
  // 这同时消除了多会话并存时的重复消费。
  if (ev.chat_id === CHAT_ID) {
    if (!IS_MAIN) return
    replyRoot = null
  } else if (BOARD && ev.chat_id === BOARD) {
    const mine = myRoot()
    if (!mine || ev.root_id !== mine) return
    replyRoot = mine
  } else return
  const sender = ev.sender_id
  if (!sender || !ALLOWED_SENDERS.has(sender)) return   // 门禁：人 + 会话双重
  if (ev.message_type !== 'text') return

  // 群消息带 "@机器人名 " 前缀，用 mentions 里的名字剥掉
  let text = String(ev.content ?? '')
  for (const m of ev.mentions ?? []) {
    if (m?.name) text = text.split(`@${m.name}`).join('')
  }
  text = text.trim()
  if (!text) return

  const m = VERDICT_RE.exec(text)
  if (m) {
    await sendVerdict(m[2].toLowerCase(), m[1].toLowerCase().startsWith('y'))
    return
  }
  // 裸 y/n 只在确实有待审请求时才当裁决，否则它就是一句普通话
  const bare = BARE_VERDICT_RE.exec(text)
  if (bare && pendingRequestId) {
    const w = bare[1].toLowerCase()
    await sendVerdict(pendingRequestId, w.startsWith('y') || w === '批准' || w === '同意')
    return
  }

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: text, meta: { sender } },
  })
  log('forwarded:', text.slice(0, 60))
}

function startConsumer() {
  // consume 只支持 bot 身份，lark-cli 默认走 user，必须显式指定。
  // stdin 必须保持打开：consume 把 stdin EOF 当退出信号（防孤儿进程），
  // 用 'ignore' 会立刻 EOF，导致起来就退、被下面的重启逻辑打成死循环。
  const child = spawn(LARK_CLI, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { handleEvent(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  child.stderr.on('data', d => log('consumer:', d.toString().trim().slice(0, 200)))
  // 消费进程退出就重连；断了不重连等于 channel 静默失效
  child.on('exit', code => {
    log('consumer exited', code, '— restarting in 5s')
    setTimeout(startConsumer, 5000)
  })
}

startConsumer()
