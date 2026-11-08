# 004 · Task 003 交付报告：状态恢复语义修正 + Workflow MVP（P2）

> 时间：2026-11-08 · 分支 main · 测试基线：**115/115 通过**（113 离线 + 2 真实 e2e）、冒烟 11/11、Inspector 全链路真实出图。
> 依据：docs/002（含 Task 003 A1 修订）、docs/003（含 F5/F10 修正）。

## Part A 落实情况

### A1 · submission_unknown 语义（已按批准语义实现并测试）

| 要求 | 实现 | 测试 |
|---|---|---|
| history/queue 双查无果 → 保持 submission_unknown | `recovery.ts:requeueOrUnknown` 保持原状态，仅补记 error 说明 | a1-lifecycle「双查无果」「恢复幂等」 |
| 不伪装 failed | 状态词表互斥；`store.recomputeBatchStatus` 将 unknown 计入未决 → batch 保持 running | 同上 + 断言 batch=running |
| 不自动重提 | 恢复流程零提交路径；测试断言 `submitCalls` 不增长 | 「恢复不产生任何提交」 |
| get_batch 区分 unknown/failed | 状态为独立词表值，序列化原样输出（get_batch 工具 P3 落地） | 状态断言 |
| 提交前持久化 prompt_id | `runner.ts` 固定顺序：生成 UUID → 落库(batch/job/attempt) → POST | 测试在 submitPrompt 回调内查库断言 |
| 崩溃恢复+重复提交测试 | 三分支恢复（history 成功/error、queue 在队、双查无果）+ 幂等重跑 | 5 个恢复测试全绿 |

恢复三分支实测：history 成功 → succeeded + 落盘（本地绝对路径+原始文件名）；queue 仍在 → 重新跟踪且不重提；双查无果 → 保持 unknown。

### A2 · 冒烟断言修复（并触发两处既有结论修正）

严格断言全部落地：S3 要求 execution_success + history success + ≥1 输出三者同时成立；S4 等待并计数同 id 实际执行 2 次；S5 前置断言+三段验证；fail>0 时进程非零退出。最终 **11/11**。

严格化过程暴露并修正了初版报告两处错误（已在 docs/003 更正）：

- **F5 修正**：`/interrupt{prompt_id}` 对排队任务是 **no-op**（不移除、不误伤；A 在执行未受 interrupt(B) 影响，证明按 id 判定）。取消排队任务须 `POST /queue {delete:[id]}`（已验证有效）。
- **F10 补录**：0.41 的 `/queue` 元组 prompt_id 在 **index 1**（旧版 index 2）——初版的"B 被移除"结论是索引误读。客户端已加 `queueEntryPromptId()` 双布局兼容。

## Part B · P2 实现清单

| 模块 | 文件 | 要点 |
|---|---|---|
| Workflow Loader | `src/core/workflow/loader.ts` | API 格式校验；UI 格式（nodes/links）拒绝并给修正指引 |
| Manifest Parser | `src/core/workflow/manifest.ts` | zod strict；string/number/integer/boolean/enum + required/default/min/max/step + seed 特殊语义；required↔default 互斥、enum 一致性等交叉规则 |
| Parameter Validator | `src/core/workflow/mapper.ts:buildValidator/validateParams` | 白名单校验；错误三段式（实际值/期望/合法清单） |
| Parameter Mapper | `mapper.ts:applyParams` | structuredClone 深拷贝定点覆写（模板零污染，有测试）；seed -1→随机并回写 resolved |
| Workflow Registry | `src/core/workflow/registry.ts` | 递归扫描；交叉校验（node/input 存在、连线输入不可作目标）；LoadReport 不抛异常；全局重名拒绝 |
| Job 存取 | `src/core/batch/store.ts` | batches/jobs/job_attempts；submission_unknown 入在途部分索引 |
| JobRunner | `src/core/batch/runner.ts` | 单 job 管线（P3 runs 数组循环复用，无独立单任务路径）；提交被拒→failed、网络失败→submission_unknown |
| JobTracker | `src/core/batch/tracker.ts` | WS 事件 + 3s history 轮询双通道；墙钟超时→interrupt；成功→收获+落盘 |
| Recovery | `src/core/batch/recovery.ts` | A1 三分支语义 |
| AssetManager | `src/core/assets/asset-manager.ts` + `path-jail.ts` | 保留 ComfyUI 原始文件名（重名加序号）；kind=image/video/audio/file 通用扩展（gifs→video）；OUTPUT_DIR/\<batch_id\>/\<index\>/ 布局；Windows 路径越狱全向量测试 |
| MCP 层 | `src/mcp/server.ts` + `instructions.ts` + 入口 `src/index.ts` | 仅此层依赖 SDK；stdio；3 工具；instructions 前置 |
| 示例工作流 | `workflows/examples/qwen-image.*` | 真实可跑（本机 Qwen-Image 2.1 三件套，7 参数含 seed/step 约束） |

