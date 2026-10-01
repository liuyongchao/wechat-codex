import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export const DATA = path.resolve(process.env.WECHAT_CODEX_STATE_DIR || path.join(CODEX_HOME, 'wechat-codex'));
export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function save(name, value) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const file = path.join(DATA, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function config() { return load('config.json', {}); }
export function appPath() {
  return process.env.WECHAT_CODEX_APP || ['/Applications/ChatGPT.app', '/Applications/Codex.app'].find(p => fs.existsSync(p)) || '/Applications/ChatGPT.app';
}
export function codexBinary() {
  if (process.env.WECHAT_CODEX_CLI) return process.env.WECHAT_CODEX_CLI;
  const app = appPath();
  return [path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'), path.join(app, 'Contents/Resources/codex')].find(p => fs.existsSync(p)) || 'codex';
}
export function validateConfig(value) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.threadId || '')) throw Error('必须提供有效的 Codex 会话 ID');
  if (!Array.isArray(value.projects)) throw Error('projects 必须是数组');
  for (const p of value.projects) {
    if (!p.id || typeof p.id !== 'string' || !p.label || typeof p.label !== 'string' || typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw Error('项目需要 id、label 和绝对路径 path');
  }
  if (new Set(value.projects.map(p => p.id)).size !== value.projects.length) throw Error('项目 ID 不能重复');
  return value;
}
