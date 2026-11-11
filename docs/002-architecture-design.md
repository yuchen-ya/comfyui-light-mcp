# 架构与接口设计

本文保留模块划分、状态与接口设计。当前公开用法以[使用指南](usage.zh-CN.md)为准，预检与热加载细节见[功能设计](010-workflow-preflight-hot-reload.md)。

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
│  └─ integration/              # 隔离 ComfyUI 后端的端到端集成测试
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

### 4.3 Batch / Job / Scheduler

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

// core/batch/scheduler.ts（已实现；P4.1 加固）—— 双窗口提交控制
//   maxInFlight（默认 1）：在途上限 = 状态 ∈ {submitting, submission_unknown, queued, executing} 的 job 数
//     —— 限制对 ComfyUI 的总未决提交量；submission_unknown 占额（它可能仍在远端执行）
//   maxQueuedJobs（默认 1）：排队上限 = 状态 ∈ {queued} 的 job 数 —— 限制占用 ComfyUI 队列深度
//   提交条件：inFlight < maxInFlight 且 queued < maxQueuedJobs；
//   取件顺序：全局 FIFO（batch 创建序 rowid，batch 内按 idx；created_at 同毫秒也稳定）
//   每个 tick：⓪ 工作流指纹对账（漂移 → 暂停该 batch 剩余 pending；恢复一致 → 解除暂停续跑，P4.1）
//              ① 重试重置（远端已确认终止的 failed/timeout 且 attempt_no<max_attempts → pending；unknown 永不重试）
//              ② continue_on_error=false 级联放弃（仅【终态】失败——重试未用尽先重试；
//                 且在提交循环内每轮重查——同 tick 内刚失败立即拦下后续，P4.1 §6.2 组合语义）
//              ③ 窗口内逐个提交（ticking 互斥 + 条件占位双保险，tick 并发不重复提交同一 job；
//                 提交前逐 job 校验 batch 指纹快照；重试未决 batch 的其余 pending 暂缓 held）
export class Scheduler {
  ensureStarted(): void;   // 周期 500ms 定时器（unref）+ 立即一拍
  stop(): void;
  tick(): Promise<void>;   // 也可手动驱动（测试/立即推进）
}
```

### 4.4 Storage 与 Engine facade

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
- **default 语义**：参数显式提供 → 用提供值；未提供但 manifest 有 default → 用 default 值；两者皆无 → 保留工作流模板原值。`resolved_json` 记录全部 manifest 参数的实际生效值（含模板原值），保证可复现。
- **default 完整校验（P4.1）**：加载时校验 default 自身满足声明约束（类型/min/max/step 对齐/enum 合法值/seed 规则——-1 哨兵或值域内整数）；非法 manifest 整体拒绝注册并进 LoadReport（错误精确到参数与原因）。
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

**迁移 v2**：调度器热路径部分索引（无新列；幂等键复用 v1 的 UNIQUE 约束）：

```sql
CREATE INDEX idx_jobs_pending   ON jobs(batch_id, idx) WHERE status = 'pending';
CREATE INDEX idx_jobs_retryable ON jobs(batch_id, idx) WHERE status IN ('failed','timeout');
```

**迁移 v3**：工作流版本保护 + 幂等请求指纹（batches 三新列，job 级不复制 workflow JSON）：

```sql
ALTER TABLE batches ADD COLUMN manifest_fingerprint TEXT;  -- batch 创建时 manifest 内容指纹（canonical sha256）
ALTER TABLE batches ADD COLUMN graph_fingerprint TEXT;     -- batch 创建时 API 图内容指纹（即实际提交内容）
ALTER TABLE batches ADD COLUMN request_fingerprint TEXT;   -- 批量请求内容指纹（幂等重放比对）
```

- 指纹 = canonical JSON（递归排序键，数组有序）→ sha256；排版/键序变化不影响，语义内容变化必然反映。
- v2 旧库迁移上行三列为 NULL：未执行任务暂停为 LEGACY_SNAPSHOT_MISSING；旧幂等键返回 LEGACY_IDEMPOTENCY_CONFLICT，不伪称请求内容已验证。
- `request_fingerprint` 覆盖：workflow name / manifest version / 双内容指纹 / runs 内容及顺序 / continue_on_error / max_attempts（含钳制归一化）。

**迁移 v4**：同一事务检测 v3 实际列结构、执行 DDL/数据修正并更新 user_version=4。保留 4.1 的短列名 raw-text 指纹，不改认成 canonical 指纹；补长列且保持 NULL，暂停缺快照的 pending。4.1new 的 canonical 指纹保留。在 job_attempts 增加 deadline_at、cancel_requested_at、success_observed_at、terminal_confirmed；运行中旧 failed/timeout 无远端确认时转 unknown，已结束 batch 保持可查询。分支评测及回退使用独立 DATA_DIR，保留升级前备份，禁止删除用户数据库来消除列冲突。

### 6.2 状态机

```
Job:   pending ─→ submitting ─→ queued ─→ executing ─┬→ succeeded
          ↑ ↑          │            │        │        ├→ failed     ─(已确认且 attempt_no<max)─→ pending（重试）
          │ │          │            │        │        ├→ timeout    ─(同上，远端已确认中断)
          │ │          │            │        │        ├→ cancelled  （用户/外部中断；级联放弃 BATCH_ABORTED）
          │ │          │            │        │        └→ paused     ─(工作流指纹还原)→ pending（P4.1）
          │ │          ↓            ↓        ↓
          │ │    submission_unknown ─┬→ (恢复时在 /queue 或 /history 中找到) → queued/executing/终态，继续跟踪
          │ │                        └→ (两处均无) → **保持 submission_unknown**
          │ └─(WORKFLOW_VERSION_MISMATCH，P4.1)→ paused（终态前可逆：指纹还原后调度器解除）
          └→ invalid（参数校验失败，创建时即定，终态，不占提交窗口）
        （提交抛错/网络失败）（/queue 中）（WS executing）（终态；WS/history 可信终态证据）

