# Task010：Workflow Preflight & Hot Reload

日期：2026-11-09
分支：`codex/task010-workflow-preflight-hot-reload`
开发基线：`72fdad198c88d47be911bec5d4054891aacbc325`（`main` / `origin/main`）

> 状态：离线实现与回归已完成；真实 ComfyUI 0.41.0 验收因本机服务不可达而未执行。本文不把离线替身结果表述为真实环境通过。未进入 Task009，未合并主线，未发布 npm，未创建 GitHub Release。

## 1. 基线与技术实现

开发前确认：

- P4.1 R2 的双指纹快照、提交前漂移暂停、恢复对账、安全重试已整合。
- Task007 结果索引已在 `1b22f02` 合入；`get_result(mode="index")` 与 JSONL 格式未改变。
- MCP 工具仍为四个：`list_workflows`、`run_workflow`、`get_batch`、`get_result`。
- Manifest Parser、Parameter Validator、Parameter Mapper、Workflow Registry 均复用现有实现。
- SQLite Batch / Job / Attempt 状态机、默认 `MAX_IN_FLIGHT=1` / `MAX_QUEUED_JOBS=1`、幂等与恢复语义未改。
- 基线检查：294 个离线测试通过，6 个真实 e2e 因服务不可达跳过；typecheck/lint/build 通过。

新增模块：

| 模块 | 职责 |
|---|---|
| `src/core/workflow/loader.ts` | API JSON 解析、UI 格式拒收、节点 ID/重复键/节点结构错误定位 |
| `src/core/workflow/registry.ts` | 调用时文件元数据指纹、稳定配对读取、原子替换、ready/invalid/deleted 状态 |
| `src/core/workflow/object-info.ts` | `/object_info` 兼容规范化、TTL/epoch 缓存、live/cache/stale/unavailable 来源 |
| `src/core/workflow/preflight.ts` | 纯图结构、schema、连线、combo、模型、manifest 交叉检查 |
| `src/core/workflow/dry-run.ts` | 复用参数校验与映射，逐 run 预检、统计与有界错误汇总 |
| `src/core/engine.ts` | 四工具门面中的热加载与 dry-run 编排；不经过 BatchManager/Scheduler |

Dry-run 计算函数不接收 DB、Scheduler 或提交客户端。它只接收已注册工作流、runs 和 object_info 快照，从结构上避免创建任务或提交 Prompt。

## 2. MCP Schema 变更

工具数量保持 **4**。没有 `validate_workflow` 工具。

### `run_workflow`

新增：

```json
{
  "dry_run": false
}
```

- 类型：boolean；默认 `false`。
- `dry_run=false`：沿用原单任务/批量提交行为。
- `dry_run=true`：支持原 `params` 或 `runs` 两种形式，返回 `submission="not_submitted"`。
- 不读取或写入幂等键，不创建 Batch，不推进调度。

单任务：

```json
{
  "workflow": "qwen-image",
  "dry_run": true,
  "params": { "prompt": "A cinematic city", "seed": 12345 }
}
```

批量：

```json
{
  "workflow": "qwen-image",
  "dry_run": true,
  "runs": [
    { "label": "test-001", "params": { "prompt": "A red sphere", "seed": 100 } },
    { "label": "test-002", "params": { "prompt": "A blue sphere", "seed": 200 } }
  ]
}
```

### 返回约定

- `runs.total/valid/invalid` 为完整统计；`invalid_runs` 给出每项索引与错误数。
- `checks.*` 为 `passed | failed | unknown`。
- `valid=true` 表示未发现阻断错误；若存在不可确认项，对应 checks 仍为 `unknown`，调用方必须同时查看 warnings。
- `workflow_fingerprint` 是 manifest/graph 双指纹的 canonical SHA-256；Batch 内原双指纹存储格式不变。
- `validation_sources.node_schema` 标记 `live | cache | stale | unavailable | not_queried`、获取时间和连接 epoch。
- `models` 只返回 found/missing/unknown 计数；缺失错误只含被引用名称、节点和输入，不含可用模型清单。
- 最多返回 30 条 errors、10 条 warnings；`errors_truncated`、`warnings_truncated`、`details_truncated` 明示截断。MCP 文本仍有原 20,000 字符上限。
- 不返回完整 workflow JSON、object_info、模型清单或 Base64。

