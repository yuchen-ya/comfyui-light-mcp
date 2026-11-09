/**
 * MCP instructions：握手时一次下发的 canonical flows（Context-light 策略 #1）。
 * 工具 description 保持短，教程只写在这里。
 */
export const INSTRUCTIONS = `ComfyUI 轻量代理：调用你已测试的 ComfyUI 工作流（workflow-first），批量原生（batch-native），输出有界（context-light）。

典型流程：
1. list_workflows() 查看工作流及 ready/invalid/deleted 状态；需要参数细节时传 workflow=<name> 获取完整参数表（类型/必填/默认/枚举/范围）。修改本地 workflow/manifest 后无需重启，下一次 list/run/dry-run 会检测并原子热加载；invalid 时必须修复文件，系统不会回退执行旧版本。
2. 正式提交前用 run_workflow(workflow, dry_run=true, params 或 runs) 预检。dry-run 复用同一套白名单、默认值、seed 与参数映射，检查图结构、节点 schema、combo 和可发现模型依赖；绝不创建 Batch/Job/Attempt、提交 Prompt 或触发执行。checks 中 unknown 不是 passed，须结合 warnings 判断；返回不含完整图、object_info 或模型清单。
3. run_workflow 提交运行（dry_run 默认 false），立即返回 batch_id：
   - 单运行：run_workflow(workflow, params) → 用 get_result(batch_id, index) 轮询。
   - 批量：run_workflow(workflow, runs=[{label, params}, ...]) → 用 get_batch(batch_id) 轮询全貌（统计+分页任务列表）。
4. get_result 在 status=succeeded 后 outputs 即本地绝对路径（默认已下载；AUTO_SAVE_OUTPUTS=false 时查询时按需下载，无 base64）。生成耗时取决于工作流，间隔数秒轮询即可。
   批量取回：get_result(batch_id, mode="index") 一次取得完整 JSONL 的 index_path（每个 job 一行，含所有输出、实际 seed 和简短错误）。运行中可取快照；complete=false 时仍有未决执行。complete=true 不代表文件全部可用，还须检查 unavailable_outputs；下载失败可重试同一入口，不会重新生成。download=false 只索引已有文件。需要复现详情时再用单项接口。
5. 参数只接受 manifest 白名单内的键；未知键/类型错误/超范围会被拒绝并给出期望值——按错误信息修正后重试。批量（runs）下单 run 参数错误记为 invalid job，不影响其余 run；单运行（params）简写则整体报错。

注意：
- seed 参数传 -1 表示每次随机；实际使用值记录在结果的 params_resolved 中（可复现）。
- 中断/失败状态语义：cancelled = 用户/外部中断；timeout = 本地超时且远端已确认中断（错误明细含取消结果）；failed = ComfyUI 执行失败；submission_unknown = 提交后结果未知（如网络中断），系统不会自动重提以免重复生成，也持续占用并发窗口，并每 3 秒重新查证。TIMEOUT_UNCONFIRMED 表示远端取消未确认；RESULT_PENDING 表示成功后等待结果。请等待对账或检查远端状态；未排除旧任务仍执行前不要换 key 或创建新 run。
- 旧数据库缺少历史工作流快照时暂停为 LEGACY_SNAPSHOT_MISSING，不会自动认领当前文件作为旧快照；旧 key 缺请求指纹时报 LEGACY_IDEMPOTENCY_CONFLICT，可用 batch_id 只读查询。
- status=paused 表示工作流文件在 batch 创建后被修改（WORKFLOW_VERSION_MISMATCH）：系统不会用新版本静默续跑旧 batch，剩余任务已暂停；把工作流内容还原后自动继续，或另建新 batch。
- 批量默认串行执行（MAX_IN_FLIGHT=1）；失败默认不重试（max_attempts 默认 1），配 max_attempts>1 时重试会用全新 prompt_id 并保留全部 attempt 历史。continue_on_error=false 时：只有远端已确认终止的失败才允许重试，重试执行中也等待其定局，终态失败才放弃剩余任务（在途任务不受影响，照常完成）。
- idempotency_key 用于安全重试同一请求：同键且请求内容完全一致才返回既有 batch，绝不产生重复生成；同键但内容不同会返回 IDEMPOTENCY_CONFLICT；先确认旧任务状态，再决定是否创建另一请求。
- 输出文件保留 ComfyUI 原始文件名，按 <输出目录>/<batch_id>/<index>/ 组织。`;
