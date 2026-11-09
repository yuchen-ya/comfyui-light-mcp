# 006 · Task005R：P4.1 双分支整合返修交付报告

日期：2026-11-09。分支：`codex/task005r-integration`，基于 `4.1new / 7d73c53`；参考 `4.1 / a1b037f` 的连接门控与 attempt 同步方案，未整分支合并，未修改 main。保留 canonical 指纹、paused、四个核心工具及默认 1/1 窗口。不进入 P4.2，交付后等待复审。

本文替代原 4.1new 报告的验收结论。原报告的 222/222 和 11/11 冒烟属于前次交付；本轮独立执行结果见下文，不沿用其“NULL 指纹放行”“取消 RPC 即超时终态”“手动恢复代表启动恢复”的结论。

## 修复与证据

以下名称可在 `tests/unit/task005r.test.ts`、`tests/unit/task005r-upgrade.test.ts`、`tests/http-mock/comfy-http.test.ts` 和 `tests/integration/real-process-crash.e2e.test.ts` 中定位。

| 项目 / 测试名 | 故障注入点 | POST /prompt | 最终状态 / 断言 |
|---|---|---:|---|
| R1 · `offline startup gates pending; delayed connection automatically reconciles all in-flight states without POST` | 预置 pending、queued、executing、unknown；离线启动 Engine 后改变真实装配的连接状态；测试不调用 recover | 0 | pending 保留；history 成功任务 job/attempt=succeeded；queued 自动挂接；unknown 占额且不重提；后续重连自动收敛 |
| R1 · `rechecks connection before every submission in a 2/2 window` | 第一次 POST 返回时断线 | 1 | 第二个 job=pending，无离线 claim/POST |
| R1 · `a disconnect/reconnect during submission requires reconciliation before the next POST` | 首次提交中连接 epoch 改变，即使 WS 再次 open | 首拍 1，总计 2 | 第二次提交前先恢复第一个任务；禁止跨重连跳过对账 |
| R1 · `query failures preserve uncertainty and distinguish failures from successful misses` | history / queue 分别抛错，反复 tick | 0 | 保留在途状态；RECONCILIATION_FAILED，不伪造“两处均无”；同一时间段不随 tick 频率无限查询 |
| R1 · `unknown later found executing then completed converges automatically without another POST` | 已接受但提交响应丢失，稍后 queue/history 出现 | 1 | unknown 自动挂接；使用原始 deadline，完成后 job/attempt=succeeded，batch=completed |
| R2 · `real 0.41 interruption history cancels without retry; partial outputs alone prove nothing` | 不发 WS；history 写 error + execution_interrupted | 1 | job/attempt=cancelled，batch=failed；max_attempts=2 也不重试；部分 outputs 不足以证明成功 |
| R2 · `persisted timeout intent and original deadline survive tracker recreation` | 本地超时后取消响应丢失，重建 Engine，再出现中断 history | 2（确认中断后才允许第二次） | attempt 1=timeout；保留原始 deadline / 取消意图；新 attempt 使用新 prompt_id |
| R3 · `timeout with ... remains in flight until remote terminal evidence`（3 项） | 两个取消 RPC 均失败、响应丢失，或均返回 HTTP 200；max_attempts=2，反复 tick | 始终 1 | 未确认时 job/attempt=submission_unknown，batch=running，在途额度=1；后来 history 成功则 job/attempt=succeeded，batch=completed |
| R3 · `success with temporarily absent or failed history queries retries collection, never generation` | 已收 success，history 先抛错、后空、再完成 | 1 | 不发超时取消，不把结果查询失败变成生成重试；最终 succeeded/completed |
| R3 · `submitPrompt 5xx is uncertain rather than a confirmed rejection eligible for retry` | /prompt 返回 HTTP 502 | 1 次请求 | HTTP 客户端抛不确定结果错误；Runner 按 unknown 保留；只有明确 HTTP 400 拒绝可作为提交失败证据 |
| R4/R5 · `%s preserves history and pauses pending without fabricating a snapshot`（v2 / 4.1 / 4.1new） | 真正旧 schema 文件预置 pending，停机期间修改图，再升级 | 0 | pending=paused/LEGACY_SNAPSHOT_MISSING；不回填当前图；历史 completed/succeeded 可查询；旧 key=LEGACY_IDEMPOTENCY_CONFLICT |
| R5 · `DDL and user_version roll back together when a migration fails` | 旧库列冲突导致中途 DDL 失败 | 0 | DDL 与 user_version 一起回滚，旧版号及已有数据保留 |
| R3/R5 · `legacy unconfirmed timeout in a running batch keeps its slot and cannot become retryable` | v3 运行中 batch 遗留 timeout，尚无远端确认 | 0 | 转 unknown，占额=1，无重试候选；已结束历史 batch 保持只读状态 |
| 组合窗口 · `2/2 window holds later work until the retry's remote outcome is final` | 2/2 窗口首个任务失败；重试 queued 后另一个任务完成，释放空位 | 重试未决时 3，确认成功后 4 | 后续任务持续 pending 到重试定局；旧 attempt 的迟到中断不污染新 attempt |
| seed · `explicit and default random seeds share bounds; resolved values satisfy those bounds` | seed 的 min=10/max=20，显式 -1、-2、21 | 1 | -1 合法并在范围内随机；非法显式值拒绝；加载/运行共用 isValidSeed，随机共用 seedBounds；seed 不应用 step |
| 异步 · `concurrent recovery/late history shares one download; graceful stop drains it before reopening` | 下载挂起时并发 recover、success、stop | 1 | 只下载一次；await stop 后 job/attempt=succeeded；重新打开不再下载、不出现过期回写 |
| 下载 · `download failure retains references, and get_result retries only download` | 第一次输出下载失败 | 1 | job/attempt 仍 succeeded，保存输出引用；get_result 只重试下载，不生成新 prompt |

