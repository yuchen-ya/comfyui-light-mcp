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
| `JOB_TIMEOUT_MS` | `600000` | 单 job 墙钟超时，触发即尽力 interrupt（P2 已实现） |

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

### 4.3 Batch / Job / Scheduler（Task 004 已按此实现）

```ts
// core/batch/manager.ts（已实现）
export class BatchManager {
  createBatch(wf: RegisteredWorkflow, req: CreateBatchRequest): CreateBatchResult;
    // CreateBatchRequest = { runs: RunSpec[]; idempotencyKey?; continueOnError?; maxAttempts? }
    // RunSpec = { params: Record<string, unknown>; label?: string }
    // 逐 run validateParams：非法 → invalid job（三段式 issues 落 error_json），合法 → pending
    // batch + 全部 job 行在一个 SQLite 事务内创建；幂等键命中/UNIQUE 竞争 → 返回既有 batch（reused=true）
  getBatchView(id, { limit?, offset?, status? }): BatchView;   // stats + 分页（status 支持 unknown 别名）
}

// core/batch/runner.ts（已实现；submitJob 是唯一提交路径，submitSingle 为单运行便捷封装）
export class JobRunner {
  submitJob(wf, job): Promise<SubmitHandle | null>;
    // 条件占位（store.claimForSubmit：UPDATE ... WHERE status='pending'，事务内含 attempt 行）
    // → POST /prompt → queued(跟踪) / failed(COMFY_REJECTED+归一化 node_errors) / submission_unknown(不重提)
    // 返回 null = 占位失败（另一路径已在处理）——多 tick 并发天然防重
}

// core/batch/scheduler.ts（已实现）—— 双窗口提交控制
//   maxInFlight（默认 1）：在途上限 = 状态 ∈ {submitting, submission_unknown, queued, executing} 的 job 数
//     —— 限制对 ComfyUI 的总未决提交量；submission_unknown 占额（它可能仍在远端执行）
//   maxQueuedJobs（默认 1）：排队上限 = 状态 ∈ {queued} 的 job 数 —— 限制占用 ComfyUI 队列深度
//   提交条件：inFlight < maxInFlight 且 queued < maxQueuedJobs 且 isConnected()（Task 005 连接门控）；
//   取件顺序：全局 FIFO（batch 创建序 rowid，batch 内按 idx；created_at 同毫秒也稳定）
//   每个 tick：① 重试重置（failed/timeout 且 attempt_no<max_attempts → pending；unknown 永不重试）
//              ② continue_on_error=false 级联放弃（仅终态失败触发；提交循环内每轮重查）
//              ③ 工作流版本指纹校验（变更 → 旧 batch 的 pending → cancelled/WORKFLOW_VERSION_MISMATCH）
//              ④ 窗口内逐个提交（ticking 互斥 + 条件占位双保险，tick 并发不重复提交同一 job）
export class Scheduler {
  ensureStarted(): void;   // 周期 500ms 定时器（unref）+ 立即一拍
  stop(): void;
  tick(): Promise<void>;   // 也可手动驱动（测试/立即推进）
}
```

### 4.4 Storage 与 Engine facade（Task 004 已按此实现）

```ts
// core/storage/*：同步 better-sqlite3，WAL 模式；迁移 v1→v2（v2 增调度热路径部分索引）
// core/engine.ts —— mcp 层唯一入口（纯 TS，不依赖 MCP SDK）
export class Engine {
  listWorkflows(name?: string): ...;                       // 摘要 / 详情两级
  runSingle({workflow, params, label?, idempotencyKey?}): Promise<RunHandleView>;
    // 单 params 简写（P2 兼容）：参数错误抛 ParamsValidationError → 工具层 isError
    // 内部 = createBatch(单 run) + scheduler.tick()，统一受双窗口约束
  runBatch({workflow, runs, idempotencyKey?, continueOnError?, maxAttempts?}): Promise<BatchHandleView>;
    // runs 数组：结构错误抛 ComfyLightError；单 run 参数错误 → invalid job（部分容错）
  getBatch(batchId, {limit?, offset?, status?}): BatchView;   // stats(unknown 单列) + 分页
  getResult(batchId, index, {download?}): Promise<ResultView>;
    // outputs 默认本地绝对路径；AUTO_SAVE=false 时 download=true（默认）按需下载并持久化（幂等）
  recover(): Promise<RecoveryReport>;   // 启动恢复（A1 语义）+ start() 启动调度
}
```

