# 006 · Task 005 交付报告：P4.1 可靠性与状态恢复加固

> 时间：2026-11-09 · 分支 4.1new · 基线 dd13708 → 本次交付 · 测试：**222/222 通过**（离线 218 + 真实 e2e 4）、冒烟 11/11（含 S8 sha256 对照）、真实恢复/版本保护 e2e 新增并通过。
> 依据：docs/002（本次修订）、docs/003–005。范围：加固现有 Batch/Job 系统，**不重构架构、不加新工具、不动默认窗口（1/1）**。

## 一、统一任务中断状态（§二.1）

四类语义严格区分，修掉了 3 处历史不一致：

| 语义 | 终态 | 本次修正点 |
|---|---|---|
| 用户主动取消 | `cancelled` | **WS `execution_interrupted` 曾误标 failed** → 改 cancelled（用户在 ComfyUI UI 按 Stop、外部 /interrupt 都属此类）；recovery 经 history 判 interrupted **曾误标 failed** → 改 cancelled（tracker 轮询路径此前已正确，三路现已统一） |
| 执行超时 | `timeout` | **核心竞态修复**：超时触发的组合取消（queue delete + interrupt）会引发 ComfyUI 回发 `execution_interrupted`/history interrupted——此前该事件会把 timeout 误标为普通 failed。现 tracker 立 `timeoutCancelInFlight` 标志：取消期间到达的 interrupted 一律视为"我们自己取消的效果"，由 `handleTimeout` 统一定 **timeout**，`error_json.remote_cancel` 完整保留 `{queue_delete, interrupt}` 动作结果（ok/error 明细），错误消息注明 interrupted 为取消效果（审计可辨） |
| ComfyUI 执行失败 | `failed` | 不变：WS `execution_error` / history `error`（含终态优先级守卫：error 先于 outputs 存在性）；取消期间收到真实 error 也按先到者判 failed |
| 提交结果不确定 | `submission_unknown` | 不变（A1 语义） |

竞态窗口细节：取消期间收到 `execution_success`（任务恰好在取消瞬间完成）→ success 的异步结算（settleFromHistory）被 `handleTimeout` 显式等待（`asyncSettle`），先到者为准不改判 timeout；结算因 interrupted 推迟时才落到 timeout——两个方向都不再互相踩踏。未来 `cancel_batch` 的取消路径复用同一状态机（用户取消 → cancelled），本任务未实现该工具（按约束不加功能）。

## 二、工作流版本保护（§二.2）

- **快照**：batch 创建时保存 `workflow_version + manifest_fingerprint + graph_fingerprint`（migration v3 三新列，均在 **batches 行**——job 级不复制 workflow JSON）。指纹 = canonical JSON（递归排序键、数组有序）→ sha256：排版/键序变化不误报，语义内容变化必现；graph 指纹取**归一化后实际提交给 ComfyUI 的图**（class_type+inputs），manifest 指纹取解析后对象。
- **验证点**：① 恢复时（`recoverInFlight` → `pauseDriftedPendingBatches`，对含 pending 的 running batch）；② 调度器每 tick 提交前（逐 job 携带 batch 快照再校验一次，双保险）；③ tick 开头的指纹对账使漂移**即时可见**（不等窗口空出）。
- **漂移行为**：该 batch 剩余 pending → 新状态 **`paused`**（error=`WORKFLOW_VERSION_MISMATCH`，含 manifest/图指纹与版本的前后对照明细）；**绝不静默用新版本续跑旧 batch**；其他 batch 不受影响；已提交的在途 job 照常定终态（旧图已在 ComfyUI 侧执行，与漂移无关）。`get_batch` stats 单列 `paused`（绝不混入 failed），batch 因 paused 未决保持 running。
- **解除**：工作流内容还原（指纹恢复一致）→ 调度器自动 paused→pending 续跑（暂停错误清除）；真实 e2e 验证了 漂移→暂停→还原→续跑→全批完成 全链路。仍漂移/工作流不在注册表则保持 paused。
- **旧行兼容**：v2 库迁移上来的 batch 三指纹列为 NULL → 跳过校验（尽力兼容，不阻断旧任务），有专门测试。

