# 003 · P1 真实环境验证报告

> Task 002 交付：ComfyUI HTTP/WS Client 在真实环境的行为验证。
> 验证时间：2026-11-08 · 结果：**11/11 通过，0 失败**（复现：`COMFYUI_OUTPUT_DIR=<output目录> npm run smoke`）

## 环境基线

| 项 | 值 |
|---|---|
| ComfyUI | **0.41.0**（`/system_stats` 实测） |
| 平台 | win32，RAM 66GB |
| Python | 3.10.19（miniconda 独立环境） |
| 测试图 | Qwen-Image 2.1 三件套：`qwen_image_2.1_int8_convrot`（UNETLoader）+ `qwen3vl_8b_w4a8`（CLIPLoader, type=qwen_image）+ `qwen_image_2.1_vae_bf16`（VAELoader）；512×512 / 4 步（小图）与 1024×1024 / 40 步（中断测试用长任务） |
| 冒烟脚本 | `scripts/smoke-real-comfyui.ts`（S0–S8 共 11 项检查） |

## 验证矩阵

| # | 验证点 | 结果 | 关键证据 |
|---|---|---|---|
| S0 | 健康检查/版本 | ✅ | `comfyui_version=0.41.0` |
| S0b | WS 连接（clientId 关联） | ✅ | `ws://…/ws?clientId=<uuid>` open，status 事件回显同 sid |
| S1 | /prompt 拒绝路径 | ✅ | HTTP 400，`error.type="missing_node_type"` + `extra_info{node_id,class_type,node_title}`，**`node_errors` 为空对象** |
| S2 | /object_info 构图 | ✅ | **combo 规格已变**（见协议事实 F8） |
| S3 | 成功提交 + 事件关联 | ✅ | 1 张图片输出；31 条事件全按 prompt_id 命中 |
| S3b | WS 事件字段形状 | ✅ | 事件链：execution_start → execution_cached → progress_state/progress → executing → executed → execution_success |
| S4 | 客户端指定 prompt_id | ✅ | 指定 id **被接受并回显**；同 id 重复提交 **均被接受且重复执行**（见 F2） |
| S5 | /interrupt 按 id 语义 | ✅ | 排队中的 B：从队列移除、无 interrupted 事件、**不误伤执行中的 A**；执行中的 A：收到 execution_interrupted |
| S6 | /history 输出结构 | ✅ | `outputs{nodeId:{images:[{filename,subfolder,type,metadata}]}}`（metadata 为 0.41 新增字段） |
| S7 | WS 断线后 history 恢复 | ✅ | WS 停止后仅靠 `GET /history/{id}` 判定"完成且有输出" |
| S8 | /view 与本地文件一致 | ✅ | 下载 113031 bytes，sha256 与 ComfyUI `output/<subfolder>/<filename>` **完全一致** |

## 协议事实（0.41.0 实测，全部有 WS/HTTP 原始证据）

**F1 · prompt_id 位于事件 `data` 内**：消息形如 `{"type":"executing","data":{"node":"1","display_node":"1","prompt_id":"…"}}`，顶层无 prompt_id。→ 已修复 event-bus 路由（`promptIdOf()` 双位置兼容旧版顶层形态，附回归测试）。

**F2 · 客户端指定 prompt_id：可用但无执行级去重**：POST body 带 `prompt_id` 被接受且响应回显同 id；但**同 id 提交两次 = 执行两次**（WS 捕获 2×execution_start + 2×execution_success），`/history` 以 prompt_id 为键，后一次覆盖前一次掩盖了重复。→ 幂等结论：**禁止任何形式的盲目重提**；`submission_unknown` 状态的"查 /queue+/history，查不到即终态 failed 不重提"策略（002 文档已确认）被验证为必要且正确。

