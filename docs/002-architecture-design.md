# 002 · 目标架构与实施设计

> Task 001 交付 4–9：目录结构、核心接口、Batch/Job 模型与生命周期、工具 Schema、风险与待确认问题、分阶段计划。
> 前置结论（见 `001-codebase-audit.md`）：以 metabrain-mcp（MIT）为代码底座做选择性复用；comfy-org-mcp（AGPL）仅吸收设计思想，**零代码复制**；ComfyUI 消费面由本项目**直连 REST + WS 自研**——这是轻量版存在的理由。

**定位回顾**：Workflow-first, Batch-native, Context-light。用户自带已测试工作流，MCP 只负责让 Agent 低上下文成本调用，尤其批量生成。

---

## 1. 目标架构分层

```
┌──────────────────────────────────────────────────────┐
│ MCP Interface（src/mcp/）        ← 唯一依赖 MCP SDK 的层 │
│   4 个工具 · instructions 前置 · 输出有界化              │
├──────────────────────────────────────────────────────┤
│ Core Engine（src/core/engine.ts）  ← 纯 TS，无 MCP SDK   │
│   facade：list / run / batch / result                 │
├────────────┬────────────┬─────────────┬──────────────┤
│ Workflow   │ Batch/Job  │ Asset       │ ComfyUI      │
│ Registry   │ Manager    │ Manager     │ Client       │
│ +Manifest  │ +Scheduler │ (path-jail) │ (HTTP + WS)  │
│ +Mapper    │ +Recovery  │             │ +EventBus    │
├────────────┴────────────┴─────────────┴──────────────┤
│ SQLite Storage（batches / jobs / kv）                 │
└──────────────────────────────────────────────────────┘
```

依赖规则（由 tsconfig + eslint 边界约束）：

- `mcp/` → `core/`（单向）；`core/` 内部：`batch/` → `workflow/`、`client/`、`storage/`、`assets/`；`client/` 不依赖任何上层。
- **Core Engine 及以下不知道 MCP 的存在**，可独立单测、可被未来其他入口（CLI/HTTP）复用。

## 2. 推荐目录结构

```
comfyui-light-mcp/
├─ src/
│  ├─ index.ts                  # 装配：config → engine → mcp server（stdio）
│  ├─ config.ts                 # 环境变量 → 冻结配置对象
│  ├─ mcp/                      # ── MCP Interface ──
│  │  ├─ server.ts              # 注册 4 工具 + instructions
│  │  ├─ instructions.ts        # canonical flows（握手一次下发）
│  │  └─ tools/
│  │     ├─ list-workflows.ts   #   薄壳：解析入参 → engine → 有界化输出
│  │     ├─ run-workflow.ts
│  │     ├─ get-batch.ts
│  │     └─ get-result.ts
│  ├─ core/                     # ── Core Engine ──
│  │  ├─ engine.ts              # facade，组合下列模块
│  │  ├─ client/
│  │  │  ├─ comfy-http.ts       # /prompt /history /queue /interrupt /view /upload
│  │  │  ├─ comfy-ws.ts         # 单连接、退避重连、二进制帧显式跳过
│  │  │  ├─ event-bus.ts        # 按 prompt_id 多路分解（修复 metabrain 竞态）
│  │  │  └─ types.ts            # ComfyUI API 类型（复用 metabrain types 改编）
│  │  ├─ workflow/
│  │  │  ├─ registry.ts         # 启动扫描 workflows/、校验、加载报告
│  │  │  ├─ manifest.ts         # manifest 类型 + zod 校验
│  │  │  └─ mapper.ts           # manifest 参数校验 + 覆写 API JSON
│  │  ├─ batch/
│  │  │  ├─ batch-manager.ts    # 批量创建、状态汇总、分页视图
│  │  │  ├─ job-manager.ts      # 单 job 生命周期、重试、事件消费
│  │  │  ├─ scheduler.ts        # in-flight 窗口（默认 1 = 串行）
│  │  │  └─ recovery.ts         # 重启恢复：/history + /queue 续判
│  │  ├─ assets/
│  │  │  ├─ asset-manager.ts    # /view 下载、按需上传（Phase 4+）
│  │  │  └─ path-jail.ts        # Windows 路径安全
│  │  └─ storage/
│  │     ├─ db.ts               # better-sqlite3，WAL
│  │     ├─ migrations.ts
│  │     ├─ batch-repo.ts
│  │     └─ job-repo.ts
│  └─ shared/
│     ├─ errors.ts              # 结构化错误分类（参考 comfy-org taxonomy）
│     ├─ truncate.ts            # 有界输出 + 显式截断标记
│     └─ ids.ts
├─ workflows/                   # 用户工作流目录（实例 gitignore，examples/ 入库）
│  └─ examples/                 #   foo-api.json + foo.manifest.json 示例
├─ scripts/
│  └─ smoke-real-comfyui.ts     # 真实环境冒烟：验证全部未验证假设（Phase 1）
├─ tests/
│  ├─ unit/
│  └─ integration/              # 对本机真实 ComfyUI 的端到端验收
├─ docs/
├─ LICENSE                      # MIT
├─ AGENTS.md
└─ package.json
```