## 5. 工作流配置设计（API JSON + 独立 manifest）

- **工作流文件**：ComfyUI 原生导出的 **API 格式 JSON**（用户已测试过的即用），命名 `foo-api.json`，**Agent 永远拿不到修改整图的能力**。
- **manifest 文件**：`foo.manifest.json`，与工作流文件同目录成对存在。显式声明 Agent 可改的参数白名单（类型/默认/枚举/范围/seed 语义）。`workflows/examples/` 提供完整示例。
- **default 语义（Task 004 §二.4 明确）**：参数显式提供 → 用提供值；未提供但 manifest 有 default → 用 default 值；两者皆无 → 保留工作流模板原值。`resolved_json` 记录全部 manifest 参数的实际生效值（含模板原值），保证可复现。
- **default 完整校验（Task 005 §二.3）**：manifest 加载即校验 default——类型正确、满足 min/max、对齐 step、enum default 在合法值内、seed default 符合特殊规则（-1 随机或 0–2³²-1 整数）；非法 manifest 拒绝注册并落入 LoadReport（不抛出，Agent 可见文件级错误）。
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

**迁移 v2（Task 004）**：调度器热路径部分索引（无新列；幂等键复用 v1 的 UNIQUE 约束）：

```sql
CREATE INDEX idx_jobs_pending   ON jobs(batch_id, idx) WHERE status = 'pending';
CREATE INDEX idx_jobs_retryable ON jobs(batch_id, idx) WHERE status IN ('failed','timeout');
```

**迁移 v3（Task 005）**：工作流版本保护 + 幂等请求指纹（batches 新列；旧行为 NULL，跳过版本校验）：

```sql
ALTER TABLE batches ADD COLUMN manifest_fp TEXT;  -- 创建时 manifest 内容 sha256
ALTER TABLE batches ADD COLUMN graph_fp    TEXT;  -- 创建时 API JSON 内容 sha256
ALTER TABLE batches ADD COLUMN request_fp  TEXT;  -- 幂等请求指纹（canonical JSON sha256）
```

### 6.2 状态机

```
Job:   pending ─→ submitting ─→ queued ─→ executing ─┬→ succeeded
          ↑            │            │        │        ├→ failed     ─(attempt_no<max)─→ pending（重试）
          │            │            │        │        ├→ timeout    ─(同上；我方取消的 interrupted 回声被 cancelling 拦截)
          │            │            │        │        └→ cancelled  （用户/ComfyUI 侧 interrupt；版本失配放弃）
          │            ↓            ↓        ↓
          │      submission_unknown ─┬→ (恢复时在 /queue 或 /history 中找到) → queued/executing/终态，继续跟踪
          │                          └→ (两处均无) → **保持 submission_unknown**（Task 003 A1 确认：
          │                             不伪装 failed、不自动重提；get_batch 原样区分；batch 视为未决=running）
          └→ invalid（参数校验失败，创建时即定，终态，不占提交窗口）
        （提交抛错/网络失败）（/queue 中）（WS executing）（终态；WS+history 双确认）

统一中断语义（Task 005 §二.1，四态互斥）：
  用户主动取消（ComfyUI 侧 interrupt 事件/history interrupted，非我方发起） → cancelled
  执行超时（我方组合取消；取消窗口内的 interrupted 回声不覆盖 timeout，remote_cancel 保留） → timeout
  ComfyUI 执行失败（execution_error / history error） → failed
  提交结果不确定（POST 后网络失败/崩溃，恢复双查无果） → submission_unknown（占在途额度，不重提）

Batch: running ─┬→ completed   （全部 succeeded）
                ├→ partial     （成功与 invalid/failed/timeout/submission_unknown 并存）
                ├→ failed      （全部非 succeeded）
                └→ cancelled   （取消且无在途）
```

规则：

- **部分容错（已确认决策，Task 004 已实现）**：参数校验失败的 run **不阻塞整批**——合法 run 正常创建提交，非法 run 以 `invalid` 终态独立落库（error 含逐字段三段式 issues），batch 汇总中计入失败侧。`run_workflow`（runs 数组）响应带 `invalid` 计数，明细经 get_batch(status=invalid) 获取。
- **失败隔离（已实现）**：单 job 失败不影响 batch 内其他 job（默认 `continue_on_error=true`）。
- **continue_on_error=false × max_attempts>1 组合语义（Task 005 §二.5 明确）**：
  1. 失败**先重试**——attempt 未耗尽的 failed/timeout 只触发重置 pending 重跑，不级联（重试同样受双窗口约束，需等窗口）；
  2. **终态失败才级联**——重试耗尽的 failed/timeout 或 invalid 成立即取消剩余 pending（cancelled/BATCH_ABORTED），调度器同 tick 内拦截后续提交；
  3. **已在途的 job 继续执行**——已提交的 queued/executing 不做远程取消，结果照常对账保留；
  4. **尚未提交的 job → cancelled**。
