# 生图能力调研与落点设计（2026-11-17）

> 调研单：weave 内置生图（对话可用，daemon 内置 HTTP MCP + REST，凭据进设置页）。
> 本页是调研结论，实施等用户对设计拍板。

## 一、litellm 网关实测矩阵（真凭据实测）

网关 = settings.ai.baseUrl（litellm proxy），凭据 = settings 表（本机令牌门后）。/v1/models 列出 15 个模型组，**全部 mode=chat/embedding/decisions，无一个 image mode**；上游约 20 家（内部 vLLM + api.site/moeapi/wjapi 等 AI 中转站 + 智谱/DeepSeek 官方）。

| 形态 | 端点 | 结果 | 备注 |
|---|---|---|---|
| OpenAI images API | `POST /v1/images/generations` | ❌ 400 | `images endpoint requires an image model`——网关路由表没配任何 image 模型组，试 gpt-image-1/dall-e-3/gemini-image/flux 全部 `Invalid model name`（litellm 校验在路由表） |
| chat 内嵌生图 | `POST /v1/chat/completions`（prompt 要图） | ❌ 文本 | 模型老实说「我无法直接输出图片」并回提示词——上游是纯 chat 模型 |
| chat modalities 参数 | `chat/completions + modalities:["image"]` | ❌ 400 | `openai does not support parameters: ['modalities']`（litellm 未开 drop_params） |
| **responses API + 生图工具** | `POST /v1/responses` + `tools:[{"type":"image_generation"}]` | ✅ **可用** | gpt-6-sol 上游带 OpenAI image_generation 工具；返回 `output[].type="image_generation_call"`，`result` = **b64 PNG**（实测 1536x1024，~1.5MB） |
| responses 不带工具 | `POST /v1/responses` | ❌ 无图 | 只回 reasoning+message，必须显式带 tools |
| 参数可控性 | tools 内 `size`/`quality` | ⚠️ 部分 | 默认（不传）恒成功；**传 size/quality 会打到「未开生图权限」的上游分组**（403/400 `Image generation is not enabled for this group`，litellm fallback 又会救回一部分）——`quality:"high"`+`size` 同发 400，只传 size 403 后 litellm 自动换上游成功过一次。结论：**首版不透传 size/quality，用上游默认（1536x1024 low），后续可加「重试即重打」的容错 |
| 耗时 | — | 30–125s | 两次实测 122s / 114s（含 reasoning）——**必须异步或长超时**，不能按普通 chat 超时设 |
| usage | — | input+output tokens | output_tokens 仅 63（工具调用走上游计费，网关只记 token 面账，cost:null） |

**核心结论：litellm 网关当下唯一可行的生图通道 = responses API 的 image_generation 工具，且仅 gpt-6-sol（及可能同上游的 gpt-5.6-sol）模型组可用。** `/v1/images/generations` 在网关侧是「配了 image 模型组才开」的形状——若管理员未来在 litellm 配置里加 image 模型组，该端点即成标准通道。故 provider 层应**两条都做、按探测可用性降级**：优先 images/generations（标准、便宜），404/模型不存在时回落 responses+image_generation 工具（现状唯一可用）。

### 补充实测（swagger 页核对，2026-11-17 第二轮）

网关根路径即 LiteLLM Swagger UI（`/openapi.json` 724 路径）。生图相关端点全集：`/v1/images/generations`、`/v1/images/edits`（multipart：image/mask）、`/openai/deployments/{model}/images/generations`（azure 形态）。逐个补测：
- `openapi.json` 里 `/v1/images/generations` 请求体为空定义（litellm 透传 OpenAI 协议，swagger 未展开）——**端点存在 ≠ 可用**，卡点仍在路由表无 image 模型组。
- `/openai/deployments/gpt-image-1/images/generations`：同 400 Invalid model name（azure 形态也过同一路由校验）。
- `/v1/images/edits`（gpt-6-sol + multipart 真图）：400 `requires an image model`——edits 同受路由限制。
- **responses 工具图编辑（input_image + image_generation 工具）**：三次实测 400/400/403，全部命中「Image generation is not enabled for this group」——**图编辑比纯生图更不稳定**（litellm fallback 漂移），首版明确不做，与上文「首版不做 edits」一致。
- 结论不变：responses + image_generation 工具仍是唯一稳定可用的通道；images/edits 即便未来路由放开也建议二次验证。

## 二、imageforge-mcp 包审（npm pack 实拆 0.6.2）

