# 001 · 代码底座审计报告

> Task 001 交付 1–3：原项目架构分析、可复用模块、保留/重构/删除建议。
> 审计基准：
> - **metabrain-mcp** = `MetaBrain-Labs/ComfyUI-MCP-Server-TypeScript` @ `765c713`（2026-03-20），MIT，TypeScript，约 4700 行 —— **主底座候选**
> - **comfy-org-mcp** = `Comfy-Org/comfy-mcp` @ `5e4904f`（2026-11-05），Python，约 18400 行 —— **仅设计参考**
>
> 方法：三个并行子审计（MCP/工作流层、客户端/执行层、官方参考），只读源码，结论均附 file:line。文中路径相对各仓库根目录。

---

## 1. metabrain-mcp 架构分析

### 1.1 总体结构

四层，单向依赖，但层内耦合较重：

```
src/index.ts (Express + StreamableHTTP)  ─┐
src/server-stdio.ts (stdio)              ─┤→ ComfyMcpManager (tools/index.ts)
                                           │    ├→ 15 个静态工具 (tools/handlers/*)
                                           │    └→ 内存动态工作流 Map (services/dynamic-tool.ts)
                                           ↓
services/business.ts（编排）→ services/task/*（等待/查询）→ services/workflow/executor.ts
                                           ↓
api/api.ts + api/http.ts (axios)  +  utils/ws.ts (ws)  +  services/storage/*（文件落盘）
```

- **传输**：双入口。HTTP 模式每个会话独立 `McpServer` 实例（`src/index.ts:93`，工厂在 `src/tools/index.ts:54-87`），会话 Map + 30 分钟超时清理；stdio 入口 `src/server-stdio.ts:8-18`。
- **工具注册**：`ComfyMcpManager` 全局单例，注册 15 个静态工具 + 1 个 Prompt（`src/tools/index.ts:24-99`）。**并非每工作流一个 MCP 工具**——`mount_workflow` 只把 API JSON 存入内存 Map，`tools/list` 恒定不变。
- **定位判定**：它的"Workflow as a Tool"实际是三步对话协议（catalog → mount → queue_prompt），靠 LLM 记忆 `workflowName` 传参，参数发现成本全部压在对话上下文上。

### 1.2 工作流加载与参数机制

- **三来源合并**到单一目录文件 `workflow/workflow.json`（`src/constants/common.ts:8-10`）：① ComfyUI `/history` 历史任务；② ComfyUI userdata `workflows/` 目录——通过**逐个真实入队再 interrupt 的"巡检"**（`src/services/workflow/executor.ts:38-66`）；③ 本地 `./workflow/*.json`。
- **标记协议**（`src/utils/format.ts:15-20`）：节点 `_meta.title` 匹配 `==(.+?)==` 者为工作流名注释节点；title 以 `=>` 开头的节点，其全部非连接输入暴露为参数。
- **类型系统**：仅 `typeof` 推断 string/number/boolean/array 四类（`src/services/dynamic-tool.ts:71-77`）。生成的 Zod schema（`:83-113`）**存而不用**——实际执行的 `queue_prompt.params` 是 `record(any)`，无枚举、无范围、无必填校验。
- **映射**：`mergeParamsToWorkflow`（`dynamic-tool.ts:193-223`）按 `nodeId_inputKey` 覆写；`seed` 被无条件随机覆盖、忽略调用方传值（`dynamic-tool.ts:207-211`）。

### 1.3 客户端与执行层