- **重试（已实现）**：仅对 `failed/timeout` 且 `attempt_no < max_attempts`（默认 1 即不重试，上限 5；`submission_unknown` 永不自动重试）。每次尝试全新 prompt_id + 独立 `job_attempts` 行（终态回写），历史只增不改；重试未用尽期间 batch 视为未决（保持 running）。
- **submission_unknown（Task 003 A1 最终语义，已实测落地）**：`submitting` 态遇网络失败/进程崩溃 → 入 `submission_unknown`。**prompt_id 在提交动作之前已持久化**（runner 固定顺序：生 id → 事务落库（含 attempt 行）→ POST），因此恢复时总是可查证。恢复判定：能查到（`/queue` 或 `/history/{prompt_id}`）→ 继续跟踪或定终态；**两处皆无 → 保持 submission_unknown 状态原样**——不伪装成 failed、不自动重提（0.41 实测同 prompt_id 重提会重复执行，docs/003 F2）、get_batch 单列 `unknown` 统计、batch 状态视为未决（保持 running）、**持续占用 MAX_IN_FLIGHT 在途额度**（它可能仍在远端执行——窗口层落实"宁可保留 unknown 也不重复生成"）。
- **timeout（Task 004 §二.2 修订，已实现）**：触发时先向 ComfyUI 发送**组合取消**——`POST /queue {delete:[id]}`（移除排队项）+ `POST /interrupt {prompt_id}`（终止执行项）。两动作对"错误状态"均为已验证的无害 no-op（docs/003 F5），组合发送无竞态空窗（任务恰在两动作间由 queued 转 executing 也被覆盖）。取消期间 job 若已由事件定终态，以先到者为准（不覆盖）。远端取消结果（ok/error 明细）记入 error_json.remote_cancel。绝不静默超时（metabrain 缺陷：超时后远端继续跑，审计 §1.3）。
- **History 终态优先级（Task 004 §二.1 修订，已实现）**：`error/interrupted` 判定**优先于** outputs 存在性——error 绝不因存在部分 outputs 被判 succeeded（tracker 轮询、settleFromHistory 守卫、recovery 三处统一走 `historyVerdict`）。
- **幂等性（Task 005 §二.4 升级为指纹比对）**：
  - batch 级：`idempotency_key` 唯一约束 + **请求指纹**（canonical JSON，对象键序无关；涵盖 workflow 名/内容指纹/runs 内容与顺序/continue_on_error/max_attempts）。
  - 同键**相同请求** → 返回既有 batch（reused，零新提交；离线重放亦成立——预检先于连通性检查）；
  - 同键**不同请求** → `IDEMPOTENCY_CONFLICT`（自愈提示换键或核对内容）；并发 UNIQUE 竞争同规则裁决。
- **工作流版本保护（Task 005 §二.2，已实现）**：batch 创建即快照 manifest/graph 内容指纹（sha256，registry 注册时计算）。调度器每拍对含 pending 的 batch 校验指纹——**内容变更 → 旧 batch 的 pending 拒绝执行**（cancelled + `WORKFLOW_VERSION_MISMATCH`，绝不静默用新版本继续旧 batch）；在途 job 不受影响（已按旧版提交，照常对账）；其他 batch 不受影响；v3 前旧行（NULL 指纹）跳过校验。完整 workflow JSON 绝不复制进 job/batch 行，只存 32 字节指纹。
- **连接门控（Task 005 §三，已实现）**：调度器提交前检查 WS 连接——ComfyUI 不可达时 pending 原地等待（**不产生 submission_unknown**，断连 ≠ 提交结果未知），重连后自动续跑；恢复/重试/级联等本地对账不受门控影响。
  - job 级：`(batch_id, idx)` 唯一；`submission_unknown` 查证流程见上，不做盲目双提交。