## 3. 依赖策略（最小化）

| 运行时依赖 | 用途 | 备注 |
|---|---|---|
| `@modelcontextprotocol/sdk` | 仅 `src/mcp/` | 锁次版本（API 快速演进） |
| `ws` | WebSocket | 复用 metabrain 用法 |
| `better-sqlite3` | 持久化 | win32-x64 + Node 22 有预编译；同步 API 契合单进程调度 |
| `zod` | manifest/参数校验 | MCP SDK 本就要求 |

明确不引入：axios（用 Node 22 原生 fetch）、express/cors（v1 仅 stdio）、dotenv（MCP 客户端传 env；需要时作 dev 依赖本地调试）、i18next（v1 工具文案英文，错误消息中英混合不做多语言体系）。

配置面（`src/config.ts`，环境变量 → zod 校验 → 冻结对象）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | 只连已启动实例，不做启动管理 |
| `WORKFLOWS_DIR` | `./workflows` | 工作流 + manifest 目录 |
| `DATA_DIR` | `./data` | SQLite 所在目录 |
| `OUTPUT_DIR` | `./output` | 输出落盘根目录（受 path-jail） |
| `AUTO_SAVE_OUTPUTS` | `true` | job 成功即落盘 |
| `MAX_IN_FLIGHT` | `1` | 在途窗口（submitting/submission_unknown/queued/executing） |
| `MAX_QUEUED_JOBS` | `1` | ComfyUI 队列占用窗口（仅 queued），须 ≤ MAX_IN_FLIGHT |

**决策：v1 传输只做 stdio**。Windows 本地 + MCP 客户端拉起的场景下 stdio 是唯一必要形态；HTTP 传输留待确有需求再加（metabrain 的会话管理骨架已备份在审计记录中，加回成本低）。

## 4. 核心模块接口设计（关键代码草案）

> 以下为接口签名草案（实现于后续 Phase，本任务不落 src/ 代码）。

### 4.1 ComfyUI Client + 事件总线