## 三、Manifest default 完整校验（§二.3）

`validateParamDefault`（manifest.ts，zod superRefine 内逐参数调用）——非法 manifest **整体拒绝注册**，进 LoadReport（错误精确到 `params[name]` 与原因）：

- 类型正确：string/boolean/number(有限)/integer(整数)/enum(字符串且在合法值内)；
- min/max：default 不得越界（边界值放行）；
- step：对齐检查相对 min（无 min 相对 0），浮点容差 1e-9 与运行期 mapper 一致；
- enum：default ∈ enum 声明值；
- seed：default 只允许 **-1**（随机哨兵，不受 min 约束——哨兵语义优先）或 [min??0, max??0xffffffff] 内整数；-2 / 2^32 / 2.5 均拒绝。

含 19 项专项测试（逐规则拒绝/放行 + 真实示例 manifest 全通过 + registry 拒注册联动）。

## 四、Idempotency Fingerprint（§二.4）

- `batches.request_fingerprint`（v3 列）= canonical JSON sha256，覆盖：workflow name / manifest version / **manifest+图内容指纹** / runs 内容及顺序 / continue_on_error / max_attempts（1..5 钳制归一化——99 与 5 等价）。
- **键序无关**：stableStringify 递归排序对象键（数组保序），`{"seed":1,"prompt":"a"}` 与 `{"prompt":"a","seed":1}` 指纹一致（专项测试）；runs 顺序即语义（换序 → 不同指纹 → 冲突）。
- 同键重放：内容一致 → 返回既有 batch（不建行、不重提）；**内容不同 → 抛 `IDEMPOTENCY_CONFLICT`**（新错误码；消息含既有 batch 短 id 与双方指纹 12 位前缀），既有 batch 完好。`runSingle`/`runBatch` 的 engine 早查路径与 `createBatch` 主路径、**并发 UNIQUE 竞争回查路径**三处统一比对（竞争测试：早查不可见→插入撞 UNIQUE→回查→同容命中/异容冲突，均正确）。
- v3 前旧行无指纹 → 按命中处理（尽力兼容，测试覆盖）。

## 五、调度组合语义（§二.5）：continue_on_error=false × max_attempts>1

发现并修复一个**提前级联 bug**：原 `batchesNeedingAbort` 把"重试未用尽"的失败也当终态，同 tick 内重试再失败会立刻放弃剩余任务。修订后的精确语义（文档与状态机同步，docs/002 §6.2）：

1. **失败允许先重试**（重试优先于级联）；
2. 重试未决期间该 batch **其余 pending 暂缓提交**（`heldPendingBatches`——不放弃也不消耗生成）；
3. **级联取消仅在终态失败触发**：invalid（创建即终态）或 failed/timeout 且 attempt_no ≥ max_attempts；同 tick 用尽也立即拦截（提交循环每轮重查）；
4. **在途 job 照常执行**至终态（级联只取消 pending）；
5. **尚未提交 → cancelled/BATCH_ABORTED**（明示未消耗生成）。

回归测试含"同 tick 内重试再失败不得提前级联"专项；对照 continue_on_error=true 全程不级联不挂起。

## 六、恢复 8 项（§三）——`tests/unit/recovery-hardening.test.ts` 全数落地