**run_workflow 接口兼容性**：入参已是 `{workflow, params, label}`，P3 批量 = 外层循环 `submitSingle` + 双窗口调度（002 §4.3），不需要改动现有管线。输出契约（本地绝对路径/原始文件名/无 base64/视频类型扩展位）全部按批准设计实现。

## 测试结果

- **离线 113**：manifest 10 / loader 3 / mapper 15 / registry 8 / path-jail 18 / a1 生命周期 10 / MCP 内存传输 5 / 此前 P0-P1 模块 44
- **真实 e2e 2**（ComfyUI 0.41.0，本机）：list→run(4 步 512px)→轮询→succeeded→本地 png（>1KB、字节数一致、`qwen-image-demo_00005_.png` 原始命名、seed=20261108 回写）；**模板文件 sha256 前后零变化**；非法参数提交前被拒
- **冒烟 11/11**（A2 加固后）

## MCP Inspector 调用记录（真实 stdio 会话，完整日志 `.analysis/inspector-log.txt`）

1. `tools/list` → 3 工具 + schema 正常
2. `list_workflows{workflow:"qwen-image-demo"}` → 7 参数详情（含 seed 语义说明与 step 约束）
3. `run_workflow{params:{prompt:"an orange traffic cone…",steps:4,seed:42}}` → `{batch_id:"b381baee-…", index:0, status:"queued", next:"get_result(…)"}`
4. `get_result{batch_id:"b381baee-…"}` → `status:"succeeded"`，`outputs:[{kind:"image", filename:"qwen-image-demo_00002_.png", bytes:212518, local_path:<OUTPUT_DIR>/b381baee…/0/qwen-image-demo_00002_.png}]`，`params_resolved.seed=42`
5. `run_workflow{params:{steps:999, oops:1}}` → isError + 三段式自愈错误（`steps: 须在 [1,100] 区间（实际: 999）`、`oops: 未知参数。合法参数: …`）

## 真实生成结果路径（本机）

- e2e：`<OUTPUT_DIR>/…/0/qwen-image-demo_00005_.png`（seed=20261108，可复现）
- Inspector：`<OUTPUT_DIR>/b381baee-e68f-44f7-896a-affe2f9df347/0/qwen-image-demo_00002_.png`（212518 bytes，seed=42）

## P2 遗留问题（进入 P3 前需确认/处理）

1. **node_errors 非空样本仍未捕获**（0.41 未知节点走 error 字段）——P3 批量前用坏 combo 参数补验，确认 client 对两类拒绝的归一处理。
2. `executing.data.node=null` 完毕哨兵未捕获样本（execution_success 已覆盖成功路径判定）。
3. get_batch 工具与批量 runs、双窗口调度、失败隔离为 P3 范围（管线已就绪）。
4. 视频输出（gifs→video 映射）逻辑已实现但**未在真实视频工作流上验证**。
5. 上传（图片输入参数）P4；`/queue delete` 将作为取消排队的组成部分在 P4 cancel 中使用（语义已在冒烟验证）。
6. tracker 的 history 轮询间隔（3s）与 WS 双通道在批量场景下的行为需 P3 压测调优。

---
*本报告不含本机绝对路径/密钥/个人信息（AGENTS.md 隐私检查通过记录见提交信息）。ComfyUI 保持运行。*