```ts
// core/client/comfy-http.ts
export interface ComfyClient {
  submitPrompt(graph: WorkflowGraph, opts?: { promptId?: string; clientId?: string }): Promise<PromptAccepted>;
    // PromptAccepted = { promptId, number, nodeErrors }
    // nodeErrors 原样返回（结构以真实环境验证为准，见 003 文档），失败语义由 job 层决定
  getHistory(promptId: string): Promise<HistoryEntry | null>;
  getQueue(): Promise<QueueInfo>;                 // 恢复与取消用（metabrain 未用 /queue）
  interrupt(promptId?: string): Promise<void>;    // 语义待验证，见风险 Q1
  downloadOutput(ref: OutputRef): Promise<ReadableStream<Uint8Array>>;  // GET /view，流式
  uploadImage(f: { stream; name; type? }): Promise<{ name; subfolder }>; // Phase 4+
}

// core/client/event-bus.ts —— 修复 metabrain 全局钩子覆写竞态（审计 §1.3）
export type JobEvent =
  | { type: "queued" }
  | { type: "executing"; nodeId: string | null }   // null = 执行完毕哨兵
  | { type: "progress"; value: number; max: number }
  | { type: "executed"; nodeId: string; outputs: NodeOutputs }
  | { type: "success" }
  | { type: "error"; message: string; details?: unknown }
  | { type: "interrupted" };

export interface ComfyEventBus {
  subscribePrompt(promptId: string, listener: (e: JobEvent) => void): () => void;
  onDisconnect(cb: () => void): () => void;  // WS 断开 → job-manager 触发 history 兜底
}
```

WS 连接策略：单连接、固定 `clientId`（随每次 submitPrompt 传入）、指数退避 + 抖动重连、二进制帧（预览图）**计数后显式丢弃**、重连成功即对所有 in-flight job 做一次 `/history` 快照对账。

### 4.2 Workflow Registry / Manifest / Mapper

```ts
// core/workflow/registry.ts
export interface RegisteredWorkflow {
  name: string;
  manifest: WorkflowManifest;
  graph: WorkflowGraph;              // 已通过交叉校验的 API JSON（内存态）
}
export interface WorkflowRegistry {
  load(): Promise<LoadReport>;       // 不 throw：返回逐文件错误清单（上下文友好）
  get(name: string): RegisteredWorkflow | undefined;
  list(): WorkflowSummary[];         // 轻量摘要：name + description + params 数
}

// core/workflow/manifest.ts
export interface WorkflowManifest {
  name: string;                      // 唯一键，即工具入参 workflow
  description: string;               // 一句话，进 list_workflows 摘要
  version: number;                   // manifest 自身版本，追踪漂移
  workflowFile: string;              // 相对 manifest 的 API JSON 文件名
  params: ManifestParam[];
}
export interface ManifestParam {
  name: string;                      // Agent 可见参数名
  node: string;                      // API JSON 节点 id
  input: string;                     // 节点 inputs 键名
  type: "string" | "number" | "integer" | "boolean" | "enum" | "string[]";
  required?: boolean;                // 缺省 false（有 default 即可选）
  default?: unknown;
  enum?: string[];                   // type=enum 时必填（模型名等）
  min?: number; max?: number;
  special?: "seed";                  // 值 -1 = 每 job 随机，实际值落 params_resolved
  description?: string;
}

// core/workflow/mapper.ts
export interface ParameterMapper {
  buildValidator(m: WorkflowManifest): ZodType;   // 启动时构建一次并缓存
  apply(graph: WorkflowGraph, m: WorkflowManifest,
        params: Record<string, unknown>): { graph: WorkflowGraph;
                                            resolved: Record<string, unknown> };
  // 契约：apply 只接受已过 validator 的 params；
  //       seed 覆写为 resolved 实际值（可复现）；其余按 node/input 定点覆写。
  //       registry.load 已保证 node/input 存在且类型相容 → 运行期不再防御。
}
```

启动交叉校验（registry.load）：manifest 引用的 `node` 在 API JSON 中存在、`input` 在该节点 `inputs` 中存在、类型与当前值相容、enum 值合法——任何失配即拒绝注册该工作流并进 LoadReport（防 manifest 与工作流漂移，审计 §风险 8）。

### 4.3 Batch / Job / Scheduler

