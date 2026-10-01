import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { listThreads, openThread, command, selectedThread, pageText, projectList, projectPageText } from './threads.mjs';
import { DATA, CODEX_HOME, config, load, save } from './settings.mjs';

const VERSION = '2.4.9'; // Tencent protocol reference version, not this bridge's version.
const BASE = 'https://ilinkai.weixin.qq.com';
const log = text => console.log(new Date().toISOString(), text);
export function trustedBase(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.weixin.qq.com') || u.port || u.username || u.password) throw Error('微信返回了不受信任的 API 地址');
  return u.origin;
}
async function api(base, endpoint, body, token, timeout = 40000) {
  const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 9) };
  if (body !== undefined) Object.assign(headers, {
    'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
  });
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${trustedBase(base)}/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(token ? { ...body, base_info: { channel_version: VERSION, bot_agent: 'CodexWeChatBridge/0.1.0' } } : body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error(`微信 HTTP ${response.status}`);
  const data = JSON.parse(await response.text(), (key, value, context) =>
    ['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number' ? context.source : value);
  if (data.ret || data.errcode) throw Error(`微信接口错误 ${data.ret || data.errcode}`);
  return data;
}
export function applyPatches(state, patches) {
  for (const p of patches) {
    if (!Array.isArray(p.path) || p.path.some(k => ['__proto__', 'prototype', 'constructor'].includes(String(k)))) throw Error('Invalid state patch');
    if (p.path.length === 0) { if (p.op !== 'replace') throw Error('Invalid root patch'); state = p.value; continue; }
    let parent = state;
    for (const key of p.path.slice(0, -1)) { if (!Object.hasOwn(parent, key)) throw Error('Patch path missing'); parent = parent[key]; }
    const key = p.path.at(-1);
    if (p.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (p.op === 'add' || p.op === 'replace') {
      if (Array.isArray(parent) && p.op === 'add') parent.splice(key === '-' ? parent.length : Number(key), 0, p.value); else parent[key] = p.value;
    } else throw Error('Unknown patch operation');
  }
  return state;
}
export function turns(state) {
  return state?.turnHistory?.kind === 'canonical' ? Object.values(state.turnHistory.history.entitiesByKey) : state?.turns || [];
}
export function thinkingTurn(snapshot) {
  if (!snapshot || snapshot.requests?.length) return null;
  const turn = turns(snapshot).findLast(t => t.status === 'inProgress');
  return turn ? turn.turnId || turn.params?.clientUserMessageId || null : null;
}
export function messages(state) {
  return turns(state).flatMap(turn => (turn.items || []).flatMap(item => {
    if (item.type === 'agentMessage') return [{ key: item.id, role: 'assistant', text: item.text || '', time: turn.turnStartedAtMs, done: turn.status !== 'inProgress' || Boolean(turn.agentMessageCompletedAtMsById?.[item.id]) }];
    if (item.type === 'userMessage') return [{ key: item.id, clientId: item.clientId, role: 'user', text: (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), time: turn.turnStartedAtMs, done: true }];
    return [];
  }));
}
export function textParts(text, size = 1200) {
  const points = Array.from(text), result = [];
  for (let i = 0; i < points.length; i += size) result.push(points.slice(i, i + size).join(''));
  return result;
}
export function turnRequest(threadId, text, clientId) {
  return { conversationId: threadId, turnStart: {
    request: { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientId, turnTrigger: 'composer' },
    context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] },
  } };
}
export class Desktop {
  constructor(threadId, onState) { this.threadId = threadId; this.onState = onState; this.pending = new Map(); this.client = 'initializing-client'; this.buffer = Buffer.alloc(0); this.state = null; }
  write(message) {
    const b = Buffer.from(JSON.stringify(message)), h = Buffer.alloc(4); h.writeUInt32LE(b.length);
    this.socket.write(Buffer.concat([h, b]));
  }
  request(method, params, version, targetClientId) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('桌面请求超时；发送结果可能未知')); }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: 'request', sourceClientId: this.client, requestId, method, params, version, targetClientId });
    });
  }
  follow() {
    this.write({ type: 'broadcast', sourceClientId: this.client, method: 'thread-stream-following-changed', version: 1,
      targetClientIds: [this.owner], params: { conversationId: this.threadId, hostId: 'local', following: true } });
  }
  async connect() {
    this.socket = net.connect(path.join(CODEX_HOME, 'ipc/ipc.sock'));
    this.closed = new Promise(resolve => this.socket.once('close', () => {
      this.state = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex 桌面连接中断')); }
      this.pending.clear(); resolve();
    }));
    this.socket.on('error', () => {});
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    this.socket.on('data', d => {
      try {
        this.buffer = Buffer.concat([this.buffer, d]);
        while (this.buffer.length >= 4) {
          const n = this.buffer.readUInt32LE();
          if (!n || n > 268435456) throw Error('Invalid desktop frame');
          if (this.buffer.length < n + 4) break;
          const m = JSON.parse(this.buffer.subarray(4, n + 4)); this.buffer = this.buffer.subarray(n + 4); this.receive(m);
        }
      } catch (e) { log(`桌面同步错误：${e.message}`); this.socket.destroy(); }
    });
    this.client = (await this.request('initialize', { clientType: 'wechat-codex-bridge' }, 0)).result.clientId;
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: this.threadId }, 1);
    this.owner = owner.handledByClientId; this.follow();
  }
  receive(m) {
    if (m.type === 'client-discovery-request') this.write({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: false } });
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.requestId);
      if (m.resultType === 'success') p.resolve(m); else p.reject(Error('桌面请求失败，请在 Codex 中检查会话状态'));
    }
    if (m.type === 'broadcast' && m.method === 'client-status-changed' && m.params?.clientId === this.owner && m.params.status === 'disconnected') this.socket.destroy();
    if (m.type !== 'broadcast' || m.method !== 'thread-stream-state-changed' || m.params?.conversationId !== this.threadId || m.sourceClientId !== this.owner) return;
    const c = m.params.change;
    if (m.version !== 11) throw Error('Codex 会话协议版本改变，需要适配');
    if (c.type === 'snapshot') { this.state = c.conversationState; this.revision = c.revision; }
    else if (c.type === 'patches' && this.state && c.baseRevision === this.revision) { this.state = applyPatches(this.state, c.patches); this.revision = c.revision; }
    else { this.state = null; this.follow(); return; }
    this.onState(this.state);
  }
  async send(text, clientId) { return this.request('thread-follower-start-turn', turnRequest(this.threadId, text, clientId), 2, this.owner); }
}