### `list_workflows`

新增摘要字段：

- `status`: `ready | invalid | deleted`
- `version`
- `workflow_fingerprint`（12 位摘要；非 ready 为 null）
- `last_loaded_at`
- `error`（有界加载错误）
- 顶层 `load_errors` 与 `refresh`

指定工作流时，invalid 返回当前错误和 `last_valid_version`，但不提供旧版本执行入口。普通列表不返回完整 JSON 或节点定义。

## 3. Dry-run 检查覆盖矩阵

| 检查 | 实现与结果 | 主要离线覆盖 |
|---|---|---|
| 合法 API JSON | 通过注册与 schema 检查 | `registry.test.ts`、`preflight.test.ts` |
| 非法 JSON | `INVALID_JSON`，node/schema/模型为 unknown | `workflow-hot-reload.test.ts`、`dry-run.test.ts` |
| UI 格式 | `UI_FORMAT_REJECTED`，不当作 API 接受 | `registry.test.ts`、`dry-run.test.ts` |
| 非法/重复节点 ID | `INVALID_NODE_ID` / `DUPLICATE_NODE_ID` | loader 专项 |
| class_type / inputs | 缺失或形状错误定位 node_id | loader/preflight 专项 |
| 未知 class_type | `UNKNOWN_CLASS_TYPE` | preflight 专项 |
| 未知输入 | `UNKNOWN_INPUT`，含 node_id/input | preflight 专项 |
| required 缺失 | `MISSING_REQUIRED`，统一 error | preflight 专项 |
| 节点引用不存在 | `UNKNOWN_NODE_REF` | preflight 专项 |
| 非二元/非字符串节点连线 | `INVALID_LINK` | preflight 专项 |
| 负数/非整数 output index | `INVALID_OUTPUT_INDEX` | preflight 专项 |
| output index 越界 | `OUTPUT_INDEX_OUT_OF_RANGE`；无输出表时 unknown | preflight 专项 |
| 输入输出类型 | 精确类型、INT→FLOAT、通配类型保守检查 | preflight 专项 |
| 输出节点 | 全部 class 可确认时检查 `output_node=true` | preflight 专项 |
| combo 值 | `INVALID_COMBO_VALUE`；空清单为 `COMBO_UNVERIFIED` | preflight/dry-run 专项 |
| 数值 schema 范围/step | `VALUE_OUT_OF_RANGE` / `VALUE_STEP_MISMATCH` | preflight 专项 |
| Manifest target | 节点/input/连线目标交叉检查 | registry/preflight 专项 |
| Manifest 类型/default | 类型矩阵、enum、combo、数值范围 | manifest/preflight/dry-run 专项 |
| 参数白名单 | 复用 `validateParams`，未知键拒绝 | mapper/MCP/dry-run 专项 |
| 类型/min/max/step/enum | 复用正式执行同一 validator | mapper/dry-run 专项 |
| seed | 复用 `applyParams` 的 -1 随机与实际值语义，再检查映射后图 | mapper/dry-run 专项 |
| default/多次覆盖 | 每个 run 独立 clone + apply，检查最终实际图 | mapper/dry-run 专项 |
| 模型 found | combo 明确包含引用值 | preflight/dry-run 专项 |
| 模型 missing | combo 明确不包含引用值，定位节点与名称 | preflight/dry-run 专项 |
| 模型 unknown | 无清单、非 combo、schema 不可用或动态节点 | preflight/dry-run 专项 |
| 20 runs 部分错误 | 18 valid / 2 invalid，零任务创建 | `dry-run.test.ts` |
| 零 DB / 零 POST | 三表计数、submit/interrupt、调度器、输出目录、文件 hash | `dry-run.test.ts`、MCP 专项 |
| 已有 Batch 不变 | dry-run 前后状态、三表计数、调度器停止状态不变 | `dry-run.test.ts` |

可识别模型输入包括 checkpoint、LoRA、VAE、UNet、CLIP/多 CLIP、CLIP Vision、ControlNet、Upscale、Style Model、GLIGEN、Hypernetwork。仅对明确命名的输入做识别；动态或自定义运行时依赖不虚构验证成功。