- **HTTP**：前缀 `{IP}/api`（`src/api/http.ts:4-10`），覆盖 `/prompt`、`/history`（含单任务）、`/interrupt`、`/userdata`、`/upload/image`、`/object_info`、`/system_stats`、`/experiment/models`；`/view` 下载用原生 `fetch` 流式落盘（`src/services/storage/asset-storage.ts:12-38`）。未使用 `/queue`、`/free`。
- **WebSocket**：单连接 `ws://host:port/ws?clientId=<uuid>`（`src/utils/ws.ts:28-33`），事件路由到全局 hook 对象（`ws.ts:115-152`）；事件集合完整（status/execution_start/executing/progress/executed/execution_success/execution_error/execution_interrupted 等）。重连最多 5 次、固定 3s 无退避（`ws.ts:10-12`）。**二进制帧一律 `JSON.parse` 失败进 catch**（预览帧被丢弃，`ws.ts:98-108`）。
- **等待模型**：同步等待通过**整体替换 `client.hook.*` 实现**（`src/services/task/wait.ts:49-70`）——两个并发等待互相覆盖，先等待方事件丢失。无 history 轮询兜底：WS 断线即永远等不到，只有 10 分钟超时，且**超时不中断远端任务**。
- **任务状态**：无状态机、无持久化。状态只活在一次 Promise 里（`wait.ts:32-34`）；`isAsync` 提交后服务端不留任务表（`src/tools/handlers/queue-prompt.ts:155-166`）。
- **README 与实现脱节**：`SYNC_MODE=timed|push|manual` 等大量配置项只在 README 存在，源码零读取（`README.md:370,410-439`）。

### 1.4 错误处理与质量

- 错误码语义错位（`PARAM_ERROR=401`、`TIMEOUT=501`，`src/types/enums/result.ts:1-29`）；HTTP 401 分支调用浏览器 `localStorage`，在 Node 中直接 `ReferenceError`（`src/api/http.ts:36-48`）。
- 提交后不检查 `/prompt` 响应中的 `node_errors`（有类型无处理，`src/types/execute.ts:3-7` vs `src/services/task/execution.ts:45`）。
- 路径安全：`asset-storage.ts:26-27`、`workflow-storage.ts:89` 直接 `path.join`，未防 `..`。
- 测试：5 个单测文件，mock 快乐路径为主；`ws.ts`/`http.ts`/`fetch.ts`/`executor.ts`/`asset-storage.ts` 零覆盖（`jest.config.js:23-38`）。
- 已知小 bug：`get_workflow_api` vs `get_workflow_API`、`get_task_detail` vs `cui_get_task_detail` 两处注册名不一致（`tool-status-map.ts:16,23`）；i18n key 尾随空格（`queue-custom-prompt.ts:31`）。

### 1.5 依赖与许可证（metabrain）

- 仓库 LICENSE 为 **MIT**（MetaBrain-Labs, 2026）→ **可以复用其源码**，但拷贝实质性片段需保留其版权与许可声明（拟在文件头注明）。
- 运行时依赖 10 个：`@modelcontextprotocol/sdk`、`ws`、`axios`、`express`+`cors`（仅 HTTP 模式）、`dotenv`（BSD-2）、`i18next` 系（非必需）、`zod`（实际直接 import 但未声明，是 SDK 的 peer）。
- 新项目预期运行时依赖显著更少（见 002 文档 §依赖策略）。

---

## 2. comfy-org-mcp 参考结论（不作为代码底座）

- **许可证**：AGPL-3.0 OR 商业双许可（`LICENSE:1-15`）→ **禁止复制其任何代码**；仅可参考设计思想，独立实现（clean-room）。
- **架构**：comfy-cli 的薄封装，**刻意不实现 HTTP client**（`src/comfy_mcp/server.py:14`），对"如何消费 ComfyUI REST/WS"零参考价值——这恰好是我们轻量版直连路线的存在理由。
- **值得吸收的设计**（详见 002 文档各节落点）：
  1. **instructions 前置**：编排知识（canonical flows）在握手时一次下发，工具描述保持短（`instructions.py:182-258`）。
  2. **action 分组工具**：官方自己也在收敛——`job` 六合一（`server.py:17-19`），验证了我们 4 工具路线的正确方向。
  3. **统一参数命名**：`prompt_id`/`workflow_path` 跨工具一致，返回句柄可直接回填（`instructions.py:167-180`）。
  4. **结构化参数防类型强转**：字符串编码的值经解析会隐性变形，参数必须走结构化 JSON（`params.py:224-235` 的教训）。
  5. **上下文轻量化**：一切输出有界、截断必须显式标记（`<empty>`/`...`）、保留尾部不保留头部、URL 凭证先 redact 后 clip（`textutil.py:12-94`、`failure_log.py:215-280`）。
  6. **错误即自愈指令**：错误消息三段式（实际值/期望/修正示例）+ 结构化错误字段免字符串匹配（`errors.py:28-86`）。