**F3 · 事件定向 vs 广播**：执行链事件（execution_start/executing/executed/progress/progress_state/execution_error/**execution_success**）定向发送给**提交该 prompt 的 client_id 对应 socket**；`status`、`execution_interrupted`（含 prompt_id/node_id/executed）及自定义节点事件（本机实测 `crystools.monitor`，83 条）为广播。→ 客户端必须用与提交一致的 clientId 连 WS（已实现）；自定义节点广播事件必须忽略（translateJobEvent 返回 null，已实现）。

**F4 · 事件名录漂移**：0.41 新增 `progress_state`（`{prompt_id, nodes:{id:{value,max,state,…}}}` 每 node 进度）；传统 `progress`（`{value,max,prompt_id,node}`）**仍并存**（KSampler 仍发）。`execution_success` 存在。`execution_cached` 存在（v1 忽略）。→ translateJobEvent 两者都映射为 progress（已实现+测试）。`executing` 的 `data.node=null` 完毕哨兵**本轮未捕获样本**（成功路径由 execution_success 终结），标注未验证，兼容逻辑保留。

**F5 · /interrupt 按 prompt_id（Task 003 A2 严格断言修正版）**：对**执行中**任务 = 触发 `execution_interrupted` 广播 + history error 终态 ✓；对**排队中**任务 = **no-op**（不移除、无事件、不报错、**不误伤正在执行的其他任务**——A 当时在执行却未受 interrupt(B) 影响，证明服务端确实按 prompt_id 判定且仅对执行中 id 生效）。**取消排队任务必须用 `POST /queue {delete:[prompt_id]}`（已验证有效）**。→ cancel 实现须组合两招：queued → queue delete；executing → interrupt。〔初版报告此处结论有误（被队列索引误读掩盖），已在 Task 003 中以严格断言+实测修正〕

**F6 · /history 完备性**：成功（outputs+status_str=success+completed）、失败（status_str=error，含 messages 数组完整事件回放）、中断（error 终态）均可仅凭 history 判定。→ 重启恢复与 WS 断线兜底以 history 为唯一事实源成立（S7 验证）。注意 history 为**键覆盖**字典，配合 F2 意味着 history 不能证明"只执行过一次"。

**F7 · /view 与本地 output 对应**：`GET /view?filename=&subfolder=&type=output` 返回的字节与本地 `output/<subfolder>/<filename>` sha256 一致。→ AUTO_SAVE 落盘与 get_result 本地路径策略（002 已确认）成立。

**F8 · /object_info combo 规格漂移**：旧版 `[类型名字符串, 值数组]` → 0.41 `[值数组, 配置对象{tooltip}]`（值在 `spec[0]`）。→ manifest 生成辅助与任何 combo 解析须双形状兼容（smoke 已实现 `comboValues()` 双形状）。

**F10 · /queue 元组布局漂移（Task 003 实测补录）**：旧版 `[序号, 批号, prompt_id, 图, ...]`（prompt_id 在 index 2）→ 0.41 `[序号, prompt_id, 图, ...]`（**prompt_id 在 index 1**）。初版冒烟因沿用 index 2 产生了两处误读（"interrupt 移除排队任务"实为 no-op，见 F5 修正）。→ 客户端已提供 `queueEntryPromptId()` 兼容两种布局。

**F9 · 提交校验错误的载体**：未知节点类 → 400 + `error` 字段结构化（type/message/details/extra_info），`node_errors` 为空。参数级错误（值不在 combo 等）预期走 `node_errors`，**本环境未捕获 node_errors 非空样本**（未验证，P2 manifest 校验会前置拦截大部分）。

## 对已交付代码的影响（本轮已落实）

1. `event-bus.ts`：`promptIdOf()` 双位置路由 + `progress_state` 翻译 + 自定义广播忽略（新增 6 个回归测试，全套 48/48 通过）。
2. `smoke-real-comfyui.ts`：Qwen 三件套动态发现（含 clip 维度匹配教训：4B=2560 维与 2.1 unet 的 4096 维不匹配）、S5 先确认 A 在执行再中断、S7 接受 error 终态判定。
3. **设计输入（P3 落实）**：恢复流程以 `/history` 存在性为终局证据；同 id 重提被明确禁止；cancel = interrupt(prompt_id)。

## 未验证项（诚实清单）

| 项 | 原因 | 计划 |
|---|---|---|
| `POST /queue {delete:[ids]}` | S5 中 B 已被 interrupt 移除，未走到该分支 | P4 取消功能实现时补验 |
| `executing.data.node=null` 完毕哨兵 | 成功路径由 execution_success 终结，未捕获 | 遇到即记录；兼容逻辑已在 |
| `node_errors` 非空结构 | 环境未触发参数级校验错误 | P2 用坏参数 combo 提交补验 |
| gifs/audio/video 输出形状 | 本环境近期历史只有 images | 首次视频工作流接入时抓样本 |
| `/free`、`/upload/image` | P1 未实现上传 | P4 Asset Manager 阶段验证 |

---
*证据文件：`.analysis/smoke-result.json`（含全部 WS 原始事件样本；gitignored）。ComfyUI 由用户授权本次代启动，验证后保持运行。*
