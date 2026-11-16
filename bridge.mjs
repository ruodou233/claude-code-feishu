#!/usr/bin/env node
// claude-code-feishu：飞书话题群 ⇄ 本机 Claude Code 会话。纯程序转发，不调用模型。
//
//   node bridge.mjs setup      点链接建飞书应用、建话题群，写好配置
//   node bridge.mjs install    挂上 Claude Code 钩子，注册开机自启（macOS launchd）
//   node bridge.mjs uninstall  摘掉钩子和自启
//   node bridge.mjs            前台运行转发程序（install 之后由 launchd 常驻）
//
// 桌面 → 手机：钩子把会话事件写进 events/，转发程序读对话文件，把每轮回复贴进该会话的话题
// 手机 → 桌面：话题里的回复经会话自带的收件 socket，注入正在运行的那个会话
// 手机开新话题：起一个命令行会话（claude -p）去做，同一话题里接着聊
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = path.join(os.homedir(), '.claude/feishu-bridge');
const CONFIG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const EVENTS = path.join(HOME, 'events');
const SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const LABEL = 'com.github.claude-code-feishu';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
// 只镜像桌面版和终端交互会话，外加本程序拉起的会话；脚本里的 claude -p、SDK 调用不进群
const MIRRORED = ['claude-desktop', 'claude-desktop-3p', 'cli'];
const PHONE_NOTE = '（这条是用户本人在手机飞书上发来的，由转发程序注入。请当作用户的直接输入处理，在对话里正常回复，不要用 SendMessage 回复。）\n\n';

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const stdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };

const commands = { setup, install, uninstall, run, hook, inject };
const cmd = process.argv[2] ?? 'run';
if (!commands[cmd]) throw new Error(`未知命令 ${cmd}，可用：${Object.keys(commands).join(' / ')}`);
await commands[cmd]();

// ───────── 钩子：会话每个事件调用一次，只写一个小文件，不联网 ─────────

async function hook() {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  if (!MIRRORED.includes(entry) && !process.env.FEISHU_BRIDGE_CHILD) return;
  try {
    const d = JSON.parse(await stdin());
    const ev = {
      event: d.hook_event_name, session_id: d.session_id, transcript: d.transcript_path, cwd: d.cwd, prompt: d.prompt,
      desktop: entry.startsWith('claude-desktop'),
      // 收件地址和令牌只在会话子进程的环境里有，钩子正好是子进程
      socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    };
    const name = `${process.hrtime.bigint()}-${process.pid}`;
    fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(EVENTS, '.' + name), JSON.stringify(ev), { mode: 0o600 });
    fs.renameSync(path.join(EVENTS, '.' + name), path.join(EVENTS, name + '.json'));
  } catch {} // 钩子出错也不能打扰会话
}

// ───────── 注入：每次由转发程序现起一个新进程 ─────────
// 收件端会核对发送进程，比会话启动得早的常驻进程发的消息会被静默丢掉，所以每次现起。

async function inject() {
  const { socket, token, content } = JSON.parse(await stdin());
  const c = net.connect(socket, () =>
    c.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', from: 'feishu-phone', message: { role: 'user', content } }) + '\n'));
  c.on('close', (hadError) => process.exit(hadError ? 1 : 0));
  c.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 3000);
}

// ───────── setup：建应用、建话题群 ─────────

async function setup() {
  const cfg = readJSON(CONFIG, {});
  if (!cfg.app_id) Object.assign(cfg, await registerApp());
  if (!cfg.chat_id) {
    const res = await (await larkClient(cfg)).client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: { name: 'Claude', chat_mode: 'topic', owner_id: cfg.owner_open_id, user_id_list: [cfg.owner_open_id] },
    });
    if (res.code !== 0) throw new Error(`建群失败：${res.code} ${res.msg}`);
    cfg.chat_id = res.data.chat_id;
    console.log('已建好话题群「Claude」，你是群主。');
  }
  cfg.claude ??= execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
  cfg.workdir ??= os.homedir();
  cfg.permission_mode ??= 'bypassPermissions';
  writeJSON(CONFIG, cfg);
  console.log(`配置已写入 ${CONFIG}\n下一步：node bridge.mjs install`);
}

