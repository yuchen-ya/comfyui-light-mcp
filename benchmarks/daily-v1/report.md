# Task006 日常任务对照：pilot 报告

2026-11-09；A：轻量 `80fde2807e248d2ea4cc953d8e6e2d69fc704b79`；B：官方 `5e4904fefbd264af04069581da3d3ea879fcab49` + comfy-cli 1.14.0。**完成 A1/A2/A4 各一组配对 pilot；A3 在环境准备阶段受阻；原定正式三组配对与 100 项放大未运行；后续减量实测见 [v2 报告](../daily-v2-fast/report.md)。**

## 决策页

- **已跑通批量生产：方向性支持轻量的交互成本更低，尚不足以作正式生产定位结论。** A1 两组各 20 张的参数、实际提交图、索引和 PNG 均核对；轻量/官方 tools/call 为 32/63，累计输入为 435,900/570,122，峰值输入 36,627/46,668。只有一次 pilot，初次接入成本缺测，全范围精确重复数为 null，不能宣传稳定节省比例。
- **参数优化：两组都完成 12+4，均选 cfg-1（steps=12、cfg=2），仅属自动质量代理。** 不能宣称等画质、纯 GPU 提速或推荐已最终成立；两组都通过通用终端直读 history 获取执行区间，收益来源必须包含 direct_api_bypass。
- **维护是否需要官方：A3 没有公平实跑证据。** 离线 Conda 克隆失败后遵守批准的停止条件，既未安装 KJNodes，也未启动两组 A3；不记为官方或轻量 install_failed。A4 两组均保全 20 件并在新会话完成三项用途发现；整理本身主要由文件脚本完成，不能证明官方维护工具有额外收益。
- **“轻量常驻、官方维护”仍是待证方案。** 不以工具数量或 schema 体积直接推断上下文收益，不新增产品功能。
- **最多三个后续产品项，本轮只支持两个候选：**① 批量结果索引/取全结果路径，减少 A1 的逐项 get_result；② 有界执行时间字段，减少 A2 的 history 绕过。均未实现，优先级待正式重复确认。

| 场景 | 合格文件 A · B | input A / B | 其中 cached A / B | output A / B | 峰值 input A / B | MCP tools/call A / B |
|---|---|---:|---:|---:|---:|---:|
| A1 | 20/20 · 20/20 | 435,900 / 570,122 | 408,704 / 546,432 | 4,007 / 5,282 | 36,627 / 46,668 | 32 / 63 |
| A2 | 16/16 · 16/16 | 785,918 / 1,342,996 | 748,544 / 1,297,408 | 7,897 / 9,871 | 44,977 / 59,156 | 25 / 52 |
| A4 | 3/3 · 3/3 | 808,396 / 1,227,384 | 743,040 / 1,157,760 | 11,615 / 12,019 | 50,463 / 58,861 | 23 / 30 |
| A3 | 未运行 · 未运行 | 缺测 | 缺测 | 缺测 | 缺测 | 缺测 |