```ts
// core/batch/batch-manager.ts
export interface BatchManager {
  create(workflow: string, runs: RunSpec[], opts: CreateOptions): Promise<BatchHandle>;
    // CreateOptions = { idempotencyKey?: string; maxRetries?: number; timeoutMs?: number }
    // RunSpec = { params: Record<string, unknown>; label?: string }
  get(id: string, page?: { limit: number; offset: number; status?: JobStatus }): BatchView;
}

// core/batch/job-manager.ts
export interface JobManager {
  recover(): Promise<void>;   // 启动时：核对 submitting/queued/executing 的存量 job
  tick(): void;               // 事件驱动 + 定时兜底：维持 in-flight ≤ maxInFlight
  onJobSettled(cb: (job: Job) => void): () => void;   // 通知持久化 + batch 汇总刷新
}

// core/batch/scheduler.ts —— 双窗口提交控制
//   maxInFlight（默认 1）：在途上限 = 状态 ∈ {submitting, submission_unknown, queued, executing} 的 job 数
//     —— 限制我们对 ComfyUI 的总未决提交量（含正在执行的那 1 个）
//   maxQueuedJobs（默认 1）：排队上限 = 状态 ∈ {queued}（已入 ComfyUI 队列、尚未开始执行）的 job 数
//     —— 限制我们占用 ComfyUI 队列的深度，避免挤占用户自己在 UI 里的排队
//   提交下一个 pending job 的条件：inFlight < maxInFlight 且 queued < maxQueuedJobs
//   两值均默认 1（完全串行：上一个终态后才提交下一个）；maxQueuedJobs ≤ maxInFlight 由 config 校验
export interface Scheduler {
  /** 双窗口任一空出 → 从 pending 中按 idx 取下一个 job 交给 JobManager.submit */
}
```

### 4.4 Storage 与 Engine facade

```ts
// core/storage/*：同步 better-sqlite3，WAL 模式；repo 只做 SQL，不做业务
// core/engine.ts —— mcp 层唯一入口
export interface Engine {
  listWorkflows(name?: string): WorkflowSummary[] | WorkflowDetail;
  runWorkflow(req: RunRequest): Promise<BatchHandle | ValidationResult>;
    // dryRun=true → 只做参数校验返回逐 run 错误清单，不提交
  getBatch(id: string, page?: Page): BatchView;        // 不存在 → NotFoundError
  getResult(ref: { batchId: string; index: number }, opts?: { url?: boolean }): ResultView;
    // outputs 默认本地绝对路径（AUTO_SAVE 已落盘；未落盘则此刻补下载）
}
```

## 5. 工作流配置设计（API JSON + 独立 manifest）

- **工作流文件**：ComfyUI 原生导出的 **API 格式 JSON**（用户已测试过的即用），命名 `foo-api.json`，**Agent 永远拿不到修改整图的能力**。
- **manifest 文件**：`foo.manifest.json`，与工作流文件同目录成对存在。显式声明 Agent 可改的参数白名单（类型/默认/枚举/范围/seed 语义）。`workflows/examples/` 提供完整示例。
- 禁止项落实为机制：`run_workflow` 的参数只经 manifest 白名单校验后定点覆写（mapper），不存在"提交任意 JSON"通道（metabrain 的 `queue_custom_prompt` 不移植）。
- manifest 手写成本控制：提供 `scripts/` 下的 manifest 生成辅助（Phase 2 可选：从 API JSON 列出候选节点/输入供人挑选），**不做自动全量参数暴露**（metabrain 教训：`=>` 节点全输入暴露 + typeof 四类推断不可靠，审计 §1.2）。

## 6. Batch / Job 数据模型与生命周期

### 6.1 SQLite Schema（v1）

