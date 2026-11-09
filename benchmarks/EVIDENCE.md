# Task006 证据导航

相对链接指向统一交付目录。公开记录保留数值、验证结论、去元数据的结果图及脱敏轨迹；未经处理的原件和本地运行环境仍在私有分析目录。公开副本的格式与字节可能变化，不能直接当作原始私有工作目录运行验证器。关于每个检查的适用范围，以对应报告、处理清单和验证器说明为准。

| 结论或材料 | 证据 |
|---|---|
| 全部计分图及 A2 接触表（182 + 12） | [v1 图像与校验清单](daily-v1/evidence/images/manifest.json)、[v1 图像目录](daily-v1/evidence/images/)；[v2 图像与校验清单](daily-v2-fast/evidence/images/manifest.json)、[v2 图像目录](daily-v2-fast/evidence/images/)；原始和公开哈希分列，像素保持 |
| MCP 调用与后端实际事件（21 份公开轨迹） | [v1 轨迹及处理清单](daily-v1/evidence/traces/PUBLICATION.json)、[v1 目录](daily-v1/evidence/traces/)；[v2 轨迹及处理清单](daily-v2-fast/evidence/traces/PUBLICATION.json)、[v2 目录](daily-v2-fast/evidence/traces/)；后端 Base64 JSON 已转为可读对象，原始缺失未补造 |
| 发布完整性、脱敏与来源归属 | [公开文件校验清单](publication-manifest.json)、[隐私处理](PRIVACY.md)、[归属与许可](THIRD_PARTY.md)；`node benchmarks/verify-publication.mjs` 验证发布文件 |
| v1 92 次、逐任务结果与限制 | [pilot 报告](daily-v1/report.md)、[summary JSON](daily-v1/results/summary.json)、[CSV](daily-v1/results/summary.csv) |
| v2 110 次、104 项执行与逐任务结果 | [v2 报告](daily-v2-fast/report.md)、[summary JSON](daily-v2-fast/results/summary.json)、[CSV](daily-v2-fast/results/summary.csv)、[执行索引](daily-v2-fast/results/execution-index.json) |
| 宿主模型 usage；缓存与非缓存口径 | [v1 usage](daily-v1/evidence/redacted/model-usage.json)、[v2 usage](daily-v2-fast/evidence/redacted/model-usage.json)；各轮报告中解释其限制 |
| v1 A1 观察缺口；A2 验收 | [A1 A](daily-v1/evidence/redacted/pilot-a1-a.json)、[A1 B](daily-v1/evidence/redacted/pilot-a1-b.json)、[独立复核](daily-v1/evidence/redacted/a1-independent-observer-review.json)、[A2 A](daily-v1/evidence/redacted/pilot-a2-a.json)、[A2 B](daily-v1/evidence/redacted/pilot-a2-b.json) |
| v2 六项独立机器验证 | [A1 A](daily-v2-fast/evidence/redacted/a1-a-r1-validation.json)、[A1 B](daily-v2-fast/evidence/redacted/a1-b-r1-validation.json)、[A2 A1](daily-v2-fast/evidence/redacted/a2-a-r1-validation.json)、[A2 B1](daily-v2-fast/evidence/redacted/a2-b-r1-validation.json)、[A2 A2](daily-v2-fast/evidence/redacted/a2-a-r2-validation.json)、[A2 B2](daily-v2-fast/evidence/redacted/a2-b-r2-validation.json)；质量仍待盲评 |
| 环境、输入与依赖锁 | v1 [环境](daily-v1/environment.lock.json)、[输入](daily-v1/inputs.lock.json)、[官方依赖](daily-v1/official-requirements.lock.txt)；v2 [环境](daily-v2-fast/environment.lock.json)、[输入](daily-v2-fast/inputs.lock.json)、[官方依赖](daily-v2-fast/official-requirements.lock.txt)。依赖是观察到的解析版本，不是 wheel 内容锁 |
| 工具和 instructions 契约 | v1 [轻量契约](daily-v1/evidence/redacted/light-contract.json)、[官方契约](daily-v1/evidence/redacted/official-contract.json)、[轻量列表](daily-v1/evidence/redacted/light-tools-list.json)、[官方列表](daily-v1/evidence/redacted/official-tools-list.json)、[轻量 instructions](daily-v1/evidence/redacted/light-instructions.txt)、[官方 instructions](daily-v1/evidence/redacted/official-instructions.txt)；v2 [A](daily-v2-fast/evidence/redacted/contract-a.json)、[B](daily-v2-fast/evidence/redacted/contract-b.json) |
| A3 受阻及停止条件 | [准备失败](daily-v1/evidence/redacted/a3-preparation.json)、[历史授权提案](daily-v1/a3-install-proposal.md) |
| A4 输入、运行和两组整理；缓存边界 | [输入验证](daily-v1/evidence/redacted/a4-input-validation.json)、[运行验证](daily-v1/evidence/redacted/a4-runtime-validation.json)、[A](daily-v1/evidence/redacted/pilot-a4-a.json)、[B](daily-v1/evidence/redacted/pilot-a4-b.json)、[报告说明](daily-v1/report.md) |
| 后端审计首次失败与修正回归 | [v1 失败](daily-v1/evidence/redacted/backend-audit-check.json)、[v2 成功](daily-v1/evidence/redacted/backend-audit-check-v2.json)、[接入与覆盖边界](daily-v1/observers/comfy-audit-integration.md) |
| 检查、准备和进程清理 | v1 [检查](daily-v1/evidence/redacted/checks.json)、[清理](daily-v1/evidence/redacted/cleanup.json)、[预检](daily-v1/evidence/redacted/preflight.json)；v2 [准备](daily-v2-fast/evidence/redacted/preparation.json)、[最终检查](daily-v2-fast/evidence/redacted/final-checks.json)、[清理](daily-v2-fast/evidence/redacted/cleanup.json) |
| 任务协议、fixtures 和验证脚本 | v1 [suite](daily-v1/suite.json)、[验证器说明](daily-v1/validators/README.md)、[观察器](daily-v1/observers/)和 [fixtures](daily-v1/fixtures/)；v2 [suite](daily-v2-fast/suite.json)、[验证器说明](daily-v2-fast/validators/README.md)、[桥](daily-v2-fast/mcp-bridge.mjs)和 [fixtures](daily-v2-fast/fixtures/) |
| 被取代的原三组计划 | [历史计划](daily-v1/formal/plan.json)；不是已运行结果 |
