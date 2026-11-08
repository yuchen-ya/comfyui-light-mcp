/**
 * MCP instructions：握手时一次下发的 canonical flows（Context-light 策略 #1）。
 * 工具 description 保持短，教程只写在这里。
 */
export const INSTRUCTIONS = `ComfyUI 轻量代理：调用你已测试的 ComfyUI 工作流（workflow-first），批量原生（batch-native），输出有界（context-light）。

典型流程：
1. list_workflows() 查看已注册工作流（名称+一句话）；需要参数细节时传 workflow=<name> 获取完整参数表（类型/必填/默认/枚举/范围）。
2. run_workflow 提交运行，立即返回 batch_id：
   - 单运行：run_workflow(workflow, params) → 用 get_result(batch_id, index) 轮询。
   - 批量：run_workflow(workflow, runs=[{label, params}, ...]) → 用 get_batch(batch_id) 轮询全貌（统计+分页任务列表）。
3. get_result 在 status=succeeded 后 outputs 即本地绝对路径（默认已下载；AUTO_SAVE_OUTPUTS=false 时查询时按需下载，无 base64）。生成耗时取决于工作流，间隔数秒轮询即可。
4. 参数只接受 manifest 白名单内的键；未知键/类型错误/超范围会被拒绝并给出期望值——按错误信息修正后重试。批量（runs）下单 run 参数错误记为 invalid job，不影响其余 run；单运行（params）简写则整体报错。

注意：
- seed 参数传 -1 表示每次随机；实际使用值记录在结果的 params_resolved 中（可复现）。
- status=submission_unknown 表示提交后结果未知（如网络中断）：系统不会自动重提以免重复生成，也持续占用并发窗口；需要重跑请用新的 run_workflow（或换 idempotency_key）。
- 批量默认串行执行（MAX_IN_FLIGHT=1）；失败默认不重试（max_attempts 默认 1），配 max_attempts>1 时重试会用全新 prompt_id 并保留全部 attempt 历史。
- idempotency_key 用于安全重试同一请求：同键重复调用只返回既有 batch，绝不产生重复生成。
- 输出文件保留 ComfyUI 原始文件名，按 <输出目录>/<batch_id>/<index>/ 组织。`;