```sql
CREATE TABLE batches (
  id              TEXT PRIMARY KEY,          -- uuid v4
  workflow        TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,         -- 注册时 manifest.version
  idempotency_key TEXT UNIQUE,               -- 可空；TTL 内重复提交返回原 batch
  status          TEXT NOT NULL,             -- running|completed|partial|failed|cancelled
  total           INTEGER NOT NULL,
  options_json    TEXT NOT NULL,             -- maxRetries/timeoutMs 快照
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,             -- uuid v4（内部句柄）
  batch_id     TEXT NOT NULL REFERENCES batches(id),
  idx          INTEGER NOT NULL,             -- batch 内序号，Agent 引用句柄
  label        TEXT,
  params_json  TEXT NOT NULL,                -- 调用方原始参数（审计留痕）
  resolved_json TEXT,                        -- 覆写后实际值（含 seed 实际值，可复现）；invalid 态为空
  status       TEXT NOT NULL,                -- 见 6.2（含 invalid / submission_unknown）
  attempt_no   INTEGER NOT NULL DEFAULT 0,   -- 当前尝试序号（= job_attempts 行数）
  prompt_id    TEXT,                         -- 当前尝试的 ComfyUI 句柄（历史尝试见 job_attempts）
  error_json   TEXT,                         -- {code, message(clip), nodeErrors?}
  outputs_json TEXT,                         -- OutputRef[]（history 收获 + 本地落盘路径）
  submitted_at TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE (batch_id, idx)
);
CREATE TABLE job_attempts (                  -- 只增不改：保留完整重试历史
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  attempt_no   INTEGER NOT NULL,
  prompt_id    TEXT,                         -- 该次尝试的 ComfyUI 句柄
  status       TEXT NOT NULL,                -- 该次尝试终态
  error_json   TEXT,
  submitted_at TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE (job_id, attempt_no)
);
CREATE INDEX idx_jobs_batch  ON jobs(batch_id, idx);
CREATE INDEX idx_jobs_prompt ON jobs(prompt_id);
CREATE INDEX idx_attempts_prompt ON job_attempts(prompt_id);
CREATE INDEX idx_jobs_recover ON jobs(status)
  WHERE status IN ('submitting','submission_unknown','queued','executing');   -- 部分索引，恢复扫描
```

### 6.2 状态机

```
Job:   pending ─→ submitting ─→ queued ─→ executing ─┬→ succeeded
          ↑            │            │        │        ├→ failed     ─(attempt_no<max)─→ pending（重试）
          │            │            │        │        ├→ timeout    ─(同上，先 interrupt)
          │            │            │        │        └→ cancelled
          │            ↓            ↓        ↓
          │      submission_unknown ─┬→ (恢复时在 /queue 或 /history 中找到) → queued/executing/终态，继续跟踪
          │                          └→ (两处均无) → failed(error=submission_unknown)，【禁止自动重提】
          └→ invalid（参数校验失败，创建时即定，终态，不占提交窗口）
        （提交抛错/网络失败）（/queue 中）（WS executing）（终态；WS+history 双确认）

Batch: running ─┬→ completed   （全部 succeeded）
                ├→ partial     （成功与 invalid/failed/timeout/submission_unknown 并存）
                ├→ failed      （全部非 succeeded）
                └→ cancelled   （取消且无在途）
```

规则：

- **部分容错（已确认决策）**：参数校验失败的 run **不阻塞整批**——合法 run 正常创建提交，非法 run 以 `invalid` 终态独立落库（error 逐字段记录原因），batch 汇总中计入失败侧。`run_workflow` 响应带 `invalid_runs` 清单，Agent 可一次看到全部错误并自愈重提。
- **失败隔离**：单 job 失败不影响 batch 内其他 job（默认 `continue_on_error=true`，batch 级可配 false：失败即取消剩余 pending）。
- **重试**：仅对 `failed/timeout` 且 `attempt_no < maxRetries`（默认 0，即不自动重试；显式配置才启用）。每次尝试一行 `job_attempts`（含独立 prompt_id 与终态），历史只增不改。
- **submission_unknown（已确认决策）**：`submitting` 态遇网络失败/进程崩溃 → 入 `submission_unknown`。恢复判定：能查到（`/queue` 或 `/history/{prompt_id}`）→ 继续跟踪；查不到 → 终态 `failed(error=submission_unknown)`，**禁止自动重提**（无法排除 ComfyUI 已收到且将执行的可能，宁可少不可重）。若真实环境验证客户端可指定 prompt_id（见 003 验证），则提交前先固化 prompt_id，`submission_unknown` 的可查性大幅提高，但"查不到即不重提"原则不变。
- **timeout**：batch 级 `timeoutMs` 可选；触发时先 `interrupt`（尽力）再置 timeout 态，不静默等 10 分钟（metabrain 缺陷：超时后远端继续跑，审计 §1.3）。
- **幂等性**：
  - batch 级：`idempotency_key` 唯一约束，重复 create 返回既有 batch（24h TTL 内）。
  - job 级：`(batch_id, idx)` 唯一；`submission_unknown` 查证流程见上，不做盲目双提交。
