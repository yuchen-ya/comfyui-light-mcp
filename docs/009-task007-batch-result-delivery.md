# 批量结果交付设计

## 接口与兼容性

仍为四个 MCP 工具。唯一批次结果入口是：

```json
{"batch_id":"<existing batch>","mode":"index"}
```

传给 `get_result`，默认按需下载已成功任务的缺失输出。`download=false` 仅检查和索引已有文件。工具响应是完整 JSON 对象，包含 `batch_id/status/complete/total/succeeded/failed/invalid/unresolved/unavailable_outputs/index_path/updated_at`，没有逐项输出、参数、prompt、工作流、history、日志或 Base64；不使用字符串截断。摘要大小受路径和错误信息长度影响，不承诺对任意配置的固定字节上限。

`index_path` 指向受控 `OUTPUT_DIR/<batch_id>/results.jsonl`。每个 Job 一行，按原始 index 排列，包括 label、原始状态、实际 seed、全部 outputs、精简 error。每个输出保留原始文件名、媒体类别 `kind`、实际字节数、可用的绝对 `local_path` 和 availability。缺失或失败输出的路径和字节数为 null，availability 区分 `not_downloaded/download_failed/unsafe_path`。失败项和非法项保留记录。

`seed` 来自已保存的 resolved 参数；有多个或非标准名称的 seed 参数时，匹配 batch 内容指纹的已注册 manifest 用于识别参数名，并额外提供 `seeds` 映射。历史 manifest 不可确认时仅提取已保存的常规 `seed` 字段，不猜测自定义字段；其他历史复现参数仍可由单项接口读取。

`complete` 仅表示执行已全部终结；`failed/timeout` 若仍满足既有安全重试条件，则仍计入 unresolved。`submission_unknown/paused` 也计入 unresolved，不能冒充 failed。`failed` 统计 failed/timeout/cancelled 的终态，invalid 单列，所以 `total = succeeded + failed + invalid + unresolved`。`complete=true` 时仍可能有下载失败，需另查 `unavailable_outputs`。

省略 mode 保持旧的 index=0 单项接口，保留 resolved 参数、错误和 outputs 形状，未知 batch/index 仍是 NOT_FOUND。单项下载失败仍报错；批次模式把各输出的下载失败写进索引，允许收集其他项。单项与批次复用同一个收集过程，成功下载逐文件持久化。

同一 Engine 内，同批次同偏好的并发索引请求合并，不同 download 偏好顺序执行。索引和输出文件都通过同目录临时文件加 rename 发布，失败清理临时文件。索引内容未变时不重写，updated_at 使用索引文件 mtime。文件引用从该 Job 的完整输出列表分配目标路径，保留重名输出；检查文件实际存在、真实路径和目录 junction，拒绝越界、Windows 设备名和文件名末尾点/空格。没有新增 save_dir、任意 URL 或文件读取入口。

运行中按 Job 取得状态和结果引用的一致快照；收集期间刚完成的任务可能在下一次请求才体现。共享索引路径表示最新已发布快照，不是不可变历史版本。获取索引不会启动调度器、访问 history、增加 Attempt 或 POST /prompt。
