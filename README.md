# WeChat Codex

在微信里继续你已有的 Codex 桌面会话。

A local macOS plugin that bridges WeChat ClawBot and existing Codex Desktop chats.

使用微信官方 ClawBot 通道；这是社区项目，与腾讯、微信或 OpenAI 无隶属关系。

## 能做什么

- 微信文字提交到选中的桌面会话，继续原有上下文。
- 桌面上的双方新消息同步到微信；长回复按段发送。
- 浏览、搜索、分页并切换本机历史会话，包括归档会话。
- 先选项目再选会话，列表显示项目名称。
- 显示微信原生输入状态，不额外发送“思考中”图标消息。
- 继承会话设置；审批和需要用户确认的操作在电脑端处理。

一次同步一个会话。电脑、Codex 桌面和桥接进程必须保持运行；没有云中转服务器。

## 要求与兼容性

- macOS、Node.js 24+、支持插件的 Codex 桌面，以及可使用 ClawBot 的微信账号。
- 会话目录使用 Codex app-server；桌面同步使用**内部 IPC**，不是稳定的公开 API。当前在随桌面附带的 Codex CLI `0.159.2`、会话事件协议 v11 上验证。桌面升级可能需要适配；不支持的事件版本会中断订阅。
- 仅支持本机文字会话。不支持群聊、图片、语音、文件或远程主机会话。
- “实时”是约 3 秒检查一次增量，未完成的回复累计至少 60 字符才发送，完成后补发余量；不是逐字编辑同一条微信消息。

## 安装插件

在已有 `codex` CLI 的终端运行：

```sh
codex plugin marketplace add liuyongchao/wechat-codex
codex plugin add wechat-codex@wechat-codex
```

重新加载插件后，在 Codex 里说：

> 使用 wechat-codex，绑定当前会话到微信，并导入本机项目列表。

插件提供配置和运行脚本的技能；安装插件本身不会自动读取微信凭证或启动同步。Codex 会使用会话和项目工具选择实际会话，安装二维码依赖并引导扫码。

也可以克隆后注册本地插件市场：

```sh
git clone https://github.com/liuyongchao/wechat-codex.git
cd wechat-codex
codex plugin marketplace add "$PWD"
codex plugin add wechat-codex@wechat-codex
```

## 手动运行

在仓库目录下运行（Node 需在 PATH 中）：

```sh
npm install --ignore-scripts
node src/cli.mjs threads
node src/cli.mjs init --thread YOUR_THREAD_UUID
node src/cli.mjs login
```

用微信扫描终端二维码，也可打开命令显示的 `qr.png`。扫码命令需保持运行；如手机显示配对数字，在另一终端运行 `node src/cli.mjs verify 数字`。

```sh
node src/cli.mjs check
node src/cli.mjs start
node src/cli.mjs status
# 停止：
node src/cli.mjs stop
```

`check` 只验证桌面订阅，不能证明手机端收发正常。启动后从微信发送一条文字建立回复上下文，再确认微信和桌面均显示消息。需要调试时，可在停止后台进程后用绝对路径运行 `node /完整路径/wechat-codex/src/cli.mjs run`。

## 项目与会话菜单

| 微信消息 | 作用 |
| --- | --- |
| `项目列表` | 显示配置的项目及会话数量 |
| `查看项目 2` | 筛选该项目下的会话 |
| `会话列表` / `查看会话列表` | 全部本机会话，每页 8 条 |
| `搜索 关键词` | 搜索会话标题 |
| `下一页` / `上一页` | 翻页 |
| `切换 3` | 继续列表中第 3 个会话 |
| `当前会话` | 查看当前聊天对象 |
| `帮助` | 显示命令说明 |

菜单中可以直接回复编号。选中会话后，纯数字恢复为普通聊天内容。浏览项目不会自动改变聊天对象；切换归档会话会恢复归档并在桌面打开。首次启动不会重发全部历史消息。

项目目录由 Codex 的 `list_projects` 导出为私有 JSON：

```json
[{"id":"example-project","label":"示例项目","path":"/absolute/path/to/project"}]
```

停止同步后，用当前选中的会话 ID 更新：

```sh
node src/cli.mjs init --thread CURRENT_THREAD_UUID --projects-file /private/path/projects.json
node src/cli.mjs start
```

按会话工作目录匹配最深的项目根路径，未匹配者显示“未归属项目”。这是一份配置快照；新增、移动项目后需重新导入。位于根目录外的 worktree 需要单独加入路径映射。

## 私有状态

默认保存于 `$CODEX_HOME/wechat-codex`（未设 CODEX_HOME 时为 `~/.codex/wechat-codex`），与插件源码分开。里面包含绑定凭证、微信上下文、待提交消息、游标和日志；**不要上传或分享该目录**。

| 环境变量 | 用途 |
| --- | --- |
| `WECHAT_CODEX_STATE_DIR` | 自定义私有状态目录 |
| `WECHAT_CODEX_APP` | 自定义桌面 `.app` 路径 |
| `WECHAT_CODEX_CLI` | 自定义 Codex CLI 路径 |
| `CODEX_HOME` | Codex 数据根目录，含桌面 IPC socket |

只接收扫码绑定用户的私聊文字，不接收其他用户或群消息。发送给 Codex 的内容遵循你现有的 Codex 配置和服务条款。桌面中选定会话的新文字会发送至微信；如包含敏感内容，请停止同步。

## 故障处理

- 无法订阅：打开 Codex 桌面中的选定会话，运行 `check`；检查应用路径及版本。
- 微信无回复：先从微信主动发一条消息；检查 `status` 和私有 `bridge.log`。凭证失效时先 `stop`，再 `login` 重新扫码。
- 队列停住：桌面忙时等待上一轮结束。如果提交结果不明，消息标记为 `unknown`，通过后续桌面快照核对。不会盲目重发；若始终无法确认，请先在桌面确认是否已收到该内容，再停止桥接并处理私有队列。
- 断线恢复：持久化游标和发送位置，重连后继续。网络中断或进程崩溃时仍可能重复，不能保证严格“只发送一次”。
- 不会自动开机启动；重新开机后自行运行 `start`。

## 开发与许可

```sh
npm install --ignore-scripts
npm test
```

测试覆盖增量补丁、协议来源、域名校验、消息请求、菜单/项目匹配、配置保护与包内容检查。桌面 IPC 和微信实机验证需要本机已绑定环境，CI 不会访问真实账号。

MIT，见 [LICENSE](LICENSE)。协议参考及依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。欢迎小范围修复；提交前运行测试，勿附带凭证、二维码或真实聊天记录。