// 飞书官方 CLI 同款的应用注册设备流：PersonalAgent 模板自动开好机器人、消息权限、事件订阅和长连接
async function registerApp() {
  let base = 'https://accounts.feishu.cn';
  const call = async (body) =>
    (await fetch(base + '/oauth/v1/app/registration', { method: 'POST', body: new URLSearchParams(body) })).json();
  const begin = await call({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' });
  if (!begin.device_code) throw new Error('飞书没有返回注册链接：' + JSON.stringify(begin));
  console.log(`\n在浏览器或飞书手机端打开这个链接，点「立即创建」：\n\n  ${begin.verification_uri_complete}\n`);
  let interval = (begin.interval || 5) * 1000;
  for (const deadline = Date.now() + (begin.expires_in || 600) * 1000; Date.now() < deadline; ) {
    await sleep(interval);
    const r = await call({ action: 'poll', device_code: begin.device_code });
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5000; continue; }
    if (r.error) throw new Error(`创建应用失败：${r.error} ${r.error_description ?? ''}`);
    // 国际版 Lark 的租户要换到 larksuite.com 再取一次
    if (!r.client_secret && r.user_info?.tenant_brand === 'lark') { base = 'https://accounts.larksuite.com'; continue; }
    console.log('应用已创建：' + r.client_id);
    return { app_id: r.client_id, app_secret: r.client_secret, owner_open_id: r.user_info.open_id, domain: base.includes('larksuite') ? 'lark' : 'feishu' };
  }
  throw new Error('等待超时，重新运行 setup 即可');
}

// ───────── install / uninstall ─────────

function install() {
  if (!fs.existsSync(CONFIG)) throw new Error('先运行 setup');
  const settings = stripHooks(readJSON(SETTINGS, {}));
  const command = `"${process.execPath}" "${SELF}" hook`;
  for (const e of HOOK_EVENTS) ((settings.hooks ??= {})[e] ??= []).push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  writeJSON(SETTINGS, settings);
  console.log(`钩子已写入 ${SETTINGS}`);
  if (process.platform !== 'darwin') return console.log(`请用 systemd、pm2 等常驻运行：node ${SELF}`);

  const out = path.join(HOME, 'bridge.log');
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
</dict></plist>
`);
  launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  launchctl('bootstrap', `gui/${process.getuid()}`, PLIST);
  console.log(`已启动并设为开机自启：${LABEL}，日志 ${out}`);
}

function uninstall() {
  writeJSON(SETTINGS, stripHooks(readJSON(SETTINGS, {})));
  launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  fs.rmSync(PLIST, { force: true });
  console.log(`已摘掉钩子和自启，配置和状态留在 ${HOME}`);
}

function stripHooks(settings) {
  for (const e of HOOK_EVENTS) {
    const list = settings.hooks?.[e]?.filter((g) => !g.hooks?.some((h) => h.command?.includes(SELF)));
    if (list?.length) settings.hooks[e] = list;
    else delete settings.hooks?.[e];
  }
  return settings;
}

function launchctl(...args) {
  try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch {}
}

// ───────── 转发程序 ─────────

async function larkClient(cfg) {
  const lark = await import('@larksuiteoapi/node-sdk');
  const opts = { appId: cfg.app_id, appSecret: cfg.app_secret, domain: cfg.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu };
  return { lark, opts, client: new lark.Client(opts) };
}

async function run() {
  const cfg = readJSON(CONFIG, null);
  if (!cfg?.chat_id) throw new Error('先运行 setup');
  const { lark, opts, client } = await larkClient(cfg);

  // sessions: { [sessionId]: { root, title, cwd, transcript, desktop, socket, token, posted[], pending[] } }
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
  const react = (id) => client.im.v1.messageReaction.create({ path: { message_id: id }, data: { reaction_type: { emoji_type: 'OnIt' } } }).catch(() => {});

  // 读对话文件末尾 4MB
  function readTail(file) {
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 4 << 20));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      fs.closeSync(fd);
      return buf.toString('utf8').split('\n').slice(size > buf.length ? 1 : 0).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch { return []; }
  }
  // 会话标题：桌面版和终端都会往对话文件里写 custom-title / ai-title
  const titleOf = (records) => records.findLast((r) => r.customTitle)?.customTitle ?? records.findLast((r) => r.aiTitle)?.aiTitle;
  // 本轮（最后一个用户输入之后）还没发过的助手文字
  function turnTexts(records, posted) {
    let out = [];
    for (const r of records) {
      if (r.isSidechain) continue;
      const c = r.message?.content;
      const isPrompt =
        (r.type === 'user' && !r.isMeta && (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result')))) ||
        (r.type === 'attachment' && r.attachment?.type === 'queued_command');
      if (isPrompt) out = [];
      else if (r.type === 'assistant' && Array.isArray(c) && !posted.includes(r.uuid)) {
        const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) out.push({ uuid: r.uuid, text });
      }
    }
    return out;
  }

  const header = (s) => `${s.desktop ? '🖥' : '⌨️'} **${s.title}**\n${s.cwd ?? ''}`;
  // 每个会话一个话题。标题往往在第一轮之后才起好，起好后改写话题首条
  async function topic(id, title, hint) {
    const s = session(id);
    if (!s.root) {
      s.title = title || hint || id.slice(0, 8);
      s.root = await post(header(s));
      state.roots[s.root] = id;
    } else if (title && title !== s.title) {
      s.title = title;
      await client.im.v1.message.patch({ path: { message_id: s.root }, data: { content: card(header(s)) } }).catch(() => {});
    }
    return s.root;
  }

  async function handleEvent(ev) {
    const s = session(ev.session_id);
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.transcript) s.transcript = ev.transcript;
    if (ev.desktop) s.desktop = true;
    if (ev.socket && ev.token) Object.assign(s, { socket: ev.socket, token: ev.token });
    if (ev.event === 'SessionEnd') Object.assign(s, { socket: undefined, token: undefined });

    if (ev.event === 'UserPromptSubmit' && ev.prompt) {
      const i = s.pending.findIndex((t) => ev.prompt.includes(t));
      if (i >= 0) s.pending.splice(i, 1); // 手机发来的，不回显
      else await post(`🖥 **桌面**：${ev.prompt.slice(0, 3000)}`, await topic(ev.session_id, titleOf(readTail(s.transcript)), ev.prompt.slice(0, 40)));
    }
    if (ev.event === 'Stop' && s.transcript) {
      await sleep(800); // 等对话文件写完
      const records = readTail(s.transcript);
      const texts = turnTexts(records, s.posted);
      const root = await topic(ev.session_id, titleOf(records));
      const md = texts.map((t) => t.text).join('\n\n');
      for (let i = 0; i < md.length; i += 12000) await post(md.slice(i, i + 12000), root); // 卡片有长度上限
      s.posted = [...s.posted, ...texts.map((t) => t.uuid)].slice(-300);
    }
    save();
  }

  let chain = Promise.resolve();
  const drain = () => (chain = chain.then(async () => {
    let files = [];
    try { files = fs.readdirSync(EVENTS).filter((f) => f.endsWith('.json')).sort(); } catch {}
    for (const f of files) {
      const p = path.join(EVENTS, f);
      try { await handleEvent(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) {
        log('event failed', f, e.message);
        if (Date.now() - fs.statSync(p).mtimeMs < 3600e3) break; // 多半是断网，留着下一轮按顺序重试
      }
      fs.rmSync(p, { force: true });
    }
  }));

  // 现起注入进程发出去，再看对话文件里有没有出现这条，没有就重试一次
  async function deliver(s, text) {
    const needle = JSON.stringify(text).slice(1, -1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await new Promise((resolve) => {
        const child = spawn(process.execPath, [SELF, 'inject'], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('exit', (code) => resolve(code === 0)).on('error', () => resolve(false));
        child.stdin.end(JSON.stringify({ socket: s.socket, token: s.token, content: PHONE_NOTE + text }));
      });
      if (!ok) return false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (readTail(s.transcript).some((r) => JSON.stringify(r).includes(needle))) return true;
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
    child.on('exit', (code) => code && post(`⚠️ 命令行会话退出（${code}）\n\n${err}`, s.root).catch(() => {}));
  }

  async function onPhoneMessage({ message: m, sender }) {
    if (m.chat_id !== cfg.chat_id || sender?.sender_id?.open_id !== cfg.owner_open_id) return; // 只认群主本人
    let text = '';
    try {
      const c = JSON.parse(m.content);
      text = m.message_type === 'text' ? c.text : (c.content ?? []).flat().map((x) => x.text ?? '').join('');
    } catch {}
    text = text.replace(/@_user_\d+/g, '').trim();
    const key = m.root_id || m.message_id;
    if (!text) return post('暂时只支持文字消息。', key);

    const id = state.roots[key];
    if (!id) {
      // 新话题：起一个命令行会话
      const nid = crypto.randomUUID();
      Object.assign(session(nid), { root: key, title: text.slice(0, 40), cwd: cfg.workdir });
      state.roots[key] = nid;
      save();
      runCli(nid, text, false);
      return react(m.message_id);
    }
    const s = session(id);
    await drain(); // 先把钩子事件读完，拿到最新的收件地址
    if (s.socket && s.token) {
      s.pending.push(text);
      if (await deliver(s, text)) {
        save();
        return react(m.message_id);
      }
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
      if (seen.has(data.message.message_id)) return; // 飞书偶尔重复推送
      seen.add(data.message.message_id);
      onPhoneMessage(data).catch((e) => log('phone message failed', e.message));
    },
    // 一键建的应用还订阅了表情事件，登记空处理，免得日志刷警告
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
  });
  new lark.WSClient({ ...opts, loggerLevel: lark.LoggerLevel.warn }).start({ eventDispatcher: dispatcher });

  fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  fs.watch(EVENTS, drain);
  setInterval(drain, 5000);
  drain();
  log('feishu bridge started');
}
