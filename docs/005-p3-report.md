# 005 · Task 004 交付报告：Batch Manager + Scheduler + get_batch

> 时间：2026-11-09 · 分支 main · 基线 48fac08 → 本次交付 · 测试：**157/157 通过**（154 离线 + 3 真实 e2e）、冒烟 11/11、真实 10 任务批量全验收。
> 依据：docs/002（Task 004 修订版）、docs/003、docs/004。

## 一、P2 遗留修复（§二全部落地）

| # | 要求 | 实现 | 测试 |
|---|---|---|---|
| 1 | History 终态优先级：error 不得因部分 outputs 判 succeeded | 统一 `historyVerdict()`（tracker.ts）：error/interrupted **先判**，success/completed 次之，"仅有 outputs"为兼容末位；tracker 轮询、`settleFromHistory` 防御守卫（execution_success 事件到达但 history 实为 error → failed）、recovery 三处共用 | p2-fixes ①3 项：verdict 单元、tracker 守卫（outputs 不收获）、recovery（零文件落盘） |
| 2 | 超时取消：queued→/queue delete，executing→/interrupt，竞态处理，记录远端结果 | `handleTimeout`：先组合取消（`deleteQueue([id])` + `interrupt(id)`——两动作对错误态均为已验证 no-op（F5），任务恰在两动作间转态也无空窗）再 settle；取消期间已由事件定终态 → 先到者胜不覆盖；结果 `{queue_delete, interrupt}`（ok/error 明细）记入 `error_json.remote_cancel` | p2-fixes ②3 项：双动作+记录、先成功不取消、远端失败仍 timeout 且留痕 |
| 3 | AUTO_SAVE_OUTPUTS=false 时 get_result 按需下载 | 结算只存引用（kind+filename）；`get_result(download=true)`（默认）经 `AssetManager.downloadRefs` 下载到与即时落盘相同布局并**持久化回 outputs_json**（幂等，二次查询零下载）；`download:false` 只读引用 | p2-fixes ③3 项：按需+幂等+文件存在、只读、autoSave 对照 |
| 4 | manifest default 语义 | `applyParams`：显式提供 > manifest default > **模板原值**；`resolved_json` 记录全部参数实际生效值（含模板原值，可复现） | mapper 更新 2 项 + p2-fixes ④端到端（steps=20 回写） |
| 5 | 回归测试 | 上述全部新增 | 9 项新回归全绿 |

## 二、Batch Manager（§三）

- **创建**：`BatchManager.createBatch`——runs 数组（1..200）→ **单 SQLite 事务**创建 batch + 全部 job 行（`createBatchWithJobs`；条件占位 `claimForSubmit` 的事务内亦含 attempt 行，满足"Batch/Job/Attempt 初始记录必须事务创建"）。
- **部分容错**：逐 run `validateParams`，非法 → `invalid` job（error 含逐字段三段式 issues）+ 计入响应 `invalid` 数；合法任务照常 pending 待调度。
- **幂等**：`idempotency_key` 命中既有 batch → 返回 `{reused: true, batchId}` 不建任何新行；并发 UNIQUE 竞争亦兜底回查。单 params 简写与 runs 二选一（同传报错），P2 调用方式完全兼容。
- **查询**：`getBatchView`——8 键 stats（**unknown 单列**，failed 口径=failed+timeout+cancelled）、分页（limit≤100 + next_offset）、状态过滤（`unknown` 为 `submission_unknown` 别名；统计不受过滤影响）、job 视图有界（错误 ≤200 字符，无 params/outputs 原文/工作流 JSON）。

## 三、Scheduler（§四）