- **结果关联**：`executed` 事件 + `/history/{prompt_id}` 双通道收获 outputs（images/gifs/音频均收，metabrain 只认 images，审计 §1.3），统一转 `OutputRef{filename, subfolder, type, kind}` 落库。
- **输出落盘（已确认决策）**：`AUTO_SAVE_OUTPUTS=true`（默认）时 job 终态成功即经 `/view` 下载到 `OUTPUT_DIR/<batch_id>/<idx>/<filename>`（重名自动加序号），`OutputRef.local_path` 记录绝对路径；关闭则 get_result 时按需下载。
- **分页**：`get_batch` 按 `(batch_id, idx)` 排序，`limit`（默认 20，上限 100）+ `offset`；v1 用 offset（SQLite 窗口查询），规模到万级再评估 cursor。
- **重启恢复**（`recovery.ts`，启动时一次）：
  1. 扫部分索引得存量在途 job（含 `submission_unknown`）；
  2. 有 `prompt_id` → `/history/{id}`：有记录 → 收获 outputs 定终态；无 → 查 `/queue`：在队列 → 重新挂事件等待；都不在 → `submission_unknown`→`failed`（见上，不自动重提）；
  3. 无 `prompt_id` 且状态为 `submitting` → 置 `submission_unknown` 按上款流程查证（默认无 client 指定 id 时不可查 → 终态 failed，不重提）；
  4. 恢复后 scheduler.tick() 接管。

## 7. 核心 MCP 工具 Schema 草案（4 个）

统一约定（写入 instructions，一次握手下发）：句柄命名 `batch_id`/`index` 全工具一致可直接回填；所有列表输出有界；错误三段式（实际值(clip)/期望/修正示例）。

### list_workflows

```json
{ "name": "list_workflows",
  "description": "列出已注册工作流（名称+一句话+参数个数）。传 workflow 名返回该工作流完整参数说明。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "workflow": { "type": "string", "description": "可选：指定则返回 manifest 参数详情" }
    } } }
```

输出（默认）：`[{name, description, version, params: N}]`；指定名：`{name, description, params: [{name, type, required, default, enum?, min?, max?, description}]}`——**摘要/详情两级**，Agent 按需取，不一次倾倒。

### run_workflow

```json
{ "name": "run_workflow",
  "description": "以批量参数运行工作流。runs 数组每项是一次独立运行的参数覆盖集；返回 batch_id 供 get_batch/get_result 轮询。默认异步立即返回。",
  "inputSchema": {
    "type": "object",
    "required": ["workflow", "runs"],
    "properties": {
      "workflow": { "type": "string", "description": "list_workflows 中的名称" },
      "runs": {
        "type": "array", "minItems": 1, "maxItems": 200,
        "items": { "type": "object",
          "properties": {
            "params": { "type": "object", "description": "键须匹配 manifest 参数名，运行期校验" },
            "label":  { "type": "string", "description": "可选标记，便于 get_batch 对照" }
          },
          "required": ["params"] } },
      "dry_run":         { "type": "boolean", "description": "只校验参数不提交，返回逐 run 校验结果" },
      "idempotency_key": { "type": "string", "description": "防重复提交，重复键返回既有 batch" },
      "wait":            { "type": "boolean", "description": "小批量可同步等待完成（默认 false）" },
      "continue_on_error": { "type": "boolean", "description": "默认 true：单 run 失败不中断其余" },
      "max_retries":     { "type": "integer", "minimum": 0, "maximum": 3, "description": "默认 0" },
      "timeout_ms":      { "type": "integer", "minimum": 1000, "description": "可选单 run 墙钟超时，触发即 interrupt" }
    } } }
```

