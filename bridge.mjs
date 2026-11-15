#!/usr/bin/env node
// claude-code-feishu：飞书话题群 ⇄ 本机 Claude Code 会话。纯程序转发，不调用模型。
//
//   node bridge.mjs setup      扫码建飞书应用、建话题群，写好配置
//   node bridge.mjs install    挂上 Claude Code 钩子，注册开机自启（macOS launchd）
//   node bridge.mjs            前台运行转发程序（install 之后由 launchd 常驻）
//   node bridge.mjs uninstall  摘掉钩子和自启，配置与状态留着
//
// 三条链路：
//   桌面 → 手机：钩子把会话事件写进 events/，转发程序读对话文件，把每轮回复贴进该会话的话题
//   手机 → 桌面：话题里的回复经会话收件 socket 注入正在运行的那个会话
//   手机开新话题：起一个命令行会话（claude -p）去做，同一话题里接着聊
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.FEISHU_BRIDGE_HOME || path.join(os.homedir(), '.claude/feishu-bridge');
const CONFIG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const EVENTS = path.join(HOME, 'events');
const LABEL = 'com.github.claude-code-feishu';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
// 只镜像桌面版和终端交互会话，以及本程序自己拉起的会话；其他 claude -p、SDK 调用不进群
const MIRRORED = new Set(['claude-desktop', 'claude-desktop-3p', 'cli']);

const PHONE_NOTE = '（这条是用户本人在手机飞书上发来的，由转发程序注入。请当作用户的直接输入处理，在对话里正常回复，不要用 SendMessage 回复。）\n\n';
const MAX_CHUNK = 12000;

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const commands = { setup, install, uninstall, run, hook, inject };
const cmd = process.argv[2] ?? 'run';
if (!commands[cmd]) {
  console.error(`未知命令 ${cmd}。可用：${Object.keys(commands).join(' / ')}`);
  process.exit(1);
}
await commands[cmd](...process.argv.slice(3));

// ───────────────────────── 钩子：Claude Code 每个事件调用一次，只写文件，不联网 ─────────────────────────

async function hook() {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  const child = Boolean(process.env.FEISHU_BRIDGE_CHILD);
  if (!MIRRORED.has(entry) && !child) return;
  try { await writeEvent(entry, child); } catch {} // 钩子出错也不能打扰会话
}

async function writeEvent(entry, child) {
  let input = '';
  for await (const c of process.stdin) input += c;
  const d = JSON.parse(input);
  const ev = {
    event: d.hook_event_name,
    session_id: d.session_id,
    transcript_path: d.transcript_path,
    cwd: d.cwd,
    prompt: d.prompt,
    desktop: entry.startsWith('claude-desktop'),
    child,
    // 收件地址和令牌只在会话子进程的环境里有，钩子正好是子进程
    socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
  };
  fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  const name = `${process.hrtime.bigint()}-${process.pid}`;
  fs.writeFileSync(path.join(EVENTS, '.' + name), JSON.stringify(ev), { mode: 0o600 });
  fs.renameSync(path.join(EVENTS, '.' + name), path.join(EVENTS, name + '.json'));
}

// ───────────────────────── 注入助手：每次由转发程序现起一个新进程 ─────────────────────────
// 收件方会核对发送进程：比会话启动得早的常驻进程发的消息会被静默丢掉，所以每次现起。

async function inject() {
  let input = '';
  for await (const c of process.stdin) input += c;
  const { socket, token, content } = JSON.parse(input);
  const c = net.connect(socket);
  c.on('connect', () =>
    c.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', from: 'feishu-phone', message: { role: 'user', content } }) + '\n'));
  c.on('close', (hadError) => process.exit(hadError ? 1 : 0));
  c.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 3000);
}

// ───────────────────────── setup：扫码建应用 + 建话题群 ─────────────────────────

