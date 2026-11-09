# Task 005-R2：旧库 pending 重试安全修复

基线：`9309ba5`，分支：`codex/task005r-integration`。本轮只修复旧版已重置为 pending、上一 Attempt 尚未获得远端终止确认的重试路径；不合并 main，不进入 P4.2。

## 实现

- 新增 v5 数据迁移，覆盖 v3 直接升级和已经升级到 v4 的数据库。运行中 batch 的 pending/attempt_no>0，如果对应 Attempt 没有 terminal_confirmed=1，恢复为 submission_unknown；保留 prompt_id、attempt_no 和错误详情，由现有对账流程接管并占用窗口。不会回填工作流快照。
- 在改写旧 Attempt 状态前，从旧 timeout/TIMEOUT 恢复 cancel_requested_at，从 NO_HISTORY 恢复 success_observed_at；不伪造远端确认。已有时间戳优先保留，旧 remote_cancel 详情保留到后续中断结算。
- claimForSubmit 在写入新 prompt_id/Attempt 的同一事务内检查前次 Attempt：必须已确认，状态为 failed/timeout，且未达到 batch.max_attempts。直接将 Job 改成 pending 也不能绕过此检查；首次提交不受影响。
- DDL、数据修改和版本号继续使用现有迁移事务；重复打开或 migrate 不会重复转换已修复的数据。

## 新增回归与状态证据

新增文件：`tests/unit/task005r2-pending-retry.test.ts`，共 16 项。升级用例使用磁盘 SQLite 和旧 schema；batch 指纹来自同一测试工作流经真实 WorkflowRegistry 加载所得的 canonical 计算结果，保证不会由缺快照保护掩盖问题。

下表 POST 均为本轮恢复后新增提交数，不含旧版的第 1 次提交。

| 用例名与展开项 | 升级前 Job / Attempt | 升级并启动后的证据 | 后续证据 |
|---|---|---|---|
| `$version pending timeout holds its slot until $outcome (max_attempts=$maxAttempts)`：v3/4.1new 与 v4，各展开 success/2、interrupted/1、interrupted/2，共 6 项 | Job=pending，attempt_no=1，旧 prompt_id；Attempt=timeout，v4 的 terminal_confirmed=0 | schema=5；Job/Attempt=submission_unknown；旧 prompt_id 与 attempt_no 保留；cancel_requested_at 取旧 finished_at；反复 tick 和轮询 6 秒后 POST=0、在途=1；remote_cancel 未丢失 | success：原 Attempt=succeeded/confirmed=1，POST=0、在途=0；中断且 max_attempts=1：原 Attempt=timeout/confirmed=1，POST=0、在途=0；中断且 max_attempts=2：原 Attempt=timeout/confirmed=1，新 Attempt=queued，使用新 prompt_id，POST=1、在途=1 |
| `%s restores NO_HISTORY intent from the previous attempt without cancelling or resubmitting`：v3 与 v4，共 2 项 | Job=pending，Attempt=failed/NO_HISTORY（错误只存在于 Attempt） | 恢复 success_observed_at，cancel_requested_at=NULL；POST=0、在途=1；不调用 queue delete 或 interrupt | 后来 history=success，原 Attempt 收敛，只有 1 次历史 Attempt，POST=0 |
| `v4 migration leaves first submissions and confirmed pending retries executable after reopening`：1 项 | v4 合法 pending 重试，上一 Attempt=timeout/confirmed=1；另建首次 pending/attempt_no=0 | 两次打开后均保留合法 pending | 先提交安全重试，完成后提交首次任务，共 POST=2；两者均正常进入 queued |
| `claim checks previous $status confirmation=$confirmed and max_attempts=$maxAttempts inside the submit transaction`：7 项 | 绕过候选筛选，直接预置 pending | 未确认 timeout、缺少 Attempt、已成功、已取消、次数用尽：POST=0，不改旧 prompt_id/attempt_no，不新增 Attempt | 已确认 failed/timeout 且次数未用尽：各 POST=1，attempt_no=2，使用新 prompt_id |

## 本轮实际验证

- `npm run build`：通过。
- `npm run lint`：通过。
- `npm test -- --fileParallelism=false`：28 个文件、**261/261 通过，0 跳过**，含新增 16 项和既有 245 项。
- 既有真实 ComfyUI 0.41.0 的 **6 项 e2e 本轮全部重跑通过**：单运行/拒绝 2 项、批量 1 项、恢复与工作流版本保护 1 项、独立 Node 子进程强制终止后的成功/中断恢复 2 项。后两项实际输出的 POST 总数均为 1，分别收敛为 succeeded/succeeded/completed 与 timeout/timeout/failed。
- 本轮新增旧库升级回归使用真实 SQLite、真实 Engine/Runner/Store 和模拟 ComfyUI 客户端；没有将这些夹具结果称为真实 ComfyUI 旧库升级实验。未重跑 smoke 脚本，未扩大到其他 ComfyUI 版本或 P4.2。

提交前逐文件审查本次全部变更与隐私信息；运行数据库、图片与本机路径不纳入提交。数据文件升级后不应再交给只支持 v4 的旧程序写入；回退使用升级前备份。完成本修复后停止，等待复审。