---

## 3. 保留 / 重构 / 删除决策

### 3.1 近乎原样复用（带 MIT 归属声明）

| 模块 | 位置（metabrain-mcp） | 说明 |
|---|---|---|
| 端点定义与请求体类型 | `src/api/api.ts:17-120`、`src/types/execute.ts`、`src/types/task.ts`、`src/types/ws.ts` | 与 ComfyUI 字段对齐的纯数据结构，无业务状态 |
| `/view` 流式下载 | `src/services/storage/asset-storage.ts:12-38` | 已是流式非 base64；需补路径消毒与 mkdir |
| WS 事件→阶段映射表 | `src/services/task/wait.ts:72-182` 的分支逻辑 | 事件集合完整；提取为纯函数，弃用钩子覆写机制 |
| `ComfyMcpManager` 骨架 | `src/tools/index.ts:24-99` | 注册中心 + 每会话 server 工厂，结构干净 |
| 工具结果包装 | `src/utils/mcp-helpers.ts:13-86`、`src/types/result.ts` | 结构化结果通用件（错误码需重新设计） |
| stdio/HTTP 双入口骨架 | `src/server-stdio.ts`、`src/index.ts:19-159` | 会话管理可复用 |

### 3.2 重构后复用（保留思想，重写实现）

| 来源 | 借鉴点 | 重构原因 |
|---|---|---|
| `==名称==` / `=>参数` 标记协议（`format.ts:15-20`、`dynamic-tool.ts:123-170`） | 显式声明"Agent 可改什么"的理念 | 改为**独立 manifest 文件**：显式类型/默认值/枚举/范围/必填，而非节点 title 约定 + typeof 推断 |
| `mergeParamsToWorkflow`（`dynamic-tool.ts:193-223`） | `nodeId + inputKey` 覆写机制 | 移除 seed 强制随机；接入 manifest 校验后的值 |
| 工作流目录（`workflow-storage.ts`） | 本地目录扫描 | 删除 userdata 巡检与三来源合并，只扫本地 `workflows/`；启动期扫描 + 文件监听可选 |
| Zod → 工具 schema 生成（`dynamic-tool.ts:83-113`） | schema 生成管线 | 真正消费 schema：manifest → 校验 → 错误信息带期望值 |
| seed 特判（`special-node-handler.ts`） | 特殊参数概念 | 改为 manifest `special: "seed"` 声明式，默认不干预 |

### 3.3 删除 / 不移植

- **userdata 巡检**（`executor.ts:38-66`）：为建目录向生产队列打空跑 + interrupt，副作用不可接受。
- **catalog→mount→queue 三步协议**与内存动态工具 Map（`dynamic-tool.ts:11-43,229-262`）：上下文成本高、依赖 LLM 记忆、重启即失。替换为 `list_workflows` + manifest。
- **全局钩子覆写等待模型**（`wait.ts:49-70`）：并发竞态根源。替换为按 `prompt_id` 多路分解的事件总线。
- **README 中未实现的配置面**（SYNC_MODE 三模式、`COMFY_UI_INSTALL_PATH` 自动装插件）：源码零实现，一律不承诺。
- axios（与原生 fetch 二选一）、i18next 系（v1 不需要多语言工具文案）、express/cors（v1 只做 stdio，见 002 风险节）、重复的 80 行进度通知复制粘贴（`queue-prompt.ts:76-153` vs `queue-custom-prompt.ts:65-144`）、`executeCustomWorkflowTaskByPrompts` 重复函数（`execution.ts:51-69`）、Python 残留 `example.json`。

### 3.4 metabrain 已证伪、新项目必须补齐的能力

批量提交、SQLite 持久化、重启恢复（重连后按 `prompt_id` 查 `/history` 续判）、并发控制（信号量）、`node_errors` 拦截、超时联动 interrupt、WS 断线 history 兜底、非图片输出（gifs/文本）、路径安全——以上在 metabrain 中**均不存在**（详见执行层审计 §9），全部列入新架构设计输入。

---

*下一步：见 `002-architecture-design.md`（目标架构、接口设计、Batch/Job 模型、工具 Schema、风险清单、实施计划）。本报告仅含分析结论，未创建任何 src/ 代码。*