- **双窗口**：`MAX_IN_FLIGHT`（submitting/submission_unknown/queued/executing 全局计数）与 `MAX_QUEUED_JOBS`（仅 queued），默认 1/1 完全串行；config 层维持 `maxQueuedJobs ≤ maxInFlight`。
- **顺序**：全局 FIFO 按 **batch 创建序（rowid，同毫秒稳定）**、batch 内按 index；测试证实跨 batch 先创建先提交。
- **防重复提交（双保险）**：① `ticking` 互斥——进行中的 tick 未结束时后续调用直接返回；② `claimForSubmit` 条件占位 `UPDATE ... WHERE status='pending'`（事务内含 attempt 行）。测试：5 个并发 tick（窗口 3/3）恰好 3 次提交、每 job attempt_no=1；同 job 并发 `submitJob` 一方 null。
- **submission_unknown 占额**：计入在途窗口（可能仍在远端执行）——1/1 下首个 unknown 使后续 pending 永不提交，测试证实。这是"宁可保留 unknown 也不允许重复生成"的窗口层落实。
- **失败隔离 / continue_on_error**：默认 true 单 job 失败不影响其余；false 时首个终态失败级联放弃剩余 pending（`cancelled`/BATCH_ABORTED），且提交循环**每轮重查**——同 tick 内刚失败立即拦下同 batch 后续提交（测试证实 b 不再被提交）。
- **超时**：tracker 墙钟超时（见 §一.2 组合取消）。
- **重试**：batch 级 `max_attempts`（默认 1 不重试，上限 5，含首次共 N 次）；仅 failed/timeout 且 `attempt_no < max_attempts` 由 tick 重置 pending 后重提——**全新 prompt_id** + **独立 job_attempts 行**（终态回写：submitting→queued→succeeded/failed/...，含独立 prompt_id 与 finished_at）；**submission_unknown 永不自动重试**（即使 max_attempts>1，测试证实 5 次 tick 仅 1 次提交）。重试未用尽期间 batch 不收敛（保持 running）。
- **重启续跑**：恢复出的 queued/executing 交还 tracker，存量 pending（重启前未跑完的批量）由 Scheduler 直接续跑（两条路径均有测试）。
- **定时器健壮性**：周期 500ms（unref）；tick 异常吞掉下一拍重对账（setInterval 回调未捕获异常会杀死进程）；`engine.start()/stop()` 管理生命周期。

## 四、get_batch 工具（§五）

第 4 个核心 MCP 工具。入参 `{batch_id, limit=20, offset=0, status?}`；输出 `{batch_id, workflow, status, stats{total,succeeded,failed,running,queued,pending,invalid,unknown}, jobs[{index,label,status,attempt_no,prompt_id,error{code,message≤200},outputs_count}], next_offset?}`。

- 汇总统计准确（真实 10 任务批量上逐键断言）；submission_unknown 单列 `unknown` 绝不混入 failed（专用测试：混合 9 态 stats 逐键相等）。
- 默认只返回必要字段；错误消息有界截断；分页 + 状态过滤（`status=unknown` 别名）；不返回完整 workflow JSON / base64 / 完整参数与日志（测试断言视图 JSON 不含参数键名）。

## 五、幂等与异常恢复（§六逐项证据）

| 要求 | 测试证据 |
|---|---|
| 1. 同 idempotency_key 只创建一个 Batch | batch-manager「幂等键」：两次创建同 batchId、job 数不变；mcp-tools「幂等键」工具层同证 |
| 2. 重复请求不产生额外 ComfyUI 提交 | 同上：`submitCalls` 不增长（工具层） |
| 3. 提交期间崩溃不盲目重提 | a1-lifecycle（P2 既有 5 项保持全绿）+ 提交前持久化顺序不变（claimForSubmit 在 POST 前） |
| 4. submission_unknown 不被自动重试 | scheduler「unknown 永不自动重试」+「占用在途额度」 |
| 5. 重试保留 attempt 历史 | scheduler「重试」：2 行 attempt、不同 prompt_id、终态回写 |
| 6. MCP 重启后恢复 Batch/Job | scheduler「重启恢复」（在途 re-track + pending 续跑）+「未提交即重启」 |
| 7. 部分成功部分失败统计正确 | batch-manager「unknown 单列」+ 真实批量 stats 逐键断言 |

## 六、node_errors 真实验证（§七）

**探针**：`scripts/node-errors-probe.ts`（已提交，可复跑）。以 `sampler_name="euler_NOT_EXIST"`（manifest 声明 `sampler` 为普通 string → 前置校验放行）触发：

- **HTTP 状态码**：`400`
- **error 结构**：`{"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "", "extra_info": {}}`
- **node_errors 结构**：

```json
{
  "7": {
    "errors": [{
      "type": "value_not_in_list",
      "message": "Value not in list",
      "details": "sampler_name: 'euler_NOT_EXIST' not in (list of length 45)",
      "extra_info": { "input_name": "sampler_name", "input_config": null, "received_value": "euler_NOT_EXIST" }
    }],
    "dependent_outputs": ["9"],
    "class_type": "KSampler"
  }
}
```

- **prompt_id**：响应无回显（ok:false 无该字段）；**执行事件**：无（拒绝后 `/queue` 长度零新增，从未入队）。