## 4. object_info 兼容性处理

使用已有 `ComfyHttp.objectInfo()` 发起 **GET /object_info**，不提交 `/prompt`。

规范化支持：

- 0.41 常见 combo：`[[choices...], options]`
- 旧 combo：`[typeName, [choices...]]`
- `COMBO` + `options.choices` / `choices` / `combo.choices`
- options 直接为数组的形式
- 对象形式 `{type, options/choices}`
- `INT`、`FLOAT`、`STRING`、`BOOLEAN` 及自定义引用类型
- 输出类型数组、`output_node`、required/optional

缓存策略：

- 默认 TTL：300,000 ms。
- 同一连接的并发首次请求共享一个 Promise。
- WebSocket `reconnects` 作为连接 epoch；epoch 变化触发刷新。
- 旧连接上的在途请求返回后，如果 epoch 已变，不把它作为新连接的 live 结果。
- `live`：本次 GET 成功；`cache`：未过期且 epoch 一致；`stale`：刷新失败但有旧数据；`unavailable`：无可用数据。
- stale/unavailable 强制相关 checks 为 unknown，并返回 warning；绝不表述为实时 passed。
- 缓存只在内存，不写磁盘。

## 5. 热加载机制

触发点：`list_workflows`、`run_workflow`、dry-run；调度器周期也发起独立异步刷新。

1. 递归列出 `*.manifest.json`，对 manifest 和已知 graph 做 `size/mtime/ctime/ino` 元数据指纹。
2. 未变化：直接复用已注册对象，不重新读取或解析 JSON。
3. 变化：读取前后比较元数据；不稳定最多重试 3 次，每次间隔 20 ms。
4. manifest/graph 作为一对完整重读；只有两者读取后元数据仍一致才进行交叉验证。
5. 扫描后记录实际读取到的配对元数据；若扫描期间再次变化，则标记未确认，下次必须重读。
6. 全部验证结束后一次性替换当前 Map；无效对象不会进入可执行注册表。
7. 并发 refresh 共享同一 Promise；不同工作流在同一扫描中独立验证。

状态语义：

- `ready`：当前文件有效，可用于新执行。
- `invalid`：当前文件无效；新执行返回 `WORKFLOW_INVALID`，不会回退旧版本。
- `deleted`：manifest 删除或改名后的旧名 tombstone；不会作为可执行版本。
- 最后有效版本只保留作状态诊断和既有结果关联，不用于新执行。

调度 tick 的关键路径不等待真实文件 I/O，避免改变既有假时钟与恢复语义。后台刷新失败时，纯内存 `executionConfirmed()` 门控阻止本拍提交旧图。

兼容性说明：节点 ID 现在要求 1–64 位字母数字或 `_#-`，重复 JSON 节点键由“静默取最后值”改为明确拒绝。这是本任务要求的安全收紧。

## 6. 工作流版本保护

未修改 P4.1 的 Batch 快照格式、状态机或指纹比较规则：

- 新 Batch 保存当前 manifest version 与双指纹。
- 已提交 Job 继续使用已提交参数和 prompt_id，热加载不重写、不取消。
- 旧 Batch 的 pending Job 遇到指纹变化，仍暂停为 `WORKFLOW_VERSION_MISMATCH`。
- 当前文件 invalid 时，pending Job 暂停为 `WORKFLOW_INVALID`；`pauseBatchPendingJobs` 增加显式错误码参数，避免误报版本漂移。
- 恢复原指纹后，沿用原自动解除暂停逻辑。
- 新 Batch 使用新 fingerprint；不会用新图静默续跑旧 Batch。
- 幂等请求指纹仍包含工作流双指纹；热加载后同 key 不同版本按既有 `IDEMPOTENCY_CONFLICT` 处理。为保证不执行过期版本，幂等回放也会先确认当前文件有效。

离线测试覆盖：旧 Batch 剩余暂停、已提交任务不受影响、新 Batch 新指纹、invalid 错误码、删除/改名、并发 refresh、修复后重载。

## 7. 性能数据