首次在修复前执行核心 8 项回归：7 项失败（1 项当时的弱断言未揭露缺陷）。修复后加强持久化断言，并补迁移、组合窗口、下载与连接 epoch 场景。旧测试中与本轮契约冲突的断言已更新，不再把未知取消当作 timeout，也不再把 NULL 指纹视为安全放行。

## 实现约束

- Engine 的周期调度在首次连通、延迟首连和重连时先串行恢复；每次提交还检查 WS 状态及已对账的连接 epoch。unknown 由恢复扫描与 3 秒 Tracker 轮询持续查证，所有来源共用单个异步结算入口。查询错误保留未知性。
- history 按 `status.messages` 的 execution_interrupted / execution_error 分类，再处理明确的成功状态；不从部分输出推断成功。WS 用户中断为 cancelled；有当前 attempt 的持久化超时取消意图时，中断为 timeout。
- claim 事务在 POST 前写入 prompt_id、attempt 与 deadline_at；取消前事务写 cancel_requested_at；success_observed_at 跨崩溃保留结果收集意图。恢复不会重置完整超时周期。终态通过 settleAttempt 事务同步 job、attempt、batch，并检查 attempt_no/prompt_id，拒绝迟到写回。
- `retryEligibility` 同时决定重试候选、batch 收敛和 continue_on_error 级联：仅远端已确认终止且次数未用尽的 failed/timeout 可重试。下载失败与结果查询失败不产生生成重试。
- `Engine.stop()` 现在必须 await 后才关闭 DB；它停止新提交并等待正在收集的输出完成。强制进程终止依靠已持久化的状态恢复。

## 数据库升级与隔离

选定长列名 canonical schema，升级到 **user_version=4**；迁移中的 DDL、数据更新与版本号在同一 SQLite 事务内。

v2 缺快照的 pending 暂停。4.1 的 manifest_fp/graph_fp/request_fp 保留原值供审计，新增长列保持 NULL，绝不把 raw-text hash 改名成 canonical hash。4.1new 已有 canonical 指纹保留。运行中旧 timeout/failed 没有远端确认时保守转 unknown；历史已经结束的 batch 保持可查询。旧请求缺指纹返回显式 legacy 冲突，不承诺请求相等。

评测、回退与切换实验分支须使用**独立 DATA_DIR**。升级前保留原数据库备份；不要删除数据库“修复”列错误，也不要让旧分支继续写已经升级的同一份数据。需要回退时使用对应分支的原始备份/独立目录。

## 真实 ComfyUI 与进程级证据

本轮实际连接到 ComfyUI **0.41.0**，未启动或修改 ComfyUI，未安装节点。使用既有示例工作流执行 GPU 任务。

`real-process-crash.e2e.test.ts` 启动独立 Node 子进程。子进程完成真实 POST，并在 cancel_requested_at 落库后、首个取消 RPC 发出前挂起；父进程以 SIGKILL（Windows 为 TerminateProcess）强制结束它，重新打开磁盘 SQLite，由 Engine.start 自动恢复，不由测试调用 recover。

| 场景 | 真实记录 | POST 次数 | job / attempt / batch |
|---|---|---:|---|
| 杀进程后远端继续完成 | history.status_str=success | 1 | succeeded / succeeded / completed |
| 杀进程后对该任务发送定向 interrupt | history.status_str=error，messages 包含 execution_interrupted | 1 | timeout / timeout / failed（本场景 max_attempts=1） |

上表属于本轮现场响应断言。`historyEntry(..., "interrupted")` 和单元测试中的 JSON 则是**按上游结构构造的模拟夹具**，不是抓取记录。上游依据：[v0.41.0/main.py](https://github.com/Comfy-Org/ComfyUI/blob/v0.41.0/main.py)、[v0.41.0/execution.py](https://github.com/Comfy-Org/ComfyUI/blob/v0.41.0/execution.py)。

## 必要检查与边界

- `npm run build`：通过。
- `npm run lint`：通过。
- `npm test -- --fileParallelism=false`：**245/245 通过**（27 个测试文件，离线 239 + 真实 ComfyUI e2e 6），零跳过。
- 原单运行、10 任务批量、工作流漂移/还原恢复的 4 项真实 e2e，以及新增 2 项进程强制终止真实 e2e，均已独立执行通过。前者的 stop/重建对象测试与后者的强制进程终止测试分别记录。
- 本轮未重跑原 11 项 smoke 脚本；不据前次报告宣称本轮 smoke 通过。未测试其他 ComfyUI 版本、远端历史清空或长时间断网压力。
- 队列删除本身可能不产生终态 history。只有 HTTP 200 或“两处无记录”仍不足以确认旧任务已终止；这种情况继续 unknown/占额并查证，需要检查远端记录，不能靠新 key 绕过。此为保守安全边界，无新增工具。

本次变更在提交前逐文件检查代码、测试与文档及隐私信息；不提交运行数据库、实际输出、本机私有路径、密钥或令牌。交付后停止，等待复审。
