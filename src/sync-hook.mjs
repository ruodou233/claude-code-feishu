#!/usr/bin/env node
/**
 * Stop hook：把本轮 Claude 的回复同步到飞书。
 *
 * 为什么用 hook 而不是让模型自己调 lark_reply：
 *   模型只在"觉得该回话"时才调工具，你在电脑上敲的那些轮次它不会主动往手机发。
 *   hook 是每轮必触发的确定性钩子，电脑上干的活也能同步到手机。
 *
 * 只挂在 channel 会话上（靠 claude-lark 的 --settings 注入），不影响其它会话。
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.claude/channels/lark')
const log = m => { try { appendFileSync(join(DIR, 'debug.log'), `[${new Date().toISOString()}] sync-hook: ${m}\n`) } catch {} }

let input = ''
process.stdin.setEncoding('utf8')
for await (const c of process.stdin) input += c

let payload = {}
try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

const tPath = payload.transcript_path
if (!tPath) process.exit(0)

// 取本轮最后一条 assistant 文本。transcript 是 jsonl，逐行读、从后往前找。
let text = ''
let title = ''
try {
  const lines = readFileSync(tPath, 'utf8').split('\n').filter(Boolean)
  // 标题写在开头附近，正着扫；ai-title 就是桌面版列表里显示的那个名字
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    try {
      const m = JSON.parse(lines[i])
      if (m.type === 'ai-title' && m.aiTitle) { title = String(m.aiTitle); break }
    } catch {}
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let m
    try { m = JSON.parse(lines[i]) } catch { continue }
    if (m.type !== 'assistant') continue
    const c = m.message?.content
    if (!Array.isArray(c)) continue
    const t = c.filter(x => x?.type === 'text').map(x => x.text).join('\n').trim()
    if (t) { text = t; break }
  }
} catch (e) { log('read transcript failed: ' + e.message); process.exit(0) }

if (!text) process.exit(0)

// 已经通过 lark_reply 发过的内容不再重发，避免飞书来的消息被回两遍
try {
  const dbg = readFileSync(join(DIR, 'debug.log'), 'utf8').slice(-4000)
  if (dbg.includes('lark_reply-sent:' + text.slice(0, 40))) process.exit(0)
} catch {}

const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'))
const BOARD = CONFIG.boardChatId          // 话题群：每个会话一个话题
const MAP = join(DIR, 'threads.json')     // session_id -> root message_id

const isMain = process.env.LARK_SYNC_FULL === '1'
const MAX = isMain ? 1500 : 800
const clipped = text.length > MAX
  ? text.slice(0, MAX) + `\n…（还有 ${text.length - MAX} 字，回电脑看完整内容）`
  : text

const sid = String(payload.session_id || '')
const cwd = payload.cwd || ''
const dir = cwd ? cwd.split('/').filter(Boolean).slice(-1)[0] : 'CLI'
const LARK = join(homedir(), '.local/bin/lark-cli')

function run(args) {
  return new Promise(res => execFile(LARK, args, { timeout: 20000 }, (err, stdout) => {
    if (err) { log('lark-cli failed: ' + err.message); return res(null) }
    try {
      const t = String(stdout)
      const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1))
      res(j.ok ? j.data : null)
    } catch { res(null) }
  }))
}

let map = {}
try { map = JSON.parse(readFileSync(MAP, 'utf8')) } catch {}

if (!BOARD) { log('boardChatId 未配置，跳过'); process.exit(0) }

const entry = map[sid]
const root = typeof entry === 'string' ? entry : entry?.root
if (root) {
  // 挂到该会话已有的话题里
  await run(['im', '+messages-reply', '--as', 'bot', '--message-id', root, '--reply-in-thread', '--text', clipped])
  log(`synced ${text.length} chars → thread ${root.slice(-6)}`)
} else {
  // 首条：发一条带标题的消息开一个新话题，记下它作为该会话的 root
  const head = `📁 ${title || dir}${sid ? ` · ${sid.slice(0, 6)}` : ''}\n\n${clipped}`
  const d = await run(['im', '+messages-send', '--as', 'bot', '--chat-id', BOARD, '--text', head])
  if (d?.message_id) {
    map[sid] = { root: d.message_id, instance: process.env.LARK_INSTANCE || '', title: title || dir }
    try { writeFileSync(MAP, JSON.stringify(map, null, 2)) } catch (e) { log('write map failed: ' + e.message) }
    log(`opened thread for ${sid.slice(0, 6)} → ${d.message_id.slice(-6)}`)
  } else {
    log('open thread failed')
  }
}
process.exit(0)