- **结果关联**：`executed` 事件 + `/history/{prompt_id}` 双通道收获 outputs（images/gifs/音频均收，metabrain 只认 images，审计 §1.3），统一转 `OutputRef{filename, subfolder, type, kind}` 落库。
- **输出落盘（已确认决策，Task 004 完成按需下载）**：`AUTO_SAVE_OUTPUTS=true`（默认）时 job 终态成功即经 `/view` 下载到 `OUTPUT_DIR/<batch_id>/<idx>/<filename>`（重名自动加序号），`OutputRef.local_path` 记录绝对路径；false 时结算只存引用（kind+filename），`get_result(download=true)`（默认）按需下载并持久化（幂等，`download:false` 只读引用）。
- **分页**：`get_batch` 按 `(batch_id, idx)` 排序，`limit`（默认 20，上限 100）+ `offset`；v1 用 offset（SQLite 窗口查询），规模到万级再评估 cursor。
- **重启恢复**（`recovery.ts`，启动时一次；A1 语义已实现并测试）：
  1. 扫部分索引得存量在途 job（含 `submission_unknown`）；
  2. 有 `prompt_id` → `/history/{id}`：有记录 → 按 `historyVerdict` 终态优先级定终态（error/interrupted 先判；成功才收获 outputs）；无 → 查 `/queue`：在队列（running/pending）→ 重新跟踪（不重提）；**都不在 → 保持 `submission_unknown`**（不伪装 failed、不自动重提，见上）；
  3. 无 `prompt_id` → 保守置 `submission_unknown` 同上款（runner 顺序保证实际不会发生）；
  4. 恢复后 `engine.start()` 启动调度：重跟踪的在途续判终态，存量 pending（含重启前未跑完的批量）由 Scheduler 续跑。

## 7. 核心 MCP 工具 Schema（4 个，Task 004 已全部实现）

统一约定（写入 instructions，一次握手下发）：句柄命名 `batch_id`/`index` 全工具一致可直接回填；所有列表输出有界；错误三段式（实际值(clip)/期望/修正示例）。

### list_workflows（已实现，与草案一致）

输出（默认）：`{workflows: [{name, description, version, params: N}], hint}`；指定名：`{name, description, version, params: [{name, type, required, default, enum?, min?, max?, step?, seed?, description}]}`——**摘要/详情两级**，Agent 按需取，不一次倾倒。

### run_workflow（已实现；单 params 简写与 runs 数组二选一）

```json
{ "name": "run_workflow",
  "inputSchema": {
    "workflow": "...",
    "params":  { "...": "（P2 兼容单运行，与 runs 二选一）" },
    "runs":    [ { "label"?: "...", "params": { } } ],   // 1..200 项
    "label"?:  "...",
    "idempotency_key"?: "...",       // 同键重复调用返回既有 batch，绝不产生重复生成
    "continue_on_error"?: true,      // 默认 true；false 时首个失败级联放弃剩余 pending
    "max_attempts"?: 1               // 默认 1 不重试，上限 5（含首次共 N 次尝试）
  } }
```

返回：单 params → `{batch_id, index: 0, status, next: get_result(...)}`；runs → `{batch_id, total, invalid, reused, status, next: get_batch(...)}`。**部分容错**：runs 下单 run 参数错误记 invalid job（明细 get_batch(status=invalid)），合法 run 照常提交；单 params 简写参数错误 → 整体 isError（P2 语义不变）。
草案中的 `dry_run / wait / max_retries / timeout_ms` **未实现**（dry_run 可由 list_workflows 参数表 + 本地校验替代；wait 与 MCP 客户端超时冲突；重试/超时以 batch 级 options 落地）——如后续需要再立项，不占当前接口。

### get_batch（已实现；stats 含 unknown 单列）

```json
{ "name": "get_batch",
  "inputSchema": { "batch_id": "...", "limit": 20, "offset": 0,
                   "status": "pending|invalid|submitting|unknown|queued|executing|succeeded|failed|timeout|cancelled（可选过滤，统计不受影响）" } }
```

返回：`{batch_id, workflow, status, stats: {total, succeeded, failed, running, queued, pending, invalid, unknown}, jobs: [{index, label, status, attempt_no, prompt_id, error: {code, message≤200}|null, outputs_count}], next_offset?}`。**submission_unknown 单列为 `unknown`，绝不混入 failed**；failed 口径 = failed+timeout+cancelled；不返回完整 workflow JSON / base64 / 完整参数与日志。

### get_result（已实现；download 按需下载）

```json
{ "name": "get_result",
  "inputSchema": { "batch_id": "...", "index": 0, "download": true } }
```