export async function login() {
  if (fs.existsSync(path.join(DATA, 'run.lock'))) throw Error('请先停止同步服务再重新绑定');
  save('verify.json', { code: null });
  const qr = await api(BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] });
  if (!qr.qrcode || !qr.qrcode_img_content) throw Error('微信未返回二维码');
  save('qr.json', qr);
  const { default: QRCode } = await import('qrcode');
  await QRCode.toFile(path.join(DATA, 'qr.png'), qr.qrcode_img_content, { width: 360, margin: 4 });
  fs.chmodSync(path.join(DATA, 'qr.png'), 0o600);
  console.log(await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true }));
  log(`二维码已生成：${path.join(DATA, 'qr.png')}，等待微信扫码。`);
  let base = BASE;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const code = load('verify.json', null)?.code;
    let r;
    try { r = await api(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${code ? '&verify_code=' + encodeURIComponent(code) : ''}`); }
    catch (e) { if (e.name === 'TimeoutError') continue; throw e; }
    if (r.status === 'confirmed') {
      if (!r.bot_token || !r.ilink_user_id || !r.ilink_bot_id) throw Error('微信绑定信息不完整');
      const previous = load('account.json', null);
      if (previous && previous.user !== r.ilink_user_id) save('sync.json', { since: Date.now(), cursor: '', offsets: {}, inbound: [], queue: [], context: null, notices: [] });
      save('account.json', { token: r.bot_token, user: r.ilink_user_id, bot: r.ilink_bot_id, base: trustedBase(r.baseurl || base) });
      save('status.json', { status: 'bound', at: Date.now() }); log('微信绑定成功。'); return;
    }
    if (r.status === 'expired' || r.status === 'verify_code_blocked') throw Error(`扫码状态：${r.status}，请重新登录`);
    if (r.status === 'binded_redirect') throw Error('微信提示已绑定其他实例；请在微信检查绑定后重试');
    if (r.status === 'need_verifycode') { save('status.json', { status: 'need_verifycode' }); log('请在终端用 verify 命令输入微信显示的配对数字。'); }
    if (r.status === 'scaned_but_redirect' && r.redirect_host) base = trustedBase(`https://${r.redirect_host}`);
    await sleep(1500);
  }
  throw Error('二维码已超时，请重新运行 login');
}

