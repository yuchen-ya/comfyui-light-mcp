# Task007：批量结果交付

2026-11-09，交付后等待验收。本次不推送、不合并主线、不发布，也不继续完整对照或 GPU 生成。

开发分支为 `codex/task007-batch-result-delivery`，实际起始 HEAD 为 `6ca3b2acffbdbcbdf135026b5d5e3729dfccfbe8`。该提交是 Task006 评测证据快照；其中产品代码已包含 R2 修复 `80fde2807e248d2ea4cc953d8e6e2d69fc704b79`。本次未改数据库 schema、默认 1/1 窗口、参数白名单、生成重试或工作流版本保护。

## 接口与兼容性

仍为四个 MCP 工具。唯一批次结果入口是：

```json
{"batch_id":"<existing batch>","mode":"index"}
```

传给 `get_result`，默认按需下载已成功任务的缺失输出。`download=false` 仅检查和索引已有文件。工具响应是完整 JSON 对象，包含 `batch_id/status/complete/total/succeeded/failed/invalid/unresolved/unavailable_outputs/index_path/updated_at`，没有逐项输出、参数、prompt、工作流、history、日志或 Base64；不使用字符串截断。常规路径下响应低于 2 KiB，100 Job 的摘要响应有回归断言；这不是对任意配置路径长度的硬上限承诺。

`index_path` 指向受控 `OUTPUT_DIR/<batch_id>/results.jsonl`。每个 Job 一行，按原始 index 排列，包括 label、原始状态、实际 seed、全部 outputs、精简 error。每个输出保留原始文件名、媒体类别 `kind`、实际字节数、可用的绝对 `local_path` 和 availability。缺失或失败输出的路径和字节数为 null，availability 区分 `not_downloaded/download_failed/unsafe_path`。失败项和非法项保留记录。

`seed` 来自已保存的 resolved 参数；有多个或非标准名称的 seed 参数时，匹配 batch 内容指纹的已注册 manifest 用于识别参数名，并额外提供 `seeds` 映射。历史 manifest 不可确认时仅提取已保存的常规 `seed` 字段，不猜测自定义字段；其他历史复现参数仍可由单项接口读取。

`complete` 仅表示执行已全部终结；`failed/timeout` 若仍满足既有安全重试条件，则仍计入 unresolved。`submission_unknown/paused` 也计入 unresolved，不能冒充 failed。`failed` 统计 failed/timeout/cancelled 的终态，invalid 单列，所以 `total = succeeded + failed + invalid + unresolved`。`complete=true` 时仍可能有下载失败，需另查 `unavailable_outputs`。

省略 mode 保持旧的 index=0 单项接口，保留 resolved 参数、错误和 outputs 形状，未知 batch/index 仍是 NOT_FOUND。单项下载失败仍报错；批次模式把各输出的下载失败写进索引，允许收集其他项。单项与批次复用同一个收集过程，成功下载逐文件持久化。

同一 Engine 内，同批次同偏好的并发索引请求合并，不同 download 偏好顺序执行。索引和输出文件都通过同目录临时文件加 rename 发布，失败清理临时文件。索引内容未变时不重写，updated_at 使用索引文件 mtime。文件引用从该 Job 的完整输出列表分配目标路径，保留重名输出；检查文件实际存在、真实路径和目录 junction，拒绝越界、Windows 设备名和文件名末尾点/空格。没有新增 save_dir、任意 URL 或文件读取入口。

运行中按 Job 取得状态和结果引用的一致快照；收集期间刚完成的任务可能在下一次请求才体现。共享索引路径表示最新已发布快照，不是不可变历史版本。获取索引不会启动调度器、访问 history、增加 Attempt 或 POST /prompt。

## 验证

执行 `npm run typecheck`、`npm run lint`、`npm test` 和 `npm run build`。全部通过：275 项测试通过，6 项真实 ComfyUI/GPU 集成测试按原有开关跳过。