async function setup() {
  const cfg = readJSON(CONFIG, {});
  if (!cfg.app_id) Object.assign(cfg, await registerApp());
  const lark = await import('@larksuiteoapi/node-sdk');
  const client = larkClient(lark, cfg);

  if (!cfg.chat_id) {
    const res = await client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: { name: 'Claude', chat_mode: 'topic', owner_id: cfg.owner_open_id, user_id_list: [cfg.owner_open_id] },
    });
    if (res.code !== 0) throw new Error(`建群失败：${res.code} ${res.msg}`);
    cfg.chat_id = res.data.chat_id;
    console.log('已建好话题群「Claude」，你是群主。');
  }
  cfg.claude ??= which('claude');
  cfg.workdir ??= os.homedir();
  cfg.permission_mode ??= 'bypassPermissions';
  writeJSON(CONFIG, cfg);
  console.log(`配置已写入 ${CONFIG}\n下一步：node ${path.basename(SELF)} install`);
}

// 飞书官方 CLI 同款的应用注册设备流：PersonalAgent 模板自动开好机器人、消息权限、事件订阅和长连接
async function registerApp() {
  const call = async (base, body) => {
    const res = await fetch(base + '/oauth/v1/app/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    return res.json();
  };
  let base = 'https://accounts.feishu.cn';
  const begin = await call(base, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' });
  if (!begin.device_code) throw new Error('飞书没有返回注册链接：' + JSON.stringify(begin));
  console.log(`\n在浏览器或飞书手机端打开下面的链接，点「立即创建」：\n\n  ${begin.verification_uri_complete}\n`);
  let interval = (begin.interval || 5) * 1000;
  const deadline = Date.now() + (begin.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await call(base, { action: 'poll', device_code: begin.device_code });
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5000; continue; }
    if (r.error) throw new Error(`创建应用失败：${r.error} ${r.error_description ?? ''}`);
    // 国际版 Lark 的租户要换到 larksuite.com 再取一次
    if (!r.client_secret && r.user_info?.tenant_brand === 'lark') { base = 'https://accounts.larksuite.com'; continue; }
    console.log('应用已创建：' + r.client_id);
    return {
      app_id: r.client_id,
      app_secret: r.client_secret,
      owner_open_id: r.user_info.open_id,
      domain: base.includes('larksuite') ? 'lark' : 'feishu',
    };
  }
  throw new Error('等待超时，重新运行 setup 即可');
}

function which(bin) {
  try { return execFileSync('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim(); } catch { return bin; }
}

// ───────────────────────── install / uninstall ─────────────────────────

function install() {
  if (!fs.existsSync(CONFIG)) throw new Error('先运行 setup');
  const settings = readJSON(SETTINGS, {});
  stripHooks(settings);
  settings.hooks ??= {};
  const command = `"${process.execPath}" "${SELF}" hook`;
  for (const e of HOOK_EVENTS) (settings.hooks[e] ??= []).push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  writeJSON(SETTINGS, settings);
  console.log(`钩子已写入 ${SETTINGS}（${HOOK_EVENTS.join(' / ')}）`);

  if (process.platform !== 'darwin') {
    console.log(`非 macOS：请用 systemd、pm2 等常驻运行 \`node ${SELF}\``);
    return;
  }
  const log = path.join(HOME, 'bridge.log');
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['bootstrap', domain, PLIST]);
  console.log(`已注册开机自启并启动：${LABEL}\n日志：${log}`);
}

function uninstall() {
  const settings = readJSON(SETTINGS, null);
  if (settings) { stripHooks(settings); writeJSON(SETTINGS, settings); }
  if (fs.existsSync(PLIST)) {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    fs.rmSync(PLIST);
  }
  console.log(`已摘掉钩子和自启。配置与状态还在 ${HOME}`);
}

function stripHooks(settings) {
  for (const e of HOOK_EVENTS) {
    const list = settings.hooks?.[e];
    if (!list) continue;
    settings.hooks[e] = list.filter((g) => !g.hooks?.some((h) => h.command?.includes(SELF)));
    if (!settings.hooks[e].length) delete settings.hooks[e];
  }
}

// ───────────────────────── 转发程序 ─────────────────────────

function larkClient(lark, cfg) {
  return new lark.Client({ appId: cfg.app_id, appSecret: cfg.app_secret, domain: cfg.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu });
}

async function run() {
  const cfg = readJSON(CONFIG, null);
  if (!cfg?.chat_id) throw new Error('先运行 setup');
  const lark = await import('@larksuiteoapi/node-sdk');
  const client = larkClient(lark, cfg);

  // sessions: { [sessionId]: { root, ownRoot, title, cwd, transcript, desktop, socket, token, posted[], pending[] } }
  // roots:    { [话题首条消息 id]: sessionId }
  const state = readJSON(STATE, { sessions: {}, roots: {} });
  const save = () => writeJSON(STATE, state);
  const session = (id) => (state.sessions[id] ??= { posted: [], pending: [] });

  const card = (md) => JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: md }] } });
  async function post(md, root) {
    const res = root
      ? await client.im.v1.message.reply({ path: { message_id: root }, data: { msg_type: 'interactive', content: card(md), reply_in_thread: true } })
      : await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: cfg.chat_id, msg_type: 'interactive', content: card(md) } });
    if (res.code !== 0) throw new Error(`feishu ${res.code} ${res.msg}`);
    return res.data.message_id;
  }
  async function postLong(md, root) {
    for (let i = 0; i < md.length; i += MAX_CHUNK) await post(md.slice(i, i + MAX_CHUNK), root);
  }
  const react = (messageId) =>
    client.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: 'OnIt' } } }).catch(() => {});

  // 对话文件末尾：会话标题（桌面版和终端都会写 custom-title / ai-title），以及本轮还没发过的助手文字
  function readTail(transcript) {
    try {
      const fd = fs.openSync(transcript, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 4 << 20);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      return buf.toString('utf8').split('\n').slice(size > len ? 1 : 0).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch { return []; }
  }
  const titleOf = (records) => records.findLast((r) => r.customTitle)?.customTitle ?? records.findLast((r) => r.aiTitle)?.aiTitle;
  function turnTexts(records, posted) {
    let out = [];
    for (const r of records) {
      if (r.isSidechain) continue;
      const content = r.message?.content;
      const isPrompt =
        (r.type === 'user' && !r.isMeta && (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text') && !content.some((b) => b.type === 'tool_result')))) ||
        (r.type === 'attachment' && r.attachment?.type === 'queued_command');
      if (isPrompt) { out = []; continue; }
      if (r.type !== 'assistant' || !Array.isArray(content) || posted.includes(r.uuid)) continue;
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) out.push({ uuid: r.uuid, text });
    }
    return out;
  }

  const rootCard = (s) => `${s.desktop ? '🖥' : '⌨️'} **${s.title}**\n${s.cwd ?? ''}`;
  // title：会话的正式标题（可能还没起好）；hint：没有标题时先拿来开话题的临时名
  async function ensureTopic(id, title, hint) {
    const s = session(id);
    if (s.root) {
      // 会话标题往往在第一轮之后才起好，起好后改写话题首条（手机开的话题首条是用户自己发的，不改）
      if (title && title !== s.title && s.ownRoot) {
        s.title = title;
        await client.im.v1.message.patch({ path: { message_id: s.root }, data: { content: card(rootCard(s)) } }).catch(() => {});
      }
      return s.root;
    }
    s.title = title || s.title || hint || id.slice(0, 8);
    s.root = await post(rootCard(s));
    s.ownRoot = true;
    state.roots[s.root] = id;
    save();
    return s.root;
  }

  async function handleEvent(ev) {
    const s = session(ev.session_id);
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.transcript_path) s.transcript = ev.transcript_path;
    if (ev.desktop) s.desktop = true;
    if (ev.socket && ev.token) Object.assign(s, { socket: ev.socket, token: ev.token });
    if (ev.event === 'SessionEnd') Object.assign(s, { socket: undefined, token: undefined });

    if (ev.event === 'UserPromptSubmit' && ev.prompt) {
      const i = s.pending.findIndex((t) => ev.prompt.includes(t));
      if (i >= 0) s.pending.splice(i, 1); // 手机发来的，不回显
      else if (!ev.child) {
        const root = await ensureTopic(ev.session_id, titleOf(readTail(s.transcript)), ev.prompt.slice(0, 40));
        await post(`🖥 **桌面**：${ev.prompt.slice(0, 3000)}`, root);
      }
    }
    if (ev.event === 'Stop' && s.transcript) {
      await sleep(800); // 等对话文件写完
      const records = readTail(s.transcript);
      const texts = turnTexts(records, s.posted);
      const root = await ensureTopic(ev.session_id, titleOf(records));
      if (texts.length) {
        await postLong(texts.map((t) => t.text).join('\n\n'), root);
        s.posted = [...s.posted, ...texts.map((t) => t.uuid)].slice(-300);
      }
    }
    save();
  }

  let chain = Promise.resolve();
  function drainEvents() {
    chain = chain.then(async () => {
      let files = [];
      try { files = fs.readdirSync(EVENTS).filter((f) => f.endsWith('.json')).sort(); } catch {}
      for (const f of files) {
        const p = path.join(EVENTS, f);
        try { await handleEvent(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) {
          log('event failed', f, e.message);
          if (Date.now() - fs.statSync(p).mtimeMs < 3600e3) break; // 多半是断网，留着下一轮重试
        }
        fs.rmSync(p, { force: true });
      }
    });
    return chain;
  }

  // 现起注入助手发出去，再看对话文件里是否出现这条，确认真的送达
  async function deliver(s, text) {
    const send = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [SELF, 'inject'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
      child.stdin.end(JSON.stringify({ socket: s.socket, token: s.token, content: PHONE_NOTE + text }));
    });
    const needle = JSON.stringify(text).slice(1, -1);
    const landed = () => { try { return fs.readFileSync(s.transcript, 'utf8').slice(-200000).includes(needle); } catch { return false; } };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await send())) return false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (landed()) return true;
      }
    }
    return false;
  }

  function runCli(id, text, resume) {
    const s = session(id);
    s.pending.push(text);
    const args = ['-p', text, '--permission-mode', cfg.permission_mode, resume ? '--resume' : '--session-id', id];
    const child = spawn(cfg.claude, args, { cwd: s.cwd || cfg.workdir, env: { ...process.env, FEISHU_BRIDGE_CHILD: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-1500)));
    child.on('exit', (code) => { if (code) post(`⚠️ 命令行会话退出（${code}）\n\n${err}`, s.root).catch(() => {}); });
  }

  async function onPhoneMessage(data) {
    const m = data.message;
    if (m.chat_id !== cfg.chat_id || data.sender?.sender_id?.open_id !== cfg.owner_open_id) return;
    let text = '';
    try {
      const c = JSON.parse(m.content);
      text = m.message_type === 'text' ? c.text : (c.content ?? []).flat().map((x) => x.text ?? '').join('');
    } catch {}
    text = text.replace(/@_user_\d+/g, '').trim();
    const key = m.root_id || m.message_id;
    if (!text) return post('暂时只支持文字消息。', key).catch(() => {});

    let id = state.roots[key];
    if (!id) {
      // 新话题：起一个命令行会话
      id = crypto.randomUUID();
      Object.assign(session(id), { root: key, title: text.slice(0, 40), cwd: cfg.workdir });
      state.roots[key] = id;
      save();
      runCli(id, text, false);
      return react(m.message_id);
    }
    const s = session(id);
    await drainEvents(); // 先把钩子事件读完，拿到最新的收件地址
    if (s.socket && s.token) {
      s.pending.push(text);
      if (await deliver(s, text)) { save(); return react(m.message_id); }
      s.pending.pop();
    }
    // 桌面会话没在运行：不另起进程去续，免得一份对话分叉成两份
    if (s.desktop) return post('这个会话在桌面版里，目前没在运行。请在桌面打开它，之后在这里再发一次即可。', key);
    runCli(id, text, true);
    react(m.message_id);
  }

  const seen = new Set();
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      const id = data.message.message_id;
      if (seen.has(id)) return; // 飞书偶尔重复推送
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      onPhoneMessage(data).catch((e) => log('phone message failed', e.message));
    },
    // 一键建的应用默认还订阅了表情事件，登记空处理，免得日志刷警告
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
  });
  new lark.WSClient({ appId: cfg.app_id, appSecret: cfg.app_secret, domain: cfg.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn })
    .start({ eventDispatcher: dispatcher });

  fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  fs.watch(EVENTS, () => drainEvents());
  setInterval(drainEvents, 5000);
  drainEvents();
  log('feishu bridge started');
}
