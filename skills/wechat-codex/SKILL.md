---
name: wechat-codex
description: Set up, start, stop, troubleshoot or navigate a local WeChat ClawBot bridge to existing Codex Desktop chats on macOS. Use when the user requests WeChat/Codex synchronization, QR binding, history selection or project menus.
---

# WeChat Codex

Use the bundled scripts in `../../src/`, relative to this skill. This is a local macOS bridge, not a cloud service. Read `../../README.md` for usage and supported versions.

## Setup

1. Check Node.js 24+, desktop availability, and `node src/cli.mjs status`. Use the plugin root as cwd. Do not read or print credential files.
2. Use the host's `list_threads` and `list_projects` tools to identify the user-selected thread and local projects. Preserve project names. If the user wants to bind this chat, resolve its actual ID. Do not pick a different chat silently or create a new one.
3. Write a temporary JSON containing only local project IDs, names and root paths outside the plugin repository. Run `node src/cli.mjs init --thread THREAD_ID --projects-file TEMP_JSON`. Runtime state defaults to `$CODEX_HOME/wechat-codex`, or `~/.codex/wechat-codex`. An explicit `WECHAT_CODEX_STATE_DIR` overrides this. Never put runtime state inside the plugin checkout or release archive.
4. Run `npm install --ignore-scripts` in the plugin root when dependencies are missing. The only runtime dependency renders QR codes locally. Run `node src/cli.mjs login`, render the returned local `qr.png` for the user, and keep the process running while they scan. If the phone requires a pairing code, run `node src/cli.mjs verify DIGITS` in a separate process. Never ask the user to paste a bot token.
5. After binding, run `node src/cli.mjs check`, then `node src/cli.mjs start`. Have the user send a text in WeChat and verify both directions; distinguish API acceptance from actual phone display. Do not claim a connection is verified merely because the process launched.

## Operation

- `status`, `start`, `stop`: service lifecycle. Never start a second process for the same account/state directory.
- `threads`, `projects`: read-only diagnostics. A project map is a snapshot from setup; refresh it when projects change by stopping, rerunning init with the current selected thread and fresh project export, and starting.
- In WeChat: `项目列表`, `查看项目 2`, `会话列表`, `搜索 关键词`, `下一页`, `上一页`, `切换 3`, `当前会话`, `帮助`.
- A bare number selects only while viewing a menu; in a conversation it is normal message text. Project browsing filters the menu; only selecting a thread changes the target. Explain that selecting an archived conversation restores it.
- Preserve the existing thread's model and permissions. Approval/user-input requests remain in the desktop app. Do not approve actions automatically.
- Only the bound user's private text messages are accepted. Never extend the allowlist, post to other users, or add channels without explicit user authorization.
- Only native typing indicators are used. Do not add “thinking” emoji messages.

## Troubleshooting

Inspect private `bridge.log` only as needed and redact sensitive paths and content before sharing. Never include credentials, QR payloads, project exports, chat history or local app bundles in bug reports, commits or releases.

Desktop synchronization uses a versioned internal IPC interface. Unsupported versions fail closed. Do not patch the desktop app, disable approvals, bypass connection checks or silently replace desktop synchronization with a separate model conversation. Explain incompatibility honestly.