Batch: running ─┬→ completed   （全部 succeeded）
                ├→ partial     （成功与 invalid/failed/timeout/cancelled 并存收敛）
                ├→ failed      （全部非 succeeded）
                └→ cancelled   （取消且无在途）
      （paused / submission_unknown / 重试未决 均计"未决"→ batch 保持 running）
```

**中断终态语义（P4.1 统一，四类绝不混淆）**：

| 终态 | 语义 | 触发来源 |
|---|---|---|
| `cancelled` | 用户主动取消 | WS `execution_interrupted` / history messages.execution_interrupted（无当前 attempt 超时取消意图）；级联放弃（BATCH_ABORTED）；未来 cancel_batch |
| `timeout` | 本地超时且远端确认中断 | 先落库 cancel_requested_at，再组合取消；只有 WS/history 确认中断才定 timeout，保留取消结果。取消请求失败或仅 HTTP 200 都保持 unknown，占用窗口并持续查证 |
| `failed` | ComfyUI 执行失败 | WS `execution_error` / history `error`（终态优先级：error/interrupted 先于 outputs 存在性）；提交被拒（COMFY_REJECTED） |
| `submission_unknown` | 远端结果未决 | 网络/崩溃、未确认取消或成功后待收集结果；不自动重提，持续占额。查询失败与成功查询但无记录分别说明 |

规则：

- **部分容错（已确认决策，Task 004 已实现）**：参数校验失败的 run **不阻塞整批**——合法 run 正常创建提交，非法 run 以 `invalid` 终态独立落库（error 含逐字段三段式 issues），batch 汇总中计入失败侧。`run_workflow`（runs 数组）响应带 `invalid` 计数，明细经 get_batch(status=invalid) 获取。
- **失败隔离（已实现；P4.1 修订组合语义）**：单 job 失败不影响 batch 内其他 job（默认 `continue_on_error=true`）。`continue_on_error=false × max_attempts>1` 的精确语义（P4.1 §6.2）：
  1. **失败允许先重试**：远端确认终止的 failed/timeout 且次数未用尽 → 下一 tick 重置 pending 重提（全新 prompt_id）；
  2. **重试未决期间该 batch 的其余 pending 暂缓提交**（held）——不放弃也不消耗生成，等重试定局（重试已进入 queued/executing 也继续 held，2/2 窗口覆盖）；
  3. **级联取消仅在终态失败时触发**：invalid（创建即终态，无重试概念）或 failed/timeout 且 `attempt_no ≥ max_attempts` → 剩余 pending 全部 `cancelled`/BATCH_ABORTED；同一 tick 内刚用尽重试也立即拦截（提交循环每轮重查）；
  4. **在途 job 不受级联影响**：已提交的 queued/executing 照常执行至终态；
  5. **尚未提交的 job → cancelled**（BATCH_ABORTED，明示未消耗生成）。
- **工作流版本保护（P4.1 已实现）**：batch 创建时快照 `workflow_version + manifest_fingerprint + graph_fingerprint`（v3 列）；恢复与每 tick 提交前比对当前注册工作流指纹。漂移 → 该 batch 剩余 pending 转 `paused`（error=WORKFLOW_VERSION_MISMATCH，含差异明细），**绝不静默用新版本续跑旧 batch**；其他 batch 不受影响；已提交的在途 job 照常定终态（旧图已在 ComfyUI 侧）。工作流内容还原（指纹恢复一致）→ 调度器自动解除暂停续跑。旧行缺少任一指纹 → LEGACY_SNAPSHOT_MISSING 暂停；不得把当前文件回填为历史快照。
- **Manifest default 完整校验（P4.1 已实现）**：default 必须自身满足声明的全部约束——类型正确（string/number/integer/boolean/enum）、min/max 满足、step 对齐（相对 min）、enum default 须在合法值内、seed 的 default 与显式输入共用同一规则：-1 为随机哨兵，普通值及随机结果限于声明范围与 [0, 0xffffffff] 的交集内整数；seed 不应用 step。非法 manifest **整体拒绝注册**并进 LoadReport（精确到参数与原因）。
- **重试（已实现）**：仅对远端确认终止（terminal_confirmed=1）的 `failed/timeout` 且 `attempt_no < max_attempts`（默认 1 即不重试，上限 5；`submission_unknown` 永不自动重试）。每次尝试全新 prompt_id + 独立 `job_attempts` 行，历史只增不改；重试未用尽期间 batch 视为未决（保持 running）。
- **submission_unknown**：`submitting` 遇网络失败或进程崩溃时进入该状态。`prompt_id` 在 POST 前已持久化。恢复按 `/queue` 与 `/history/{prompt_id}` 对账；能查到则继续跟踪或确认终态，两处皆无则继续保持 unknown，不伪装成 failed、不自动重提。客户端指定的 prompt_id 不是后端去重保证。
- **timeout**：claim 事务在 POST 前持久化 deadline_at；恢复按原始 deadline 计时。超时先事务写 cancel_requested_at，再发送 queue delete + 定向 interrupt。RPC 失败、响应丢失或仅返回 HTTP 200 均不足以证明远端停止：保持 submission_unknown/TIMEOUT_UNCONFIRMED，继续占额和对账。当前 attempt 的中断证据到达后才事务结算 timeout；用户/外部中断无本地意图则 cancelled。success 已观察但 history 暂不可用时保留 success_observed_at/RESULT_PENDING，重试查询，不重跑生成。
- **History 终态判定**：ComfyUI 0.41.0 的 status_str 为 success/error，中断记录在 messages.execution_interrupted；真实执行异常为 execution_error。先识别终态消息，再识别明确成功；部分 outputs 不证明成功。恢复、WS、轮询共享单次异步结算入口，终态 job/attempt/batch 在同一事务更新，并检查 attempt_no/prompt_id 防止迟到写回。
- **幂等性（已实现；P4.1 加固为内容感知）**：
  - batch 级：`idempotency_key` 唯一约束 + **请求内容指纹比对**（P4.1）。同键重放：内容一致（canonical JSON，参数键序无关）→ 返回既有 batch（不建新行、不产生新提交）；**内容不同 → `IDEMPOTENCY_CONFLICT`**（含既有/本次指纹短前缀，须换新键），既有 batch 不受影响。并发 UNIQUE 竞争路径同样先比对指纹再决定命中/冲突。指纹覆盖 workflow name / manifest version / 双内容指纹 / runs 内容及顺序 / continue_on_error / max_attempts（钳制归一化）。旧行缺请求指纹 → LEGACY_IDEMPOTENCY_CONFLICT；可按 batch_id 查询，不能承诺内容一致。
  - job 级：`(batch_id, idx)` 唯一；`submission_unknown` 查证流程见上，不做盲目双提交。
- **结果关联**：`executed` 事件 + `/history/{prompt_id}` 双通道收获 outputs（images/gifs/音频均收，metabrain 只认 images，审计 §1.3），统一转 `OutputRef{filename, subfolder, type, kind}` 落库。
- **输出落盘（已确认决策，Task 004 完成按需下载）**：`AUTO_SAVE_OUTPUTS=true`（默认）时 job 终态成功即经 `/view` 下载到 `OUTPUT_DIR/<batch_id>/<idx>/<filename>`（重名自动加序号），`OutputRef.local_path` 记录绝对路径；false 时结算只存引用（kind+filename），`get_result(download=true)`（默认）按需下载并持久化（幂等，`download:false` 只读引用）。
- **分页**：`get_batch` 按 `(batch_id, idx)` 排序，`limit`（默认 20，上限 100）+ `offset`；v1 用 offset（SQLite 窗口查询），规模到万级再评估 cursor。
- **重启恢复**（`recovery.ts`，连通/重连时先串行恢复，周期继续查证 unknown；遵循先对账、后调度的恢复规则）：
  1. 扫部分索引得存量在途 job（含 `submission_unknown`）；
  2. 有 prompt_id：交给 Tracker 的统一异步入口，先查 history 终态，再查 queue 挂接；成功查询但两处无记录保持 unknown。查询失败保留原状态并报告 RECONCILIATION_FAILED，不能声称两处无记录。中断按持久化取消意图区分 timeout/cancelled；输出收集并发去重，下载失败只重试下载。
  3. 无 `prompt_id` → 保守置 `submission_unknown` 同上款（runner 顺序保证实际不会发生）；
  4. **工作流指纹校验（P4.1）**：含 pending job 的 running batch 逐一比对指纹快照，漂移 → 暂停其 pending（报告 `pausedOnVersionMismatch`）；恢复多次运行幂等（已终态 job 不重扫、已跟踪 job `tracker.track` 去重、输出只收获一次）；
  5. engine.start 启动周期调度：首次连通、延迟首连和后续重连均先串行对账，逐次 POST 前检查连接及已对账的连接 epoch；unknown 继续有界查询，不重新 POST。Engine.stop 返回 Promise，关闭 DB 前须 await，以排空正在进行的结果收集。

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
`dry_run` 提供只读预检，见[预检设计](010-workflow-preflight-hot-reload.md)。`wait`、`max_retries`、`timeout_ms` 不在当前提交接口中；重试与超时使用批次选项和全局配置。

### get_batch（已实现；stats 含 unknown/paused 单列）

```json
{ "name": "get_batch",
  "inputSchema": { "batch_id": "...", "limit": 20, "offset": 0,
                   "status": "pending|invalid|submitting|unknown|queued|executing|succeeded|failed|timeout|cancelled|paused（可选过滤，统计不受影响）" } }
```

返回：`{batch_id, workflow, status, stats: {total, succeeded, failed, running, queued, pending, invalid, unknown, paused}, jobs: [{index, label, status, attempt_no, prompt_id, error: {code, message≤200}|null, outputs_count}], next_offset?}`。**submission_unknown 单列为 `unknown`、版本漂移暂停单列为 `paused`，绝不混入 failed**；failed 口径 = failed+timeout+cancelled；不返回完整 workflow JSON / base64 / 完整参数与日志。

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