返回：`{batch_id, total, status, valid_count, invalid_runs?: [{index, errors:[{param, message}]}]}`。**部分容错**：非法 run 以 invalid 终态落库、错误逐字段返回；合法 run 照常提交。仅当全部 run 非法时不向 ComfyUI 提交任何任务（batch 仍创建，直接进入 failed 终态，保留错误现场）。

### get_batch

```json
{ "name": "get_batch",
  "description": "查询 batch 汇总与 job 分页列表。轮询用；error 字段已截断。",
  "inputSchema": {
    "type": "object", "required": ["batch_id"],
    "properties": {
      "batch_id": { "type": "string" },
      "limit":  { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
      "offset": { "type": "integer", "minimum": 0, "default": 0 },
      "status": { "type": "string", "enum": ["pending","queued","executing","succeeded","failed","timeout","cancelled"] }
    } } }
```

返回：`{batch_id, workflow, status, stats:{total,succeeded,failed,running,pending}, jobs:[{index, label?, status, attempts, error?, outputs: N}], next_offset?}`。

### get_result

```json
{ "name": "get_result",
  "description": "取单个 job 的详细结果：实际参数（含 seed）+ 输出文件本地绝对路径（AUTO_SAVE 默认已落盘；未落盘则此处下载）。",
  "inputSchema": {
    "type": "object", "required": ["batch_id", "index"],
    "properties": {
      "batch_id": { "type": "string" },
      "index":    { "type": "integer", "minimum": 0 },
      "url":      { "type": "boolean", "description": "额外附带 /view 直链（默认 false，仅本地路径）" },
      "save_dir": { "type": "string", "description": "覆盖落盘子目录（受 path-jail 约束，禁止 .. 与绝对路径）" }
    } } }
```

返回：`{index, status, params_resolved, outputs: [{kind, local_path, url?}], error?}`（url 仅在 `url:true` 时附带）。**默认只返回本地绝对路径，绝不返回 base64**——本地路径是 Agent 成本最低的引用形式（上下文最短、可被本地工具直接打开）；`/view` URL 仅作显式选项，默认不依赖（ComfyUI 重启/清历史后 URL 即失效，本地文件不会）。

辅助工具（**暂不实现**，触发条件明确后才加）：`cancel_batch`（需要人工中止长批量时）、`server_status`（health 探测，排障时）、`upload_asset`（工作流出现图片输入参数时）、`save_assets`（批量落盘时）。不引入节点/模型查询类工具（用户自己管理工作流与模型）。

## 8. 上下文轻量化策略（Context-light 落地规则）

1. instructions 前置 canonical flows（先 list → run → poll get_batch → get_result；批量用 runs 数组一次提交），工具 description 不重复教程。
2. 两级信息：list_workflows 摘要/详情分离；get_batch 汇总统计 + 分页明细；get_result 单点详情。
3. 一切错误消息 clip（默认 200 字符）+ `...` 显式截断标记；空值渲染 `<empty>` 不省略字段。
4. 输出默认**本地绝对路径**引用（AUTO_SAVE 落盘），绝不 base64；`/view` URL 仅在显式要求时附带；批量结果只回计数，明细按页取。
5. 校验错误带期望值与修正示例（如 enum 全列），让 Agent 一次自愈。

## 9. 技术风险与待确认问题

> 按工作原则，以下均标注验证方式；**Q1/Q2 为 Phase 1 冒烟脚本的第一批验证目标**。

