/**
 * MCP instructions：握手时一次下发的 canonical flows（Context-light 策略 #1）。
 * 工具 description 保持短，教程只写在这里。
 */
export const INSTRUCTIONS = `ComfyUI 轻量代理：调用你已测试的 ComfyUI 工作流（workflow-first），批量原生（batch-native），输出有界（context-light）。

典型流程：
1. list_workflows() 查看已注册工作流（名称+一句话）；需要参数细节时传 workflow=<name> 获取完整参数表（类型/必填/默认/枚举/范围）。
2. run_workflow(workflow, params) 提交运行 → 立即返回 {batch_id, index, status}。
3. get_result(batch_id, index) 轮询结果：status 变为 succeeded 后 outputs 即本地绝对路径（默认已下载到本地输出目录，不含 base64）。生成耗时取决于工作流，间隔数秒轮询即可。
4. 参数只接受 manifest 白名单内的键；未知键/类型错误/超范围会在提交前被拒绝并给出期望值——按错误信息修正后重试。

注意：
- seed 参数传 -1 表示每次随机；实际使用值记录在结果的 params_resolved 中（可复现）。
- status=submission_unknown 表示提交后结果未知（如网络中断）：系统不会自动重提以免重复生成，需要重跑请再次 run_workflow。
- 输出文件保留 ComfyUI 原始文件名，按 <输出目录>/<batch_id>/<index>/ 组织。`;