累计输入含历史重放及缓存输入，峰值是最大一次请求的 input；两者不是同一指标。A1 包含一次索引追问；A4 合并整理和新会话发现两个阶段。A1 的非缓存输入反而为 27,196/23,690，因此累计 input 更少不能直接推出账单更低。缓存是 input 的子项，reasoning 是 output 的子项，不重复相加；用量来自宿主 token_count 元数据，逐请求之和与累计值吻合，并非估算或最终账单。[用量口径](https://developers.openai.com/api/docs/guides/agents-api/observability)

## 原始记录、正确性与限制

完整数字和时间边界见 [summary.json](results/summary.json)、[summary.csv](results/summary.csv)、[宿主用量](evidence/redacted/model-usage.json)。宿主元数据提取不复制消息、隐藏推理、工具正文、账户或额度。图像 token 细分与实际注入的工具定义清单 unavailable；总 usage 包含宿主计入的多模态输入。外层工具参数/返回字节为 rollout 序列化量，不等于 MCP 线字节或模型 token。

- A1：[A 验收](evidence/redacted/pilot-a1-a.json)、[B 验收](evidence/redacted/pilot-a1-b.json)、[独立观察复核](evidence/redacted/a1-independent-observer-review.json)。两组各 20 POST、20 唯一句柄及终止历史与实际图对应；可观察代理范围未发现重复。A 有 20 条实时开始事件、B 的异步 CLI 路径未通过代理 WS 发开始事件。A 最初的 machine_checks_passed 已单列为 proxy_scoped_machine_validation；独立复核后最终完整验收两组均为观测缺失，精确重复数保留 null。两次中性索引追问均未新增生成，追问 token 分别为 A input 36,627/output 50，B input 46,668/output 49，包含在表中。
- A2：[A 验收](evidence/redacted/pilot-a2-a.json)、[B 验收](evidence/redacted/pilot-a2-b.json)。实际 6×2 与基准/候选各两验证 seed、提交图允许字段、输出解码及 PNG 内图均核对；B 索引的固定 prompt 仅在独立审计副本按实际 POST 补齐。当前模板等于组织者按冻结来源重建的初始字节，但未另存独立任务前快照，选择先后因果也未由完整独立记录证明。A 验证候选 1,883/1,810 ms、基准 2,849/2,841 ms；B 候选 1,964/2,049 ms、基准 2,865/2,878 ms。这些是 history start→success 区间，含节点与服务端处理，不能称 GPU 纯计算时间。质量 pending_human_review。
- A3：[批准清单](a3-install-proposal.md)、[失败的共同起点准备](evidence/redacted/a3-preparation.json)。本机离线缓存虽有 17 个记录，克隆仍因 OfflineError 失败；没有网络补齐、节点安装或 A3 GPU 输出。私有缓存复制及克隆的 CPU/磁盘活动与 A1 pilot 重叠，影响时间解释。部分副本保留诊断，不静默清理或修改生产。
- A4：[输入转换](evidence/redacted/a4-input-validation.json)、[六图准备验证](evidence/redacted/a4-runtime-validation.json)、[A 验收](evidence/redacted/pilot-a4-a.json)、[B 验收](evidence/redacted/pilot-a4-b.json)。6 组 API/UI、2 字节重复、2 内容等价、2 合法变体、1 缺节点、1 损坏 JSON；两组 20 个映射均可按哈希还原，新会话各完成文生图、水平翻转、红通道蒙版。后两项逐像素差异为 0。两个历史图经中性化并适配当前模型，四个为核心图像操作，属于偏小的维护个案。**B 文生图的 KSampler 等八个节点命中缓存，只有 SaveImage 重执行，不比较其耗时优势。**

MCP 原始参数/返回、图、索引、图片和局部日志仅在本机 LOCAL_PILOT_EVIDENCE；公开文件使用逻辑别名。六项 pilot 都完成可解码输出，但观测缺口/质量待确认不能写成完整正式验收通过。失败和调试没有从 usage 删除；通用工具、自写 SDK 脚本和看图也计入宿主 usage。MCP 接入方式是双方相同的显式 stdio SDK 代码调用，不是客户端原生将两套 MCP 同时注入。A2 的 initialize/list 总数含连接记录与代理自报，tools/call 有原始记录；不要将单脚本聚合误数为一个 MCP 请求。

## 准备、缓存和复用摊销

[环境锁](environment.lock.json)、[输入锁](inputs.lock.json)保存版本与指纹；官方依赖为已观察的解析锁，不是 wheel 内容锁。npm 包版本 0.1.0 与运行时服务器 0.3.0 均照实保留。完整 tools/list compact UTF-8 参考体积为 A 4,189、B 63,329 字节；instructions 为 A 2,989、B 18,115 字节，实际模型暴露模式仍缺测。这些潜在体积不替代上面的真实 usage。[官方固定快照说明](https://github.com/Comfy-Org/comfy-mcp/blob/5e4904fefbd264af04069581da3d3ea879fcab49/README.md)

首接 manifest/slot/客户端配置的历史成本 unavailable，不能填 0；本次评测基础设施准备的三个子智能体用量另存 model-usage.json，既不免费，也不强行归给某个被测产品，父组织者的当前快照也单列，后续最终汇报用量尚未计入，不能声称这就是最终准备总成本。以下仅是明确的复用情景：若每批都像本次 A1 一样且含一次索引追问，总模型 token = 未知首次接入成本 S + 批次数×本次 observed total_tokens，缓存和代理行为可能变化，绝非已发生数据或计费预测。

| 批次情景 | A | B |
|---|---:|---:|
| 1 | S_A + 439,907 | S_B + 575,404 |
| 10 | S_A + 4,399,070 | S_B + 5,754,040 |
| 50 | S_A + 21,995,350 | S_B + 28,770,200 |

## 范围偏差与下一道门槛

两次 CLI 只读检查（--version、--help）在明确设置独立 profile 前运行，源码表明可能初始化默认配置；前置调查发现相关目录时间早于检查，但没有事前内容快照，不能保证完全未写入。后续均隔离 profile；截至本轮结束，没有设置全局 consent、更新生产代码/依赖、安装 A3 节点、付费调用、合并 main 或发布。

本轮共提交 92 次生成/图像操作：连通性2、暖机4、A1 40、A2 32、A4输入验证6、新会话发现6、审计验证2；A3为0，在批准104上限内。记录包括失败的审计 v1，未以 v2 成功覆盖它。新的后端审计 v2 在独立 clone 对无 client_id 的直连 /api/prompt 记录完整 POST/响应/start/success，但它不追溯补齐 pilot 缺测。[v1失败](evidence/redacted/backend-audit-check.json)、[v2回归](evidence/redacted/backend-audit-check-v2.json)、[接入说明](observers/comfy-audit-integration.md)。

历史提案曾准备 [3组配对顺序与新seed](formal/plan.json)，拟另行批准 216 张任务图 + 12 张对称暖机 = **228 张**、每任务60分钟、输出10GiB，并重新冻结；此 228 张方案已被后续减量范围取代，未执行。原拟每任务使用独立 raw ComfyUI 输出/状态、相同后端审计 v2、事前模板快照及对称暖机；本轮 parallel prep 与共享 raw 输出不带入正式。A3 依照已批准的离线失败停止条件保持受阻，不自动修复或联网；100项放大另需200任务图+2暖机，未授权未运行。正式结论还需三组原始值、配对差及中位数，不从单轮算显著性或 p95。

构建、lint、257项产品离线测试、5项评测Node自测及3项Python审计自测通过；没有沿用旧e2e数字。本次启动的8190/8191与审计检查8194均已停止，私有证据和A3部分副本保留；Conda额外写入工作区的ToS缓存已移入私有分析目录。[检查](evidence/redacted/checks.json)、[清理](evidence/redacted/cleanup.json)。
