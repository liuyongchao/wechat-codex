import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import path from 'node:path';
import { config, appPath, codexBinary } from './settings.mjs';
export async function withCatalog(fn) {
  const child = spawn(codexBinary(), ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let next = 0;
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => fail(Error('会话目录服务已断开')));
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const m = JSON.parse(line), p = pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } catch { fail(Error('会话目录响应格式错误')); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('读取会话目录超时')); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'wechat_codex_catalog', title: 'WeChat Codex Catalog', version: '0.1.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    return await fn(rpc);
  } finally { lines.close(); child.kill(); }
}
export async function listThreads() {
  return withCatalog(async rpc => {
    const all = [], projects = config().projects || [];
    for (const archived of [false, true]) {
      let cursor = null; const seen = new Set();
      do {
        const r = await rpc('thread/list', { archived, cursor, limit: 100, sortKey: 'updated_at', modelProviders: [], useStateDbOnly: true });
        all.push(...r.data.map(t => ({ id: t.id, title: t.name || t.preview?.split('\n')[0] || '未命名聊天', archived, updated: t.updatedAt, ...projectFor(t.cwd, projects) })));
        cursor = r.nextCursor;
        if (cursor && seen.has(cursor)) throw Error('会话列表游标重复');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return [...new Map(all.map(t => [t.id, t])).values()].sort((a, b) => b.updated - a.updated);
  });
}
export async function openThread(thread) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread.id)) throw Error('无效会话 ID');
  if (thread.archived) await withCatalog(rpc => rpc('thread/unarchive', { threadId: thread.id }));
  await promisify(execFile)('/usr/bin/open', ['-a', appPath(), `codex://threads/${thread.id}`]);
}
export function command(text, view = 'chat') {
  const t = text.trim();
  if (/^\/?项目列表$/.test(t)) return {kind:'projects'};
  const project = t.match(/^\/?查看项目\s+(\d+)$/); if (project) return {kind:'project',value:project[1]};
  if (view !== 'chat' && /^\d+$/.test(t)) return {kind:'number',value:t};
  if (/^(?:\/?(?:查看)?会话列表|\/会话)$/.test(t)) return { kind: 'list' };
  if (/^\/?下一页$/.test(t)) return { kind: 'page', delta: 1 };
  if (/^\/?上一页$/.test(t)) return { kind: 'page', delta: -1 };
  if (/^\/?当前会话$/.test(t)) return { kind: 'current' };
  if (/^\/?帮助$/.test(t)) return { kind: 'help' };
  let m = t.match(/^\/?搜索\s+(.+)$/s); if (m) return { kind: 'search', query: m[1].trim() };
  m = t.match(/^\/?切换\s+(\d+|[0-9a-f-]{36})$/i); if (m) return { kind: 'select', value: m[1] };
  return null;
}
export function selectedThread(catalog, value) {
  const t = /^\d+$/.test(value) ? catalog[Number(value) - 1] : catalog.find(t => t.id === value);
  if (!t) throw Error('没有这个编号，请发送“会话列表”后按列表编号切换。');
  return t;
}
export function pageText(catalog, page, selectedId) {
  const count = Math.max(1, Math.ceil(catalog.length / 8));
  if (!Number.isInteger(page) || page < 0 || page >= count) throw Error('已经到达列表边界。');
  const rows = catalog.slice(page * 8, (page + 1) * 8).map((t, i) => `${page * 8 + i + 1}. ${t.id === selectedId ? '【当前】' : ''}${t.archived ? '【归档】' : ''}[${t.projectLabel || '未归属项目'}] ${t.title.replace(/[\r\n]/g, ' ').slice(0, 100)}`);
  return `本机 Codex 会话：${catalog.length} 个 · 第 ${page + 1}/${count} 页\n${rows.join('\n') || '没有匹配的会话。'}\n\n发送“切换 3”选择编号；“下一页”“上一页”翻页；“搜索 关键词”筛选。选择归档会话会恢复该会话。`;
}

export function projectFor(cwd, projects) {
  if (typeof cwd !== 'string' || !cwd) return {projectId:null,projectLabel:'未归属项目'};
  const p = projects.filter(p => cwd === path.resolve(p.path) || cwd.startsWith(path.resolve(p.path) + path.sep)).sort((a,b)=>b.path.length-a.path.length)[0];
  return {projectId:p?.id || null,projectLabel:p?.label || '未归属项目'};
}
export function projectList(threads) {
  const projects = (config().projects || []).map(p=>({id:p.id,label:p.label,path:p.path,count:threads.filter(t=>t.projectId===p.id).length}));
  return [...projects,{id:null,label:'未归属项目',count:threads.filter(t=>t.projectId===null).length}];
}
export function projectPageText(projects) {
  return '📁 项目列表\n' + projects.map((p,i)=>`${i+1}. ${p.label}（${p.count} 个会话）`).join('\n') + '\n\n发送“查看项目 2”或直接回复编号。查看项目只筛选列表，切换会话才改变聊天对象。';
}
