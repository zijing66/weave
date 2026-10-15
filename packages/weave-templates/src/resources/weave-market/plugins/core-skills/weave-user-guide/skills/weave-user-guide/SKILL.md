---
name: weave-user-guide
description: weave 使用手册——CLI 命令、daemon 与 dashboard、认证与 HTTPS、数据目录落点、资源三层与包形态、消息/提醒/阻塞问答、AI 助手与排障。要回答「weave 怎么用 / 装在哪 / 怎么配 / 出问题怎么查」时使用。
---

# weave 使用手册

weave 是 coding agent 的 harness：在项目里接线 hook，把 agent 会话事件采集进本机 daemon（SQLite），再用一个浏览器 dashboard 统一管理多项目、多会话、多 harness（Claude Code / Codex）。

## 数据目录

Windows `%APPDATA%\weave\`，macOS/Linux `~/.config/weave/`：

| 路径 | 内容 |
|---|---|
| `weave.db` | SQLite（项目/会话/事件/序列/订阅） |
| `auth.json` | 密码 scrypt hash、会话签名密钥、本机令牌（0600，不进设置面） |
| `initial-password` | 首启随机密码，CLI 领取一次即删 |
| `push.json` | Web Push VAPID 密钥（0600） |
| `ai.json` | AI 助手的上游 API key（0600，只写不回显） |
| `market/<id>/` | 资源市场副本：内置仓 = `weave`，导入的市场各一份 |
| `certs/` | 局域网 HTTPS 自签证书 |
| `hooks/promptbox/` | prompt 兜底队列（daemon 只写、会话侧消费） |

## CLI 命令

| 命令 | 作用 |
|---|---|
| `weave init` | 在项目里接线：选 harness、装 hooks、生成 CLAUDE.md 的 weave 块、装命令/agent 模板 |
| `weave uninstall` | 逆向拆除 init 的接线（用户文件只按合并规则回退，不删用户内容） |
| `weave scan` | 扫描/重发现项目，纳入 dashboard 管理 |
| `weave status` | 当前项目接线与 daemon 状态概览 |
| `weave daemon start \| stop \| status` | daemon 生命周期；`DAEMON_HOST` 决定客户端连哪（与监听绑定是两回事） |
| `weave dashboard` | 起 daemon + 打开浏览器 dashboard |
| `weave chpass <新密码>` | 改 dashboard 密码（只认本机令牌，改密即全签发会话失效） |
| `weave doctor` | 诊断本机与 weave server 的接线（hook 落位/认证/连通逐项查） |

## daemon 与 dashboard

- daemon 常驻后台，单 SQLite 单进程；`GET /health` 探活，SSE `GET /events` 是唯一事件流。
- dashboard 功能域：
  - **项目/会话**：活动序会话列表、事件链回放（工具调用/输出镜像）、终端窗口角标；
  - **指令池**：给会话注入指令（inject 下一拍 / manual 立即）；
  - **Hooks 规则**：插件规则的开关与命中记录；
  - **问答**：远程作答阻塞中的 AskUserQuestion / 权限确认（数字键序镜像进终端模态框）；
  - **消息**：向其他会话发 prompt（原生中继 → 终端兜底 → 队列三层自动降级）、序列编排；
  - **提醒订阅**：目标会话 idle / 回合结束 / 消息失败时通知（页面 toast + 浏览器通知 + Web Push 三通道）；
  - **AI 助手**：右下角浮层问答，走服务端代理（地址/模型在设置，key 落 `ai.json`）；
  - **资源市场 / 工具箱**：市场导入与内置包启用（见下）。

## 认证、监听与 HTTPS

- 凭据三种：密码登录（`weave_session` cookie 30 天）、本机令牌 `x-weave-local`（CLI 与 hook 免密，同机即管理员）、改密仅 CLI。
- 监听：settings `server.bindHost`（默认 `0.0.0.0`，可收 `127.0.0.1`）；HTTPS 走 `server.tlsPort`（默认 6443、0 关），自签证书自动重签。手机要系统通知必须走 HTTPS origin。
- 访问地址清单：`weave daemon status` 或设置页 `urls`，同源派生。

## 资源三层与包形态

- 三层互不越级：**市场副本层**（`market/<id>/` 导入/移除）→ **安装层**（装进项目/全局位）→ **启用层**（开关，关≠卸载）。
- 包形态（`weave.json` 的 `kind`）：`skill`（`skills/<名>/SKILL.md`）、`rule`（weave 规则包）、`mod`（hooks.json + Register API，宿主 ≥ 2.1.287）、`hook`（classic hooks）、`surface`（裸 commands/agents/skills 解包进项目）。
- 带 `.claude-plugin/plugin.json` 的 CC 包：启用 = Claude 全局安装 + 项目开关；注册键 `<名>@<市场>`（内置 = `@weave`）。
- 内置包：weave-user-guide（本手册）、weave-plugin-creator（插件开发指南）、md-lint（markdown 规则）、file-guard / mission-control（mod）。

## 排障速查

- **会话不出现**：`weave doctor` 逐项查；确认 hook 已随 `weave init` 落位、daemon 在跑（`weave daemon status`）。
- **dashboard 打不开/401**：密码在 `initial-password`（首启）或 `weave chpass` 重置；本机 curl 带 `x-weave-local`（令牌在 `auth.json`）。
- **手机收不到通知**：必须 HTTPS 访问（`server.tlsPort`）、浏览器通知权限、订阅一次 Web Push。
- **包启用了没生效**：mod 看宿主版本闸；CC 包看 `claude plugin list` 是否有 `<名>@weave`；规则类包首见默认停用，需在 Hooks 规则面再开。
- **消息发出去没动静**：目标会话可能 Held/Refused（发送侧判不了），看在途角标与 `stalled` 状态，可手动重发。
