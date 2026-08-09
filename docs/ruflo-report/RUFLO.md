# RuFlo（claude-flow v3.34.0）完整功能报告

> 基于对 `D:\GitRepo\AIRepo\ruflo` 仓库的深度代码研读整理。
> 生成日期：2026-08-09

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈与架构](#2-技术栈与架构)
3. [CLI 命令体系](#3-cli-命令体系)
4. [初始化系统](#4-初始化系统)
5. [插件系统](#5-插件系统)
6. [内容资产：Skills / Commands / Agents](#6-内容资产skills--commands--agents)
7. [MCP Server 能力](#7-mcp-server-能力)
8. [Hooks 事件系统](#8-hooks-事件系统)
9. [记忆系统](#9-记忆系统)
10. [高级能力](#10-高级能力)
11. [设计模式](#11-设计模式)
12. [对 Weave 的参考价值](#12-对-weave-的参考价值)

---

## 1. 项目概览

**RuFlo**（npm: `claude-flow` v3.34.0，本地二进制名 `ruflo`）是一个**企业级 AI agent 编排平台**，定位为 Claude Code 与 OpenAI Codex 的 **"Meta-Harness"**（元框架层）。

**核心思想**：`Agent = Model + Harness`。RuFlo 提供执行层（harness），为 LLM 增加：
- 60–100+ 专用 AI agent（协调成 swarm）
- 自学习记忆系统（向量数据库 + HNSW + Graph RAG）
- MCP（Model Context Protocol）服务器集成
- 跨机器联邦协作（加密身份）
- 35+ 插件架构
- 企业级安全防护

**规模数字**：
| 资产 | 数量 |
|------|------|
| CLI 注册命令 | 53 个（README 称完整安装 60+） |
| 插件目录 | 38 个（官方 35 个 + 3 新增） |
| Skills | 109 个（codex 清单）+ 39 个（.claude/skills） |
| Commands | 168 个（19 个分类目录） |
| Agents | 108 个（27 个分类目录） |
| MCP 工具 | 300+（init.ts 宣称 314+，定义约 380 条） |
| 后台 worker | 10–12 个 |
| Rust crates | 2 个（federation-peer、agntcy） |

---

## 2. 技术栈与架构

### 2.1 技术栈

| 层面 | 技术 |
|------|------|
| 主语言 | TypeScript（ES2022, ESM, Node 20+） |
| 辅助语言 | Rust（2 crates：`ruflo-federation-peer`、`ruflo-agntcy`）、WASM |
| 包管理 | 根目录 npm + `v3/` 内 pnpm workspaces（25+ 子包） |
| CLI | 自定义 `CommandParser`（非 commander） |
| 校验 | Zod |
| 数据库 | better-sqlite3 / sql.js（WASM）/ AgentDB（向量） |
| 加密 | @noble/ed25519 |
| 测试 | vitest（London School TDD） |
| 构建 | tsc + Cargo（Rust workspace） |

### 2.2 目录结构

```
ruflo/
├── bin/                  # CLI 入口（代理到 v3/@claude-flow/cli）
├── ruflo/                # 独立 npm 包 "ruflo"（品牌包装层）
├── v3/                   # 主 monorepo（pnpm workspaces）
│   ├── @claude-flow/     # 25+ 核心包
│   │   ├── cli/          # CLI 入口（26+ 命令）
│   │   ├── mcp/          # MCP server 框架
│   │   ├── memory/       # AgentDB + HNSW 向量搜索
│   │   ├── swarm/        # 15-agent 协调
│   │   ├── hooks/        # 18 事件 hooks + workers
│   │   ├── codex/        # 双模式（Claude + Codex）
│   │   └── shared/       # 共享类型/事件/插件注册
│   ├── src/              # DDD 领域模块
│   └── crates/           # Rust crates
├── plugins/              # 38 个 Claude Code 插件
├── .claude/              # 工作空间配置（skills/commands/agents/helpers）
├── .agents/              # 5500+ SKILL.md
├── .harness/             # Manifest + MCP 策略
└── docs/                 # 30 万行文档
```

### 2.3 架构风格

**DDD（领域驱动设计）**，分层：
- **Domain**：`Agent`、`Task`、`Memory` 实体
- **Application**：`SwarmCoordinator`、`WorkflowEngine`
- **Infrastructure**：`PluginManager`、`MCPServer`、memory backends
- **Shared**：事件总线、config loader、resilience patterns

**关键架构决策**（10 个 ADR）：
- ADR-001: 采用 agentic-flow 作为核心基础
- ADR-004: 插件化架构（microkernel）
- ADR-005: MCP-first API 设计
- ADR-006: 统一记忆服务
- ADR-007: 事件溯源（event sourcing）

---

## 3. CLI 命令体系

三层 CLI 入口：根 `bin/cli.js` → `ruflo/` 品牌层 → `v3/@claude-flow/cli/bin/cli.js`（真实入口，339 行，含 MCP 模式检测）。

### 3.1 primary 核心命令（同步加载）

| 命令 | 子命令 | 功能 |
|------|--------|------|
| `init` | wizard / check / skills / hooks / upgrade | 初始化（交互向导 / 检查 / 装 skills / 配 hooks / 升级） |
| `start` | stop / restart | 启动编排系统 |
| `status` | — | 系统状态（swarm 健康、agent 数、MCP、memory） |
| `agent` | spawn / list / terminate / status | Agent 生命周期管理 |
| `swarm` | init / status / scale | Swarm 协调（topology、max-agents） |
| `memory` | store / search / list / path | 记忆存取 |
| `task` | create / list / status | 任务管理 |
| `session` | list | 会话管理 |
| `mcp` | start / tools / enable / disable | MCP server 管理 |
| `hooks` | pre-edit / post-edit / route / pretrain | 自学习 hooks |

### 3.2 advanced 高级命令

| 命令 | 功能 |
|------|------|
| `neural` | WASM SIMD 神经模式训练（MicroLoRA + Flash Attention） |
| `security` | 代码/依赖安全扫描（CVE） |
| `policy` | Agentic 策略引擎（动作评估、规则管理） |
| `performance` | 基准/剖析/优化建议 |
| `embeddings` | 向量嵌入生成/搜索 |
| `hive-mind` | 蜂群心智（topology/consensus） |
| `ruvector` | PostgreSQL 向量桥接（FlashAttention-3, Graph RAG） |
| `guidance` | 引导控制平面（CLAUDE.md → 策略包） |
| `autopilot` | 自动驾驶循环 |

### 3.3 utility / analysis / management

| 类别 | 命令 |
|------|------|
| utility | `config`、`doctor`、`daemon`、`completions`、`migrate`、`workflow` |
| analysis | `analyze`（diff 风险评估）、`route`（Q-Learning 路由）、`progress` |
| management | `providers`、`plugins`、`deployment`、`claims`、`issues`、`update`、`process`、`appliance`、`cleanup` |

### 3.4 平台/治理命令

`metaharness`（14 子命令：score/threat-model/mcp-scan 等）、`eject`、`version`、`verify`、`funnel`、`settings`、`auth`、`proxy`、`advisor`、`spinner`、`announcements`、`transport`、`benchmark`、`gaia-bench`

---

## 4. 初始化系统

### 4.1 Init 命令（1676 行）

子命令：`wizard`（交互式向导）、`check`、`skills`、`hooks`、`upgrade`

主要 flags：`--force/-f`、`--minimal/-m`、`--full`、`--cloud-mcp`、`--skip-claude`、`--only-claude`、`--no-global`、`--start-all`、`--with-embeddings`、`--codex`、`--dual`、`--no-codex-detect`

### 4.2 三档预设

| 预设 | 内容 |
|------|------|
| **DEFAULT** | 全部组件 + 15 max-agents + hybrid memory + HNSW + 全部 hooks |
| **MINIMAL** | settings + skills + MCP + runtime + CLAUDE.md，仅 core skills，5 agents，in-memory |
| **FULL** | DEFAULT + flowNexus + dualMode + 全部命令/agents + 双 MCP server |

### 4.3 Init 执行流程（9 步）

1. 平台检测（OS/arch/Node/shell）
2. 建 `.claude/`（skills/commands/agents/helpers）+ `.claude-flow/`（data/logs/sessions/hooks）
3. settings.json 生成（hooks 配置、statusLine、permissions、env）
4. MCP 配置生成（平台感知：Windows 用 `cmd /c npx`）
5. Skills 复制（按集合：core/browser/agentdb/github 等）
6. Commands 复制（按分类 19 类）
7. Agents 复制（按分类 27 类）
8. Helpers 生成（hook-handler、auto-memory-hook、statusline、pre-commit 等）
9. Runtime 配置写入 `.claude-flow/config.yaml`

同时：自动检测 Codex CLI 并配置（`--dual` 双模式）、注册 ruflo skill 到 `.agents/skills/`、可选启动 daemon/memory/swarm。

### 4.4 CLAUDE.md 生成器

6 套模板：`minimal` / `standard` / `full` / `security` / `performance` / `solo`。段落包括：行为规则、12 步策略实施循环、agent 通信协议、capability brain 集成。

---

## 5. 插件系统

### 5.1 架构

双插件系统：
- **v3 PluginManager**（microkernel，extension points + priority）
- **shared plugin-registry**（5 种扩展点：agent types、task types、MCP tools、CLI commands、memory backends）

### 5.2 插件清单（38 个，按功能域）

**Core & Orchestration**
| 插件 | 功能 |
|------|------|
| `ruflo-core` | 基础：MCP server、status、coder/researcher/reviewer |
| `ruflo-swarm` | Swarm 拓扑 + Monitor 监控 |
| `ruflo-autopilot` | 自主任务自动完成 |
| `ruflo-loop-workers` | 12 个后台 worker |
| `ruflo-workflows` | 工作流模板/并行/分支 |
| `ruflo-federation` | 零信任跨机器 agent 联邦 |
| `ruflo-bbs-federation` | AgentBBS 联邦房间 |

**Memory & Knowledge**
| 插件 | 功能 |
|------|------|
| `ruflo-agentdb` | AgentDB + HNSW 向量搜索 |
| `ruflo-rag-memory` | SOTA RAG（混合搜索、Graph RAG、MMR） |
| `ruflo-rvf` | 便携记忆格式 |
| `ruflo-ruvector` | FlashAttention-3、103 个 MCP 工具、Brain AGI |
| `ruflo-knowledge-graph` | 实体抽取、pathfinder |
| `ruflo-graph-intelligence` | 图智能引擎、PageRank |

**Intelligence & Learning**
| 插件 | 功能 |
|------|------|
| `ruflo-intelligence` | SONA 神经模式、轨迹学习 |
| `ruflo-daa` | 动态 Agentic 架构 |
| `ruflo-ruvllm` | 本地 LLM（Ollama）、MicroLoRA |
| `ruflo-goals` | GOAP 规划、深度研究 |
| `ruflo-metaharness` | MetaHarness 集成 |
| `ruflo-arena` | 竞争性竞技场/锦标赛 |

**Architecture & Methodology**
`ruflo-adr`（ADR 生命周期）、`ruflo-ddd`（DDD 脚手架）、`ruflo-sparc`（5 阶段方法论）

**Quality & Security**
`ruflo-security-audit`（CVE 扫描）、`ruflo-aidefence`（prompt 注入检测）、`ruflo-testgen`（TDD）、`ruflo-browser`（Playwright）

**Development Tools**
`ruflo-jujutsu`、`ruflo-docs`、`ruflo-agent`（WASM 沙箱 + Managed Agents）、`ruflo-plugin-creator`、`ruflo-migrations`、`ruflo-observability`、`ruflo-cost-tracker`

**Domain-Specific**
`ruflo-iot-cognitum`、`ruflo-neural-trader`（112+ 工具）、`ruflo-market-data`、`ruflo-business-pods`、`ruflo-agntcy`

---

## 6. 内容资产：Skills / Commands / Agents

### 6.1 Skills（109 个 codex 清单 + 39 个实际目录）

**核心技能（6）**：`swarm-orchestration`、`memory-management`、`sparc-methodology`、`security-audit`、`performance-analysis`、`github-automation`

**高级技能（38）**：`agentdb-*`（6 个）、`github-*`（6 个）、`flow-nexus-*`（3 个）、`v3-*`（9 个）、`hive-mind`、`neural-training`、`embeddings`、`claims` 等

**Agent 技能（65）**：`agent-coder`、`agent-reviewer`、`agent-researcher`、`agent-planner`、`agent-tester`、各类 coordinator 等

模板：`minimal`(2) / `default`(4) / `full`(137+) / `enterprise`(137+)

### 6.2 Commands（168 个，19 类）

| 分类 | 数量 | 代表 |
|------|------|------|
| sparc | 32 | architect / coder / orchestrator / tdd |
| github | 19 | code-review / pr-manager / release-manager |
| swarm | 17 | swarm-init / swarm-spawn / swarm-monitor |
| hive-mind | 12 | hive-mind-init / consensus / memory |
| flow-nexus | 9 | app-store / payments / sandbox |
| hooks | 8 | pre-edit / post-edit / session-end |
| analysis | 7 | bottleneck-detect / token-usage |
| automation | 7 | auto-agent / self-healing / smart-agents |
| coordination | 7 | agent-spawn / orchestrate |
| pair | 7 | start / session / modes |
| monitoring | 6 | agent-metrics / status |
| optimization | 6 | auto-topology / parallel-execute |
| training | 6 | neural-train / pattern-learn |
| workflows | 6 | development / research / workflow-create |
| agents | 5 | agent-capabilities / agent-types |
| memory | 5 | memory-persist / memory-search |
| 其他 | 5 | verify / stream-chain / truth |

### 6.3 Agents（108 个，27 类）

| 分类 | 数量 | 代表 |
|------|------|------|
| core | 5 | **coder / planner / researcher / reviewer / tester** |
| v3 | 10 | v3-queen-coordinator / security-architect / memory-specialist |
| github | 13 | code-review-swarm / pr-manager / multi-repo-swarm |
| consensus | 7 | byzantine-coordinator / raft-manager / gossip |
| templates | 9 | coordinator-swarm-init / implementer-sparc-coder |
| flow-nexus | 9 | app-store / payments / sandbox |
| hive-mind | 5 | queen-coordinator / scout-explorer |
| optimization | 5 | load-balancer / performance-monitor |
| sublinear | 5 | consensus-coordinator / pagerank-analyzer |
| swarm | 3 | adaptive / hierarchical / mesh-coordinator |
| 其他 | 27+ | testing、sparc、goal、analysis、development、devops 等 |

---

## 7. MCP Server 能力

### 7.1 框架（@claude-flow/mcp）

MCP **2025-11-25 规范**兼容的独立服务器：
- Transports：stdio / HTTP / WebSocket / in-process
- 能力：Resources、Prompts、Tasks（异步+取消）、cursor 分页、连接池（max 10）、认证、CORS、速率限制
- 内建系统工具：`system/info`、`system/health`、`system/metrics`

### 7.2 业务工具（40 模块，300+ 工具）

| 模块 | 工具数 | 域 |
|------|--------|-----|
| wasm-agent-tools | 27 | Agent WASM 沙箱 |
| browser-tools | 23 | 浏览器自动化 |
| system-tools | 19 | 系统 |
| agentdb-tools | 20 | 向量记忆 |
| metaharness-tools | 16 | Harness 治理 |
| memory-tools | 15 | 记忆 |
| capability-brain | 12 | 能力规划 |
| claims-tools | 12 | 权限 |
| workflow-tools | 12 | 工作流 |
| transfer-tools | 11 | 去中心化传输 |
| autopilot / hive-mind / swarm / ruvllm / embeddings | 各 10 | 各域 |
| 其余 30 模块 | 1–9 | analyze/neural/security/policy 等 |

---

## 8. Hooks 事件系统

### 8.1 事件类型（18 个）

| 生命周期 | 事件 |
|----------|------|
| 工具 | PreToolUse、PostToolUse |
| 文件 | PreEdit、PostEdit、PreRead、PostRead |
| 命令 | PreCommand、PostCommand |
| 任务 | PreTask、PostTask、TaskProgress |
| 会话 | SessionStart、SessionEnd、SessionRestore |
| Agent | AgentSpawn、AgentTerminate |
| 路由/学习 | PreRoute、PostRoute、PatternLearned |

优先级：Critical(1000) > High(100) > Normal(50) > Low(10) > Background(1)

### 8.2 实际启用的 hooks（settings.json）

| 事件 | 匹配器 | 用途 |
|------|--------|------|
| PreToolUse | Bash | 命令安全拦截/路由 |
| PostToolUse | Write\|Edit\|MultiEdit | 文件写入后处理 |
| UserPromptSubmit | 全部 | 任务路由 |
| SessionStart | 全部 | 会话恢复 + 自动记忆导入 |
| SessionEnd | 全部 | 会话清理 |
| Stop | 全部 | 记忆同步 |
| PreCompact | manual | 压缩前处理 |

### 8.3 能力

Hook Registry（优先级+过滤）、Executor（超时/错误恢复）、3 个后台守护、11+ worker、statusline 集成、ReasoningBank 学习路由

---

## 9. 记忆系统

### 9.1 Backends

| 后端 | 说明 |
|------|------|
| SQLite | better-sqlite3 原生 |
| sql.js | WASM 兜底 |
| AgentDB | 向量数据库（HNSW） |
| **Hybrid（默认）** | sql.js + AgentDB 混合 |
| RVF | 便携记忆格式 |

### 9.2 向量搜索

- **HNSW 索引**：持久化快照，0.53ms/搜索、1889 ops/s，4 种距离度量
- **量化**：Binary/Scalar/Product，4–32x 内存压缩
- **混合检索**：Reciprocal Rank Fusion + MMR 多样性
- **优雅降级**：embedder 不可用时回退 FTS5 关键词搜索

### 9.3 上层能力

MemoryService、Consolidator（去重+压缩）、AutoMemoryBridge（↔ Claude auto memory）、Self-Learning（SONA/ReasoningBank）、Knowledge Graph（PageRank）、Agent-Scoped Memory（3 作用域）、TieredMemory、LRU Cache、15+ 记忆控制器、MemoryDistill

---

## 10. 高级能力

| 能力 | 说明 |
|------|------|
| **Swarm 协调** | 15-agent，hierarchical-mesh 拓扑，任务路由、负载均衡、共识（Raft/Gossip/Byzantine） |
| **Workflow Engine** | 依赖解析、并行执行、回滚、暂停/恢复 |
| **事件溯源** | SQLite 事件存储，append-only log、replay、projections、snapshot |
| **神经训练** | WASM SIMD，MicroLoRA + Flash Attention，SONA 模式 |
| **Federation** | 跨机器 agent 协作，ed25519 加密身份，零信任 |
| **安全防护** | prompt 注入拦截、PII 检测、CVE 扫描、MCP 策略（default-deny） |
| **MetaHarness** | .harness/manifest.json（SHA256 指纹）、threat-model、OIA audit、witness 签名 |
| **Resilience** | 熔断器、重试、限流、bulkhead |
| **Codex 双模式** | 同时为 Claude Code + OpenAI Codex 配置 |
| **Helper 自刷新** | 版本戳 + SHA256 签名验证，自动更新 |
| **Cost Tracking** | token 用量、预算告警、成本优化 |

---

## 11. 设计模式

| 模式 | 应用 |
|------|------|
| **DDD** | 分层架构，bounded contexts |
| **CQRS** | swarm 命令对象（CreateTaskCommand 等） |
| **Event Sourcing** | 事件存储 + 重放 + projections |
| **Microkernel** | 双插件系统，extension points |
| **Template Method** | BasePlugin 生命周期 |
| **Resilience** | 熔断/重试/限流/bulkhead |
| **事件总线** | 类型订阅、通配符、once-handler |

---

## 12. 对 Weave 的参考价值

Weave 定位：**轻量 harness 注入工具**（非完整编排平台）。以下是按借鉴优先级划分的参考建议：

### 高价值（建议优先参考）

| RuFlo 能力 | Weave 借鉴点 | 优先级 |
|-----------|-------------|--------|
| **CLI CommandParser** | 子命令嵌套、flag 类型、choices 校验 | 已完成（自定义 parser） |
| **init executor 流程** | 平台检测 → 目录 → settings → 模板 → helpers | 已完成（9 步流程） |
| **settings.json 生成** | hooks 嵌套结构、permissions、statusLine | 已完成（结构已确认正确） |
| **Helper 版本戳 + 自刷新** | E3：版本戳 + 自动更新 + SHA256 校验 | P2 待做 |
| **CLAUDE.md 多模板** | minimal/standard/full 分段组合 | 已完成 |
| **Hooks 事件分发** | 按事件类型路由到不同动作 | P1 待做（当前仅打日志） |

### 中价值（按需参考）

| RuFlo 能力 | Weave 借鉴点 | 优先级 |
|-----------|-------------|--------|
| **MCP server** | 实现 `weave mcp start`（stdio） | P2（当前无此命令） |
| **status 命令丰富化** | swarm 健康、agent 数、记忆状态 | P1 |
| **项目自动检测** | 语言/框架检测，选模板 | P1 |
| **插件注册表** | TemplateRegistry 扩展为可注册 | P2 |

### 低价值 / 不借鉴（Weave 定位不覆盖）

swarm 编排、神经训练、联邦协作、事件溯源、CQRS、graph RAG、知识图谱、arena 竞技场、policy 引擎、GAIA 基准、Cognitum 云服务 —— 这些属于完整 agent 编排平台范畴，超出 harness 工具定位。

---

*报告完。用于 Weave 实现时选择性参考。*