测量环境：Windows x64、Node.js v22.22.0；本地临时目录与本地 HTTP fixture。**不是实际 ComfyUI 0.41.0 网络性能。**

| 项目 | 样本 | 结果 |
|---|---:|---:|
| 首次工作流加载 | 1 | 4.870 ms |
| 未变化 list/检查 | 50 | median 0.103 ms；p95 0.230 ms；max 0.630 ms |
| 文件变化后重载 | 1 | 1.637 ms |
| 首次 object_info + 单 run dry-run | 1 | 12.670 ms |
| 缓存命中单 run dry-run | 30 | median 0.386 ms；p95 1.058 ms；max 1.139 ms |
| 20 runs dry-run | 20 | median 2.298 ms；p95 3.216 ms；max 3.216 ms |

测量期间只发生一次 `GET /object_info`，Batch/Job/Attempt 均为 0。原始结果保存在 gitignored `.analysis/task010/performance.json`；可复现脚本为 `scripts/task010-preflight-performance.ts`。

未变化调用仍进行目录枚举和已知文件 stat，不重新扫描/解析所有 JSON。真实 ComfyUI 首次 object_info 获取耗时未测。

## 8. 离线测试结果

最终全量命令：

```text
npm test -- --fileParallelism=false
Test Files  30 passed | 4 skipped (34)
Tests       379 passed | 6 skipped (385)
```

```text
npm run typecheck  通过
npm run lint       通过
npm run build      通过
```

新增/扩展覆盖：

- `tests/unit/object-info.test.ts`：30 项。
- `tests/unit/preflight.test.ts`：36 项。
- `tests/unit/dry-run.test.ts`：8 项。
- `tests/unit/workflow-hot-reload.test.ts`：10 项。
- `tests/unit/mcp-tools.test.ts`：四工具约束、dry_run schema、单/批量 not_submitted、零 DB/POST。
- 既有 P4.1、恢复、幂等、调度、Task007 结果索引测试全部保留并通过。

真实 e2e 的 6 项跳过不是通过；原因是 `http://127.0.0.1:8188/system_stats` 连接失败。

## 9. 真实 ComfyUI 测试结果

**未执行。** 两轮探测默认端口均返回连接失败；常见安装目录和监听端口未发现可复用服务。没有启动未知安装、没有修改生产工作流/数据库、没有触发 GPU 生成。

提供隔离补验脚本：

```bash
# 默认仅真实 object_info + dry-run + 热加载；不生成
npx tsx scripts/task010-real-comfyui.ts

# 仅在明确批准一个 64x64 内置节点冒烟后执行
TASK010_APPROVE_GPU_SMOKE=1 npx tsx scripts/task010-real-comfyui.ts
```

脚本特征：

- 从 `examples/solid-color.*` 复制到新的临时目录，使用独立 SQLite 和输出目录。
- 获取真实 object_info，验证合法 dry-run、非法 combo、缺失模型、热加载、零 POST/零 DB 写入。
- 批准开关下只提交一个实际生成 Job；第二个 Job 用于验证旧 Batch 指纹暂停，不生成。
- 结束后清理临时目录，不读取或修改生产工作流/数据库。

真实脚本已做静态检查，但因服务不可达没有运行结果，不能标记为验收通过。

## 10. 未验证事项与边界

1. 真实 ComfyUI 0.41.0 的 object_info 全量形状、首次网络耗时、合法/非法 dry-run、缺失模型、零 POST、热加载、正式运行与旧 Batch 保护均待补验。
2. 未执行任何 GPU 生成；没有真实生成性能或输出质量结论。
3. 自定义动态节点、运行时注入输入、未暴露 combo/输出表的节点只能标 unknown/warning，不能保证运行时成功。
4. 连线类型兼容采用保守规则，不声称覆盖 ComfyUI 所有隐式转换。
5. 文件变化检测依赖文件系统元数据；同大小且时间戳/ino 被人为保留的极端写入不属于可证明检测范围。
6. 没有模型安装、节点安装、GUI、Redis、文件监控服务或自动修复能力。
7. 结果索引格式、默认并发窗口、Batch/Job 状态机、安全重试语义均未改变。