新增 13 项结果交付测试，覆盖 100 Job 的 index/label/seed 对应和每项多个同名输出、中文与空格文件名、混合状态、未用尽重试、单项和批次并发、不同 download 偏好、manifest 自定义 seed、收集期间终态更新、不覆盖 tracker 的新引用、下载失败后的局部重试、删除文件后重新取回、索引替换失败保留旧快照、真实 rename 失败后的临时文件清理、路径越界/junction，以及四工具与单项错误兼容。另增加 5 个 Windows 文件名安全用例。全部测试的后端为离线替身，新增结果测试逐项核对 POST=0 和 Attempt 不增长；不能把它们称为真实 GPU 回归。

真实已有数据使用 Task006 `daily-v2-fast` 的 A1 轻量组 20 Job。只复制原数据库及 WAL，再从副本建立两份独立数据库和本地图片副本，未修改原始评测材料。两组均取回 20 项、20 个实际存在的本地文件；副本 Attempt 均从 20 保持 20。回放拒绝全部后端操作且记录为 0；没有启动 ComfyUI，也没有生成新图片。

## 局部 Agent 使用记录

两个全新、无父对话上下文的 `gpt-6.1-terra` / `high` Agent，执行同一中性任务：“取回全部结果，确认结果数量，给出本地索引。”均可用相同的通用文件和脚本工具。旧组暴露 `6ca3b2a` 的 MCP schema/instructions，新组暴露本次索引接口；两组底层均使用兼容的当前 Engine，不能称为两个产品二进制的端到端对照。

两个 Agent 使用独立副本，通过相同的 HTTP→SDK 内存 MCP 桥调用。initialize/tools/list 由桥各预取一次，GET contract/tools 不计入 tools/call；Agent 的全部宿主操作（包括读取索引、检查文件和向组织者报送结果）计入宿主 usage。原始工具正文和宿主会话保留在私有运行目录，仅发布白名单数字：[task007-agent-usage.json](task007-agent-usage.json)。

| 指标 | 旧单项路径 | 新批次索引 |
|---|---:|---:|
| MCP tools/call | 21（get_batch 1 + get_result 20） | 1（get_result mode=index） |
| 宿主模型请求记录 | 5 | 6 |
| 累计 input | 124,348 | 146,751 |
| 累计 cached input | 110,848 | 141,440 |
| 累计 uncached input | 13,500 | 5,311 |
| 累计 output | 1,033 | 1,017 |
| 峰值单请求 input | 26,554 | 25,520 |
| 峰值单请求 cached input | 26,368 | 25,344 |
| 峰值单请求 uncached input | 8,773 | 2,594 |
| 峰值单请求 output | 504 | 226 |
| 后端访问 / POST prompt | 0 / 0 | 0 / 0 |

宿主 token_count 的逐请求加总与累计值一致，cached 是 input 的子集，各字段峰值可能来自不同请求。两组只有一对样本，并行启动，可能共享宿主前缀缓存。新组减少 MCP 调用，但宿主请求数和累计 input 更高；本次结果不支持断言 token 或费用降低，更不能外推整条生成流程、执行速度或画质收益。

复用脚本：

```powershell
npx tsx scripts/task007-result-delivery.ts prepare <source-db> <private-directory>
npx tsx scripts/task007-result-delivery.ts serve <private-directory>
# 按打印的 loopback 端口，在两个独立 Agent 中使用 /old 或 /new 的 contract/tools/call。
# 完成后 POST /stop 保存调用汇总并关闭桥。
npx tsx scripts/task007-result-delivery.ts verify <private-directory>
node scripts/task007-collect-usage.mjs <session-directory> <parent-chat-id> <private-directory> <public-summary.json>
```

prepare 只用于复制指定已有评测批次；serve 不开放生成调用。私有目录应位于 `.analysis`，不提交图片、数据库、原始 MCP 正文、宿主会话、绝对运行路径或账号信息。

## 待验收与后续范围

P0 完成。P1 execution_ms 未纳入本次，没有用提交到完成的本地时差代替远端执行时间。安装、打包、文档完善与预发布待本次验收通过后处理；包版本与运行时版本统一、npm 发布白名单仍是发布检查事项。本次不开展额外 GPU 回归或完整评测。