export async function run() {
  if (process.platform !== 'darwin') throw Error('目前桌面双向同步仅验证 macOS');
  if (!config().threadId) throw Error('请先运行 init 选择初始会话');
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const lock = path.join(DATA, 'run.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw Error('桥接已运行，或存在上次异常退出的 run.lock；请先检查进程。'); }
  process.once('exit', () => { try { fs.unlinkSync(lock); } catch {} });
  const account = load('account.json', null);
  if (!account) throw Error('请先运行 login 并扫码');
  const state = load('sync.json', { since: Date.now(), cursor: '', offsets: {}, inbound: [], queue: [], context: null, notices: [] });
  state.selectedId ??= config().threadId; state.catalog ??= []; state.page ??= 0; state.view ??= 'chat';
  let desktop, draining = false, flushing = false, stopping = false, switching = false;
  // ponytail: one selected thread at a time; use per-thread queues for concurrent conversations.
  const persist = () => save('sync.json', state);
  const post = (endpoint, body, timeout) => api(account.base, endpoint, body, account.token, timeout);
  async function send(text, id = randomUUID()) {
    if (!state.context) throw Error('请先从微信发一条消息建立回复上下文');
    const parts = textParts(text);
    for (let i = 0; i < parts.length; i++) await post('ilink/bot/sendmessage', { msg: {
      from_user_id: '', to_user_id: account.user, client_id: `${id}-${i}`, message_type: 2, message_state: 2,
      context_token: state.context, item_list: [{ type: 1, text_item: { text: parts[i] } }],
    } });
  }
  let typingBusy = false, typingActive = false, typingTicket = null, typingContext = null, nextTypingAt = 0, lastTypingState = null;
  async function updateThinking() {
    if (stopping || switching || typingBusy || !state.context) return;
    const turnId = thinkingTurn(desktop?.state);
    const active = Boolean(turnId);
    if (!active && !typingActive) return;
    if (active === lastTypingState && Date.now() < nextTypingAt) return;
    typingBusy = true; lastTypingState = active;
    try {
      if (!typingTicket || typingContext !== state.context) {
        const config = await post('ilink/bot/getconfig', { ilink_user_id: account.user, context_token: state.context }, 10000);
        typingTicket = config.typing_ticket; typingContext = state.context;
      }
      if (!typingTicket) throw Error('微信未提供输入状态凭证');
      if (stopping) return;
      await post('ilink/bot/sendtyping', { ilink_user_id: account.user, typing_ticket: typingTicket, status: active ? 1 : 2 }, 10000);
      if (active !== typingActive) log(active ? '正在输入提示已发送。' : '正在输入提示已结束。');
      typingActive = active; nextTypingAt = Date.now() + 8000;
    } catch (e) {
      typingTicket = null; nextTypingAt = Date.now() + 15000;
      log(`思考状态提示暂不可用：${e.message}`);
    } finally { typingBusy = false; }
  }
  async function flush() {
    if (switching || flushing || !desktop?.state || !state.context) return;
    flushing = true;
    const snapshot = desktop.state;
    try {
      for (const m of messages(snapshot)) {
        if (!m.key || !m.time || m.time < state.since) continue;
        if (m.role === 'user' && state.inbound.some(i => i.clientId === m.clientId)) continue;
        const offset = state.offsets[m.key] || 0;
        if (m.text.length <= offset || (!m.done && m.text.length - offset < 60)) continue;
        // Persist each acknowledged chunk. Stable IDs reduce duplicates on uncertain network outcomes.
        for (const part of textParts(m.text.slice(offset))) {
          const at = state.offsets[m.key] || 0;
          await send((m.role === 'user' ? '【电脑端】\n' : '') + part, `${m.key}-${at}`);
          state.offsets[m.key] = at + part.length; persist();
        }
      }
      if (snapshot.requests?.length) {
        const id = snapshot.requests.map(r => r.id).join(',');
        if (!state.notices.includes(id)) { await send('Codex 需要你确认一项操作，请在电脑端查看并处理。', 'approval-' + id); state.notices.push(id); persist(); }
      }
    } catch (e) { log(`微信发送暂未完成：${e.message}`); }
    finally { flushing = false; }
  }
  async function drain() {
    if (switching || draining || !desktop?.state || desktop.state.threadRuntimeStatus?.type === 'active' || turns(desktop.state).some(t => t.status === 'inProgress')) return;
    const entry = state.queue[0]; if (!entry || entry.status === 'unknown') return;
    draining = true;
    try {
      const d = desktop;
      // Mark before dispatch. Never blindly repeat a possibly accepted Codex turn.
      entry.status = 'unknown'; persist();
      await d.send(entry.text, entry.clientId);
      state.queue = state.queue.filter(q => q.clientId !== entry.clientId); persist(); log('微信消息已提交到 Codex 当前聊天。');
    } catch (e) { log(`提交结果待确认：${e.message}`); }
    finally { draining = false; }
  }
  function onState(snapshot) {
    const accepted = new Set(turns(snapshot).map(t => t.params?.clientUserMessageId));
    const prior = state.queue.length;
    state.queue = state.queue.filter(q => q.status !== 'unknown' || !accepted.has(q.clientId));
    if (state.queue.length !== prior) persist();
  }
  async function connectLoop() {
    while (!stopping) {
      if (!desktop || desktop.socket?.destroyed) {
        const d = new Desktop(state.selectedId, onState); desktop = d;
        try { await d.connect(); log('已连接 Codex 桌面选定聊天。'); }
        catch (e) { log(`等待 Codex 桌面：${e.message}`); d.socket?.destroy(); await sleep(5000); continue; }
      }
      const watching = desktop;
      await watching.closed;
      if (desktop === watching) desktop = null;
      await sleep(1000);
    }
  }
  async function switchThread(target) {
    if (target.id === state.selectedId && desktop?.state) return;
    if (state.queue.length) throw Error('当前会话还有未提交的微信消息，请等待提交完成后再切换。');
    switching = true;
    let candidate;
    try {
      while (flushing || draining) await sleep(100);
      await openThread(target);
      for (let attempt = 0; attempt < 8; attempt++) {
        candidate = new Desktop(target.id, onState);
        try {
          await candidate.connect();
          for (let i = 0; i < 40 && !candidate.state && !candidate.socket.destroyed; i++) await sleep(250);
          if (!candidate.state) throw Error('等待会话加载超时');
          break;
        } catch (e) { candidate.socket?.destroy(); if (attempt === 7) throw e; await sleep(1000); }
      }
      // Baseline existing content; subsequent chunks of an already-running turn still sync.
      state.offsets = Object.fromEntries(messages(candidate.state).map(m => [m.key, m.text.length]));
      state.since = Math.min(Date.now(), ...turns(candidate.state).filter(t => t.status === 'inProgress').map(t => t.turnStartedAtMs || Date.now()));
      const previous = desktop;
      state.selectedId = target.id; state.notices = []; persist();
      desktop = candidate; previous?.socket?.destroy(); target.archived = false;
      log('已切换微信绑定的 Codex 会话。');
    } catch (e) { candidate?.socket?.destroy(); throw e; }
    finally { switching = false; }
  }
  async function handleCommand(c, id) {
    let answer;
    try {
      if (c.kind === 'projects') {
        state.projectMenu = projectList(await listThreads()); state.view = 'projects'; persist();
        answer = projectPageText(state.projectMenu);
      } else if (c.kind === 'project' || (c.kind === 'number' && state.view === 'projects')) {
        const project = (state.projectMenu || [])[Number(c.value) - 1];
        if (!project) throw Error('请先发送“项目列表”，再发送“查看项目 编号”。');
        state.catalog = (await listThreads()).filter(t => t.projectId === project.id);
        state.page = 0; state.view = 'threads'; persist();
        answer = `📁 ${project.label}\n` + pageText(state.catalog, 0, state.selectedId);
      } else if (c.kind === 'list' || c.kind === 'search') {
        const all = await listThreads();
        state.catalog = c.kind === 'search' ? all.filter(t => t.title.toLowerCase().includes(c.query.toLowerCase())) : all;
        state.page = 0; state.view = 'threads'; persist();
        answer = pageText(state.catalog, state.page, state.selectedId);
      } else if (c.kind === 'page') {
        const page = state.page + c.delta;
        answer = pageText(state.catalog, page, state.selectedId); state.page = page; persist();
      } else if (c.kind === 'select' || c.kind === 'number') {
        const target = selectedThread(state.catalog, c.value);
        await switchThread(target); state.view = 'chat'; persist();
        answer = `📁 ${target.projectLabel}\n已切换到：${target.title}\n接下来直接发送文字，即可接着这个历史会话聊。电脑端也已打开该会话。`;
      } else if (c.kind === 'current') {
        const current = (await listThreads()).find(t => t.id === state.selectedId);
        answer = `📁 ${current?.projectLabel || '未归属项目'}\n当前会话：${desktop?.state?.title || current?.title || state.selectedId}`;
      } else {
        answer = '项目列表：先选择项目，再选择会话\n查看项目 2：筛选项目会话\n会话列表：浏览本机全部 Codex 聊天（含归档）\n下一页 / 上一页：翻页\n搜索 关键词：按标题查找\n切换 3：选择列表里的编号\n当前会话：查看选中的聊天\n普通文字：发给当前选中会话。';
      }
    } catch (e) { answer = `未完成：${e.message}`; }
    await send(answer, 'command-' + id);
  }
  async function shutdown() {
    if (stopping) return;
    stopping = true; desktop?.socket?.destroy(); persist();
    if (typingTicket) await post('ilink/bot/sendtyping', { ilink_user_id: account.user, typing_ticket: typingTicket, status: 2 }, 2000).catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  void connectLoop();
  const timer = setInterval(() => { void flush(); void drain(); }, 3000);
  timer.unref();
  const thinkingTimer = setInterval(() => { void updateThinking(); }, 1000);
  thinkingTimer.unref();
  await post('ilink/bot/msg/notifystart', {}).catch(() => {});
  log('微信桥接运行中；请保持 Codex 桌面打开。');
  while (!stopping) {
    try {
      const r = await post('ilink/bot/getupdates', { get_updates_buf: state.cursor }, 40000);
      for (const m of r.msgs || []) {
        if (m.from_user_id !== account.user || m.message_type !== 1 || m.group_id || !m.context_token) continue;
        state.context = m.context_token;
        const id = String(m.message_id || m.client_id || '');
        if (!id || state.inbound.some(i => i.id === id)) continue;
        const text = (m.item_list || []).filter(i => i.type === 1).map(i => i.text_item?.text || '').join('\n').trim();
        const clientId = randomUUID(); state.inbound.push({ id, clientId });
        const control = command(text, state.view);
        if (text && text.length <= 40000 && !control) state.queue.push({ text, clientId, status: 'pending' });
        persist();
        if (control) await handleCommand(control, id);
        else if (!text) await send('目前请发送文字消息；图片、语音和文件尚未接入。', 'unsupported-' + id);
        else if (text.length > 40000) await send('消息过长，请分成几段发送。', 'long-' + id);
        else log('收到绑定账号的微信文字消息。');
      }
      if (r.get_updates_buf) state.cursor = r.get_updates_buf;
      persist();
      await sleep(250);
    } catch (e) {
      if (e.name !== 'TimeoutError') log(`微信连接重试：${e.message}`);
      await sleep(e.message.includes('-14') ? 3600000 : 5000);
    }
  }
}