- MIT（2026 Image2Gen MCP contributors）；deps 仅 `@modelcontextprotocol/sdk` + `undici` + `zod`，与 weave 现有依赖兼容（SDK weave 已带）。
- 结构：`providers.js`（427 行，内建 openai/zhipu/minimax 三家：images/generations|edits 标准协议、URL 下载转 b64）+ `externalProviders.js`（891 行，19 家外部 provider：google/xai/stability/ideogram/recraft/bfl/luma/...，含 **submit-poll 异步任务契约**（task_id 轮询、状态路径启发式解析）与 reference-mode（style/character 图参考））+ `imageInput.js`（338 行：输入图加载/MIME 探测/缩放）。
- 凭据模型 = env（`OPENAI_API_KEY` 等）+ 请求参数可覆写——**参数覆写可直接换成 weave 设置页的值，env 只是缺省**，适配层复用无障碍。
- 质量评价：协议覆盖好（同步+异步+图参考）、防御性强（b64 校验、MIME 嗅探、SSRF 防护）、零状态。**适配层可复用度高；MCP 壳不用**（weave 自己有 registry.ts 一套），取其 provider 函数即可。
- 可复用判定：`providers.js` 的 openai 分支直接对 litellm 的 images/generations（标准 OpenAI 协议，baseUrl 指网关）——**但现状网关没开 image 路由，openai 分支空转**；真正当下能用的是 responses+工具那条，imageforge **没有**这个形态的适配（它只做 images API）⇒ responses 适配器需自研（薄，~100 行：拼 tools、扫 output[].image_generation_call、b64 解码）。

## 三、落点设计（待拍板）

### 模块划分
```
packages/weave-server/src/daemon/image/
├── registry.ts        # IMAGE_PROVIDERS 注册表（对齐 mcp/registry.ts 的 def 模式）：
│                      #   { id:'litellm', callGenerate(ctx,prompt,opts), callEdit? }
│                      #   首版一个 provider（litellm），双通道（images API → responses 回落）
├── responses-image.ts # 自研：responses API + image_generation 工具适配（~100 行）
└── types.ts           # GenerateImageRequest/Result（b64|mimeType|model|耗时|通道）
```
- `registry.ts` 对外两个口：`POST /api/image/generations`（REST）+ `daemon/mcp/image.ts` 新 MCP server（对齐 weave-sessions 的文件形状：TOOLS + callTool → 转发 daemon 自己的 REST——与现有四服务同构，工具 = generate_image / list_image_providers）。
- MCP 注册：`mcp/registry.ts` MCP_SERVERS 加一条 `{name:'weave-image', path:'/mcp/image'}`；`install/builtin-mcp.ts` BUILTIN_MCP_SERVERS 同步；provisionRole/scaffoldCoordinator 写进内建仓 `.mcp.json`。

### 凭据与配置（settings 页新「生图」段）
- 存 `settings` 表新段 `image: { provider:'litellm', model:'gpt-6-sol', apiKeyPath?:无|复用 ai.apiKey, timeoutMs, enabled }`——**凭据沿用 settings.ai.apiKey**（同一网关同一 key，首版零新增凭据面）；未来接外部 provider（imageforge 那 19 家）时每 provider 一条 key 落 settings 表，管理页逐条录入，永不进 env。
- 凭据只出现在服务端出站请求；API 日志侧已有截断脱敏（api-log.ts 现行规则覆盖）。

### 生成图落盘与返回
- **复用 uploads 内容寻址**：生成图写 `<data>/uploads/<sha256>.png`（零新目录零新清理面，历史气泡引用天然不破——被引用即永不删的现有语义直接适用）。
- 返回形状 = `{ imageId(sha256), url:'/images/<sha256>', b64?, size, model, durationMs, channel:'images-api'|'responses-tool' }`；b64 仅在调用方显式要时带（REST `?inline=1`），MCP 默认回 path+id（省 token）。
- 超时：网关实测 30–125s ⇒ REST 超时 180s、MCP 侧同步等待（MCP 工具调用本就长超时容忍）；后续量大再考虑 submit-poll 化（imageforge 的异步契约可抄）。

### 明确不做（首版）
- 图生图（edits）：网关 images/edits 未验证（同受「无 image 路由」限制），responses 工具型编辑待二次探测。
- 多 provider 并发/负载均衡；生成历史面板（生成记录走 api-log 现有面可查）。

## 四、风险与开放问题
1. **上游生图权限分组飘**：实测 size/quality 参数会命中「未开生图权限」的上游分组（litellm 多上游 fallback 导致同一模型组行为不稳定）⇒ 首版锁死默认参数最稳；错误文案要把「上游分组未开生图」翻译给用户（不是 weave 的错）。
2. 耗时 2 分钟级：对话框体验需要「生成中」态——建议首版只在 MCP/REST 层给同步接口，web 对话层的「生成中」气泡 UI 是独立小单。
3. `quality:high` 403 的「litellm fallback 救回」是偶然行为还是稳定语义未验证（样本 1）。
4. 模型名建议做成 settings 可配（默认 `gpt-6-sol`），网关侧加 image 路由后用户改配置即可切标准通道。