| # | 场景 | 结果 |
|---|---|---|
| 1 | ComfyUI 不可用时启动 | MCP/engine 正常构造；工具连通性门禁明确报 COMFY_UNREACHABLE；恢复对账不崩溃，在途保守保持 submission_unknown（下次启动再查证） |
| 2 | 后续恢复连接 | ws 状态转 open 后调度照常提交、生成恢复，无人工干预 |
| 3 | queued job 重新挂接 Tracker | /queue 命中 → requeued + re-track，事件照常定终态，不重提 |
| 4 | executing job 经 history 对账 | 成功定终态 + 输出落盘（resolved 计数） |
| 5 | pending job 继续执行 | 新调度器接管直接续跑至全批完成 |
| 6 | submission_unknown 不重提 | 连续 3 次恢复均 keptUnknown、提交数恒 1、attempt 恒 1 行 |
| 7 | 工作流修改后不执行旧 batch 剩余 | 恢复即暂停（WORKFLOW_VERSION_MISMATCH），多 tick 不提交；用新工作流创建的其他 batch 不受影响 |
| 8 | 多次启动恢复不重复提交 | 两次重启恢复重挂接幂等（tracker 去重）、attempt 不增、远端零重复；已定终态 job 二次恢复 no-op，输出只收获一次 |

## 七、SQLite Migration v3

```sql
ALTER TABLE batches ADD COLUMN manifest_fingerprint TEXT;
ALTER TABLE batches ADD COLUMN graph_fingerprint TEXT;
ALTER TABLE batches ADD COLUMN request_fingerprint TEXT;
```

三列均可空（旧行 NULL = 跳过对应校验）；`user_version=3`，幂等迁移与旧行 NULL 语义均有测试。无新表、无 job 级冗余（指纹只在 batch 行，一处存储）。

## 八、测试与验收

- **离线 218**（新增 63：manifest-default 19 / idempotency 13 / interruption-semantics 8 / workflow-version 8 / recovery-hardening 9 / scheduler-combination 6，另 db v3 迁移测试扩充；既有断言随 stats 增补 `paused` 键同步更新）；既有 155 离线全保持。
- **真实 e2e 4**（ComfyUI 0.41.0）：既有单运行 + 10 任务批量保持通过（新指纹链路下 stats 逐键断言含 paused:0）；**新增 `real-recovery.e2e`**：3 任务批量 → job0 完成即"崩溃"（engine/client/db 全销毁，仅 SQLite 存活）→ 用 **denoise 漂移的工作流**重启 → 恢复：job1 在途重挂接自然完成、job2 被 WORKFLOW_VERSION_MISMATCH 暂停且 4 秒多 tick 零提交（未静默用新版本）→ 用**还原的工作流**再重启 → 暂停自动解除续跑 → 3/3 completed；全程每个 job 恰 1 行 attempt（两次重启零重复提交）；真实栈上同键异容 → IDEMPOTENCY_CONFLICT、同键同容 → 复用。
- **冒烟 11/11 保持**（scripts/smoke-real-comfyui.ts，P1 假设回归）。
- build / lint / test 全绿；隐私扫描（AGENTS.md 要求）：新增内容无密钥/令牌/本机绝对路径（e2e 产物在 gitignored `.analysis/`）。

## 九、docs/002 修订摘要

§4.3 Scheduler 三步→五步（指纹对账/终态级联/held）；§5 default 完整校验；§6.1 v3 迁移与指纹定义；§6.2 状态机图（paused 边）+ 中断终态四类对照表 + 组合语义 5 条 + 版本保护/幂等指纹/恢复流程（含 pausedOnVersionMismatch 与多次恢复幂等）；§7 get_batch stats/过滤词表 + paused；§10 P4 行标注 P4.1 完成。

## 十、遗留（进入 P4.2 前待架构审查确认）

1. `paused` 为可逆挂起态：自动解除仅限"指纹完全还原"；是否需要显式 resume/abandon 工具（如 `resume_batch(force)`）留待 P4.2 决策。
2. 幂等键无 TTL（沿用 v1 现状）；docs/002 曾提 24h TTL，未实现亦未改变——是否补 TTL 待定。
3. `submission_unknown` 在 ComfyUI 长期不可达时会占满在途窗口（设计内行为，instructions 已提示换新 batch/key）；是否加"unknown 重查证"后台任务待定。
4. cancel_batch 工具仍未实现（约束内不新增；状态机已就绪，薄封装即可）。

---
*本报告不含密钥/令牌/个人信息/本机绝对路径。完成后停在 P4.1，等待架构审查，不进入 P4.2。*
