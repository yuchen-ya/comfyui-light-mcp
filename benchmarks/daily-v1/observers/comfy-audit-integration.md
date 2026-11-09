# ComfyUI 后端审计接入（隔离评测）

第一次隔离验证失败：无 `client_id` 的提交会记录 history，却不调用 `send_sync`，因此 v1 漏记开始和成功事件，保留证据见 `evidence/redacted/backend-audit-check.json`。v2 已改为观察 `PromptExecutor.add_message`，实际隔离实例以无 `client_id` 直接提交一次 `/api/prompt`，请求和响应字节一致、开始和成功事件各记录一次、PNG 参数正确；证据见 `evidence/redacted/backend-audit-check-v2.json`。两次各生成一张图；这是当时的验证记录。后续减量实测见 [v2 报告](../../daily-v2-fast/report.md)。

固定基线 ComfyUI SHA `5cc4b870094c89090db54bd8d12649dcaf89f2ba`；v2 模块 `comfy_audit.py` SHA256 `a91d4e77d59e791e49a4584c9ee1d8f014d1d69f8c91be842fbbf5a7b813b7e5`。正式评测前冻结并重新核对 SHA，A/B 使用同一干净独立 clone、相同模块和补丁；不修改生产实例。

## 未来隔离实例接入

只在隔离 clone 的 `server.py` 末尾追加以下内容（包含前导空行、UTF-8/LF）：

```python

import comfy_audit
comfy_audit.install(PromptServer, execution.PromptExecutor)
```

从上述基线 `server.py` 用 Python `difflib.unified_diff`（`fromfile='a/server.py'`、`tofile='b/server.py'`、`lineterm='\n'`）生成的 UTF-8 补丁 SHA256 为 `54672501d5bfcb54a47cd58c7be4ee593a2f8f608c90274cc490b48f4f0018b`；追加字节本身 SHA256 为 `ea2766c9f49a2350a5b72385fac88d09b79b6100db57bb20399c75241c48b082`。记录实际差异与哈希；若 checkout 自动转换换行，先与 git blob 比较并规范化，再应用补丁。任何未解释的不一致都应停止并重新冻结。

启动前以进程级 `PYTHONPATH` 将本目录加入模块搜索路径；将 `COMFY_BENCH_AUDIT_LOG` 设为已存在的 `.analysis` 子目录中的专用本地 JSONL 文件，按组和运行分别建新文件。实际路径及原始日志不得公开。

## 行为与边界

`PromptServer` 构造函数追加 aiohttp 中间件，覆盖 `/prompt` 与基线存在的 `/api/prompt`。对 POST 在原处理器前记录请求原始字节，处理器完成后记录原响应体与状态，随机 ID 关联；HTTP 异常与其他异常记录后仍原样抛出。线程之间写日志用锁。模块不提交、重试或整理任务。

模块包装 `PromptExecutor.add_message`：原方法执行后读取刚追加到 `status_messages` 的事件数据并记录，不修改原方法参数、返回值或列表。事件包括 execution_start/success/error/interrupted/cached，sid 为当时的 server.client_id；不再包装 `send_sync`，避免双重计数。无客户端 ID 的生命周期事件也可记录。记录证明该方法成功返回并写入状态列表，不单凭此证明客户端收到事件；如果原方法异常、进程中断或绕过这条方法路径，必须结合日志、历史和错误状态判断，不能宣称已全覆盖。

日志可能包含提示词、路径和敏感数据，只保存在 `.analysis`，未经人工脱敏审查不得提交。出现 `COMFY_BENCH_AUDIT_FAILURE`、日志写入/序列化失败、请求响应缺对、进程异常退出、事件缺口或记录不完整时，该轮审计不可用，相关重复执行指标填缺测，不能算产品故障或宣称零重复。审计引入 I/O 开销，两组均启用并披露。它覆盖进入该应用的上述 HTTP 路由，不观测其他服务或绕过应用接口的内部执行路径；响应若不是可读取的字节内容会标记失败。

## 测试范围

现有 ComfyUI Python 的 aiohttp mock 测试 3/3 通过：两个 POST 路由的请求和响应、无客户端 ID 的单次事件记录、有客户端时不双计、原行为与日志失败标记。真实隔离验证使用 `/api/prompt` 和无客户端 ID；`/prompt` 的 v2 接入目前只有 mock 覆盖。一次测试不能代表全部失败、并发或客户端模式，正式开始前应冻结本结果并按实际场景检查证据完整性。