**归一化处理**（`runner.ts:normalizeNodeErrors`，按真实样本形状实现）：`{nodeId: {errors[], class_type, dependent_outputs}}` → 紧凑数组 `[{node, class_type, input, type, message(≤300), received_value}]`，写入 `error_json.node_errors`；`error_json.message` 携带 `HTTP 状态 + error.type + node/input/type` 摘要（真实样本：`ComfyUI 拒绝提交（HTTP 400, prompt_outputs_failed_validation）: 7/sampler_name: value_not_in_list — sampler_name: 'euler_NOT_EXIST' not in (list of length 45)`）。真实批量 e2e 对 2 个非法 combo job 断言了归一化结果逐字段相等。

## 七、SQLite Migration

- **v2**（`db.ts`）：`idx_jobs_pending`（pending 扫描热路径）+ `idx_jobs_retryable`（failed/timeout 重试扫描）两个部分索引；幂等键复用 v1 的 `batches.idempotency_key UNIQUE`，无新列。迁移幂等（user_version=2，测试覆盖）。
- **事务**：`store.transaction()` 暴露 better-sqlite3 事务；`createBatchWithJobs`（batch+N jobs）与 `claimForSubmit`（占位+attempt 行）均在事务内。

## 八、测试结果

- **离线 154**：新增 batch-manager 12 / scheduler 13 / p2-fixes 10 / mcp-tools 批量与幂等 3；既有套件全部保持（a1 语义、mapper 新 default 语义、db v2、工具数 4）。覆盖任务书全部离线项：100 job 批量创建 ✅ 部分 invalid ✅ 双窗口限制 ✅ 串行调度 ✅ 多 Job 并发跟踪 ✅（窗口>1 多 job 在途）失败隔离 ✅ 重试历史 ✅ 幂等键 ✅ Batch 汇总 ✅ 分页 ✅ timeout ✅ unknown ✅ 重启恢复 ✅ 多次 tick 不重复提交 ✅。
- **真实 e2e 3**（ComfyUI 0.41.0）：
  1. 单运行全链路（P2 既有，调度管线化后保持）：succeeded + 本地 png + 模板 sha256 零变化 + seed 回写；
  2. 非法参数提交前被拒；
  3. **10 任务批量**（7 合法 steps=4/512px + 2 非法 combo + 1 manifest 越界）：
     - batch 状态 `partial`，stats 逐键 `{total:10, succeeded:7, failed:2, running:0, queued:0, pending:0, invalid:1, unknown:0}`；
     - 非法 combo → `failed` + 归一化 node_errors（§六）；manifest 越界 → `invalid`（未到达 ComfyUI）；
     - 7 张图 `OUTPUT_DIR/<batch_id>/<idx>/qwen-image-demo_000NN_.png`（135–231KB，字节数与 /view 一致），seed 4242000..4242006 与任务一一对应；
     - attempt 审计：7×`{attempt_no:1, status:"succeeded"}` + 2×`failed`（invalid 无 attempt 行）；
     - **幂等**：同 `idempotency_key="e2e-batch-10"` 重复调用 → 同 batchId、job 数仍 10、无重复生成；
     - 分页/状态过滤在真实数据上断言（failed 页=[1,3]，尾页 next_offset=null）。
- **冒烟 11/11**（S8 需显式传真实 ComfyUI 输出目录做 sha256 对照）。

## 九、docs/002 更新

§4.3/4.4 接口与实现对齐、§5 default 语义、§6.1 v2 索引、§6.2 规则（终态优先级/组合取消/重试/unknown 占额/恢复流程 A1 化——顺带修正了 2 条 Task 003 遗留的"unknown→failed"旧文案）、§7 四工具实装 schema（未实现项 dry_run/wait/url/save_dir 显式标注归 P4）、§9 Q1 node_errors 补验、§10 P3 ✅（P4 范围相应收敛）。

## 十、P4 前遗留问题

1. `executing.data.node=null` 完毕哨兵样本仍未捕获（execution_success 已覆盖成功路径判定，风险低）。
2. 视频输出（gifs→video）映射仍未在真实视频工作流上验证。
3. cancel_batch 辅助工具（P4）：组合取消原语（queue delete + interrupt）已在 timeout 路径实现并测试，工具化是薄封装。
4. tracker 3s history 轮询在更大批量（>10 并发）下的频率调优未压测。
5. upload_asset / save_dir path-jail 集成（P4）。

---
*本报告不含本机绝对路径/密钥/个人信息（e2e 产物在 gitignored .analysis/ 下；隐私检查记录见提交信息）。ComfyUI 保持运行。*