返回：`{batch_id, index, workflow, status, params_resolved, outputs: [{kind, filename, local_path, bytes}], error?}`。**默认本地绝对路径，绝不 base64**；AUTO_SAVE_OUTPUTS=false 时 `download=true`（默认）在查询时按需下载并持久化（幂等，`download:false` 只读引用）。草案中的 `url`/`save_dir` 选项归入 P4（save_dir 须 path-jail 集成后开放）。

辅助工具（**暂不实现**，触发条件明确后才加）：`cancel_batch`（P4：queued→/queue delete、executing→/interrupt 组合已在 timeout 路径验证）、`server_status`（health 探测，排障时）、`upload_asset`（P4：工作流出现图片输入参数时）。不引入节点/模型查询类工具（用户自己管理工作流与模型）。

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
| Q1 | ComfyUI API 细节随版本变动：`POST /prompt` 是否接受客户端指定 `prompt_id`（幂等关键，含**同 prompt_id 重复提交的行为**）；`/interrupt` 是否支持按 `prompt_id`（否则只能中断当前执行项）；`node_errors` 结构；`/history` outputs 的 gifs/audio 形状 | **已验证（0.41.0 实测，docs/003；node_errors 非空样本 Task 004 补验，docs/005 §七）**：指定 id 接受且回显；**同 id 重提会重复执行（无去重）→ 禁止盲目重提**；interrupt 按 id 对排队态是 no-op（F5 修正）；非法 combo 值 → HTTP 400 + `{nodeId: {errors:[{type, message, details, extra_info}], class_type, dependent_outputs}}`，无 prompt_id 回显、无执行事件；gifs/audio 本环境未出现 |
| Q2 | ComfyUI history 服务端保留窗口有限 → 重启恢复可能查不到 | 部分验证：history 可完整判定成功/失败/中断终态（docs/003 F6）；保留窗口上限仍未测 | P3 恢复逻辑按 `/queue`+`/history` 双查 + 不重提兜底实现 |
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
| **P0 脚手架** | 目录骨架、tsconfig/eslint/vitest、LICENSE(MIT)、better-sqlite3 安装验证（Q3）、config 模块 | build+单测绿；依赖装得上 | 0.5d | ✅ |
| **P1 Client+总线** | comfy-http/comfy-ws/event-bus、重连、二进制帧跳过；`smoke-real-comfyui.ts` 验证 Q1/Q2 全部假设 | 冒烟脚本对本机 ComfyUI 提交→等完→收 outputs 全通 | 1–2d | ✅（11/11，docs/003） |
| **P2 工作流+MVP** | registry/manifest/mapper + `list_workflows`/`run_workflow`(runs 长度 1)/`get_result`（不落盘）；examples 工作流对 | Agent 经 3 工具端到端出 1 张图 | 2–3d | ✅（115 测试 + 真实 e2e + Inspector，docs/004） |
| **P3 Batch/Job** | BatchManager/Scheduler 双窗口、get_batch、失败隔离、重试、幂等键、P2 遗留修复（终态优先级/超时取消组合/按需下载/default 语义） | 10 runs 批量（混入 2 个非法 combo + 1 个 manifest 非法）失败隔离正确；重启不丢状态 | 2–3d | ✅（157 测试 + 真实 10 任务批量，docs/005） |
| **P4 恢复+硬化** | recovery 批量场景加固、cancel_batch 辅助工具、save_dir path-jail 集成、upload_asset、错误分类打磨 | 批量执行中途 kill 重启恢复；取消工具可用 | 1–2d | P4.1（Task 005）✅：统一中断语义/版本指纹保护/manifest default 校验/幂等指纹冲突/组合语义/连接门控+8 项恢复测试（183 测试，docs/006）；P4.2 余项：cancel_batch 工具、upload_asset、save_dir |
| **P5 发布准备** | README(中英)、npx 入口、使用文档（manifest 编写指南） | 新机器按文档 10 分钟跑通 | 0.5–1d |

依赖关系：P1→P2→P3→P4 严格串行；P0 独立。合计约 7–11 个工作日。
（原 P4 中的 recovery/timeout→interrupt/path-jail/落盘已在 P2/P3 提前落地并测试，P4 收敛为取消工具、上传与硬化。）

---

*附：本设计与审计报告由三路并行子审计综合而成（metabrain MCP/工作流层、metabrain 客户端/执行层、comfy-org 设计参考），事实性结论的 file:line 证据见 `001-codebase-audit.md`。*