| # | 问题 | 状态 | 验证/缓解 |
|---|---|---|---|
| Q1 | ComfyUI API 细节随版本变动：`POST /prompt` 是否接受客户端指定 `prompt_id`（幂等关键，含**同 prompt_id 重复提交的行为**）；`/interrupt` 是否支持按 `prompt_id`（否则只能中断当前执行项）；`node_errors` 结构；`/history` outputs 的 gifs/audio 形状 | **未验证** | Phase 1 冒烟脚本对本机真实 ComfyUI 逐项打点；按实测适配 client 层 |
| Q2 | ComfyUI history 服务端保留窗口有限 → 重启恢复可能查不到 | 未验证 | 冒烟测 history 上限；恢复逻辑已设计 `/queue`+`/history` 双查 + `lost_after_restart` 终态兜底 |
| Q3 | better-sqlite3 在本机（win32-x64, Node 22.22）预编译安装 | 未验证 | Phase 0 `npm install` 即验；失败则评估 `node:sqlite`（Node 22 需 `--experimental-sqlite`，不适合客户端拉起，需升 Node ≥24——列为 Plan B） |
| Q4 | MCP 客户端对工具调用超时各异（部分 60s） | 未验证 | 默认异步返回 batch_id（wait=false），规避长阻塞；wait=true 文档标注仅小批量 |
| Q5 | WS 单连接承载所有 job 事件，高并发批量下事件风暴 | 设计内 | 事件按 prompt_id 分发 + 落库后再响应；progress 事件默认不落库只更新内存 |
| Q6 | manifest 与工作流文件漂移（用户改图后引用失效） | 设计内 | registry 启动交叉校验，失配拒注册并报告精确 node/input |
| Q7 | Windows 路径越狱（`..`、绝对路径、盘符、UNC） | 设计内 | path-jail：resolve 后前缀校验 + 拒绝 UNC/盘符；单测覆盖向量清单 |
| Q8 | MCP SDK 1.x API 变动 | 外部 | 锁次版本；升级单独小 PR |
| Q9 | metabrain 代码复用的 MIT 归属 | 流程 | 拷贝实质性片段的文件头保留其版权声明 + NOTICE 汇总 |
| Q10 | 长视频工作流单 job 数十分钟，get_batch 轮询间隔无引导 | 设计内 | instructions 给出轮询节奏建议；后续可加 progress 汇总字段 |

## 10. 分阶段实施计划

> 每阶段以**本机真实 ComfyUI 可运行性**为验收标准；不并行扩张功能面。

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **P0 脚手架** | 目录骨架、tsconfig/eslint/vitest、LICENSE(MIT)、better-sqlite3 安装验证（Q3）、config 模块 | build+单测绿；依赖装得上 | 0.5d |
| **P1 Client+总线** | comfy-http/comfy-ws/event-bus、重连、二进制帧跳过；`smoke-real-comfyui.ts` 验证 Q1/Q2 全部假设 | 冒烟脚本对本机 ComfyUI 提交→等完→收 outputs 全通 | 1–2d |
| **P2 工作流+MVP** | registry/manifest/mapper + `list_workflows`/`run_workflow`(runs 长度 1)/`get_result`（不落盘）；examples 工作流对 | Agent 经 3 工具端到端出 1 张图 | 2–3d |
| **P3 Batch/Job** | SQLite、scheduler(默认串行)、get_batch、失败隔离、重试、幂等键 | 10 runs 批量（混入 2 个参数错误 run）失败隔离正确；重启不丢状态 | 2–3d |
| **P4 恢复+硬化** | recovery、timeout→interrupt、path-jail、save 落盘、错误分类打磨、并发>1 配置 | kill 进程重启后恢复在途 batch；路径越狱单测全过 | 1–2d |
| **P5 发布准备** | README(中英)、npx 入口、使用文档（manifest 编写指南） | 新机器按文档 10 分钟跑通 | 0.5–1d |

依赖关系：P1→P2→P3→P4 严格串行；P0 独立。合计约 7–11 个工作日。

**本阶段（Task 001）到此为止：不创建 src/ 代码，等待架构确认后从 P0 开始。**

---

*附：本设计与审计报告由三路并行子审计综合而成（metabrain MCP/工作流层、metabrain 客户端/执行层、comfy-org 设计参考），事实性结论的 file:line 证据见 `001-codebase-audit.md`。*
