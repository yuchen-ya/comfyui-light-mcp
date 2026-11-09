# 006 · Task 005 交付报告：P4.1 可靠性与状态恢复加固

> 时间：2026-11-09 · 分支 4.1（自 dd13708 切出）· 测试：**183/183 通过**（180 离线 + 3 真实 e2e）、冒烟 11/11、build/lint 全绿。
> 依据：docs/002（Task 005 修订版）、docs/003–005。

## 一、统一任务中断状态（§二.1）

**四态语义（互斥，落地于 tracker/recovery/scheduler 全路径）**：

| 场景 | 终态 | 实现 |
|---|---|---|
| 用户/ComfyUI 侧主动中断（interrupted 事件、history interrupted） | `cancelled` | WS/轮询/recovery 三处统一（原 WS 与 recovery 路径误标 failed，已修正） |
| 执行超时（我方组合取消） | `timeout` | `cancelling` 标记**先于**取消动作置位——取消窗口内到达的 interrupted 回声（WS 事件/轮询/settleFromHistory 三入口）一律忽略，由 timeout 终态（含 `remote_cancel` 结果）落定；取消期间真实成功事件仍先到者胜 |
| ComfyUI 执行失败 | `failed` | 不变（error 优先级守卫沿用 Task 004） |
| 提交结果不确定 | `submission_unknown` | 不变（不重提、占窗口） |

测试 4 项：timeout 回声不覆盖（旧缺陷回归）、非我方 interrupt → cancelled、recovery interrupted → cancelled、error 仍 failed。

## 二、工作流版本保护（§二.2）

- **指纹**：registry 注册时计算 manifest 与 API JSON 原文 sha256（`RegisteredWorkflow.fingerprint`）；batch 创建即快照入 `batches.manifest_fp/graph_fp`（migration v3；完整 workflow JSON 绝不进 job/batch 行）。
- **校验点**：调度器每拍 `verifyWorkflowVersions`——含 pending 的 batch 比对当前注册表指纹。
- **变更后果**：旧 batch 的 pending → `cancelled` + `WORKFLOW_VERSION_MISMATCH`（消息含新旧指纹前 8 位与自愈指引）；**在途 job 不受影响**（已按旧版提交，照常对账）；其他 batch 不受影响；v3 前旧行（NULL）跳过。
- 恢复测试 #7 在真实文件变更 + 重启场景验证全链路。

## 三、Manifest default 完整校验（§二.3）

加载时（`manifest.ts` superRefine）逐项校验：类型（string/number/integer/boolean/enum 匹配）、min/max、step 对齐（与 mapper 同公式）、enum default ∈ 合法值、seed default ∈ {-1} ∪ [0, 2³²-1]（未显式声明范围时兜底）。非法 manifest → `ManifestError` → registry.load 捕获 → **LoadReport 错误 + 拒绝注册**（不抛出）。测试 7 项（含 registry 集成）。

## 四、Idempotency Fingerprint（§二.4）

- **指纹**：`canonicalSha256`（递归键排序的 canonical JSON，**对象键序无关**）涵盖 workflow 名 + manifest/graph 内容指纹 + runs（label+params，**保序**）+ 归一化 continue_on_error/max_attempts。存 `batches.request_fp`（v3）。
- **裁决**：同键同指纹 → 返回既有 batch（reused，零提交；engine 预检先于连通性检查——离线重放同样成立）；同键异指纹 → `IDEMPOTENCY_CONFLICT`（自愈提示）；并发 UNIQUE 竞争 → 捕获后同规则裁决。
- 测试 11 项：键序无关、runs 保序冲突、选项变化冲突、工作流指纹变化冲突、UNIQUE 竞争两种结局、resolveExisting 三态、MCP 工具层 isError（单运行与批量两路径）。

## 五、调度组合语义（§二.5）

**continue_on_error=false × max_attempts>1 的明确规则（实现与文档一致）**：

1. **失败先重试**：attempt 未耗尽的 failed/timeout 只重置 pending 重跑（同样受双窗口约束，需等窗口空出），**不触发级联**——修正了 `batchesNeedingAbort` 原实现"见 failed 即放弃"的缺陷（现仅统计终态失败：invalid 或 attempt_no ≥ max_attempts 的 failed/timeout）。
2. **终态失败才级联**：重试耗尽/invalid 成立即取消剩余 pending（cancelled/BATCH_ABORTED），同 tick 内拦截后续提交。
3. **在途继续**：已提交的 queued/executing 不远程取消，照常对账，结果保留。
4. **未提交 → cancelled**。

测试 3 项覆盖四条规则（含"重试等窗口"的中间态断言）。

## 六、恢复测试（§三，8/8）

新套件 `tests/unit/recovery-hardening.test.ts`（文件级 db + 共享 fake 总线，跨"重启"多 Engine 实例）：

| # | 场景 | 关键断言 |
|---|---|---|
| 1 | ComfyUI 不可用时启动 | **连接门控**（scheduler 提交前检查 WS）：pending 原地等待，零提交、**零 submission_unknown**（断连 ≠ 提交结果未知） |
| 2 | 恢复连接 | 自动续跑至 completed |
| 3 | 已有 queued | recover 重挂 Tracker（requeued=1），事件定终态生效 |
| 4 | 已有 executing | history 对账 → succeeded（resolved=1） |
| 5 | 未提交即重启的 pending | 新调度器直接续跑 |
| 6 | submission_unknown | 3 轮 tick 仍零重提；持续占窗口（后续 pending 等待） |
| 7 | 工作流修改 | 旧 batch pending → WORKFLOW_VERSION_MISMATCH；在途照常完成；新 batch 正常提交 |
| 8 | 多次启动（3 轮重启） | 每 job 恰好 1 次提交，恢复零新增 |

## 七、实现清单

| 模块 | 变更 |
|---|---|
| `shared/fingerprint.ts`（新） | canonicalJson（键序无关）/canonicalSha256/sha256Hex |
| `workflow/manifest.ts` | default 完整校验 |
| `workflow/loader.ts` | 拆出纯解析 `parseWorkflowGraph`（registry 自持原文算指纹） |
| `workflow/registry.ts` | `RegisteredWorkflow.fingerprint`（manifest/graph sha256） |
| `storage/db.ts` | **migration v3**（batches + manifest_fp/graph_fp/request_fp） |
| `batch/store.ts` | 新列读写、`pendingBatchSnapshots`、`batchesNeedingAbort` 终态化修复、`abortPendingJobs(code)` |
| `batch/manager.ts` | `requestFingerprint`、`reuseOrConflict`（IDEMPOTENCY_CONFLICT）、`resolveExisting` 预检、UNIQUE 竞争指纹裁决 |
| `batch/tracker.ts` | `cancelling` 标记（拦回声三入口）、interrupted → cancelled |
| `batch/recovery.ts` | interrupted → cancelled；attempt 终态回写 |
| `batch/scheduler.ts` | 连接门控 `isConnected`；`verifyWorkflowVersions`；组合语义配套 |
| `batch/runner.ts` | submitSingle 指纹快照；attempt 终态回写沿用 |
| `core/engine.ts` | 幂等预检先于连通性；调度器接线 isConnected |

## 八、测试结果

- **离线 180**（154 → +26：中断语义 4 / default 校验 7 / 幂等指纹 11 / 组合语义 3 / 恢复加固 6 含多项子断言 / db v3 2 / 工具层冲突并入幂等项）
- **真实 e2e 3**：ComfyUI 0.41.0——单运行全链路、非法参数前置拒绝、10 任务批量（幂等指纹逻辑与真实批量兼容：同键同内容 reused）；**冒烟 11/11**（S5 interrupt 语义与本任务中断状态机相互印证：排队 no-op + /queue delete + 执行中断 error 终态）
- build / lint / tsc 全绿

## 九、P4.2 前遗留

1. `cancel_batch` 辅助工具（组合取消原语已就绪，工具化即可）。
2. `upload_asset` / `save_dir`（path-jail 集成后开放）。
3. `executing.data.node=null` 哨兵样本、视频输出映射（沿用 docs/005 遗留标注）。

---
*本报告不含本机绝对路径/密钥/个人信息（e2e 产物在 gitignored .analysis/ 下）。ComfyUI 保持运行。*
