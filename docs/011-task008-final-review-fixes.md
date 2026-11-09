# Task008 最终复审修复

> 本文记录前三项修复；其中提到的旧库全 invalid/running 残留已在后续修复中处理，当前结论和安装包清单见 [旧库批次终态修复](012-task008-legacy-invalid-repair.md)。

日期：2026-11-09。修复基线：`f00b96de6337532caf98f62bf5bb74ec3b606110`。产品修复提交：`598ffa53a116537c5ebfbbcfce0e0172328296a8`。本报告和证据随后的提交不改变运行文件。

用户要求按 `gpt-6.1-sol / high` 委派修复，三个子智能体分别处理批次终态、单项文件补下载和双语备份示例。父智能体复核差异、运行完整回归，并验证实际 tarball 安装。仅在本地整合，不推送、不发布、不创建 tag。

## 三项问题与修复

| 复审问题 | 修复 | 验证 |
|---|---|---|
| P1：全 invalid 批次永久 running | 创建时发现所有 job 均 invalid，设置 batch=failed、finished_at=created_at；与 jobs 仍由原事务一起写入 | 默认/true/false 的 continue_on_error、立即终态、幂等复用、多次 tick 不变、零 Attempt/POST；混合合法批次仍 running |
| P2：单项 download=true 返回已删除文件的路径 | 所有 succeeded 单项复用现有 ResultDelivery.collect 的真实文件检查与并发去重 | 删除一个输出后 10 个并发请求仅补下载缺失文件，不重复下载保留文件；失败抛出并允许后续重试；download=false 不下载 |
| P2：Windows PowerShell 5.1 无法执行 README 备份命令 | 中英文统一改为 literal here-string 经 stdin 传给 Node；源/目标参数使用 argv[2]/argv[3] | PowerShell 5.1.26100.9711、7.6.9 实际备份均 exit=0；含空格路径、打开的 WAL 库、排除未提交行、integrity_check=ok、源数据和事务不变 |

新增 5 项单元测试，保留全部历史测试。没有新增 schema、依赖、MCP 工具或运行配置，版本继续为未公开的 `0.3.0-rc.1`。

## 完整检查与真实安装复验

- `npm run build`、`npm run typecheck`、`npm run lint`：全部通过。
- `npm test -- --fileParallelism=false`：**282 项通过、6 项跳过、0 失败**；25 个文件通过、4 个真实模型/GPU 测试文件跳过。测试设置不可达的 loopback 地址，未触碰生产后端。
- `npm audit --json`：**0 漏洞**。新 tarball 在独立空消费目录、独立初始空 npm 缓存中执行 `npm install --omit=dev <local-tarball>` 成功，安装 132 个包并报告 0 漏洞。
- 源码和新 tarball 分别启动 stdio，连接独立 ComfyUI 0.41.0 CPU 实例；空模型目录，禁用自定义节点与在线功能，不下载或安装模型。
- 四工具、单任务、成功/invalid 混合批次、JSONL、SQLite 完整性/外键/在线备份、EOF 正常退出均通过。
- 新增实际 stdio 验收：单项文件删除后，download=false 保持缺失，download=true 恢复；全非法批次立即 failed、get_batch 与结果索引一致、complete=true、幂等重取仍为 failed。
- 每条安装路径保存 3 batches、6 jobs、3 attempts，重启后数据和失败批次终态保持，Attempt 未增长。

详细脱敏数字：[Windows 及备份复验证据](011-task008-fix-verification.json)。验证脚本仍为 `scripts/verify-install.mjs`；原始日志、库和生成文件留在 gitignored `.analysis/task008-fixes/`。

## 更新后的 npm 包

重新执行 `npm pack --dry-run --json` 和实际 `npm pack`，核对两者文件清单一致。新包仍为 **40 文件、31 个 dist JavaScript 模块**；压缩 **62,312 bytes**，展开 **194,740 bytes**。

[最新实际文件清单](011-task008-pack-dry-run.json) 替代初次交付清单用于本轮修复包。包仍只含运行 JS、无模型示例、配置模板、双语 README、LICENSE、NOTICE、第三方许可文本与 package.json；不含测试、评测、图像、数据库、日志、个人配置或 node_modules。

新包位于 `.analysis/task008-fixes/comfyui-light-mcp-0.3.0-rc.1.tgz`，与初次包位于不同目录。版本相同但内容不同；本轮尚未公开发布，应使用此新包复核，不能继续使用初次 tarball。

## 结论与边界

本轮三项修复和上述复验通过。旧数据库中在修复前已持久化的“全 invalid 但 batch=running”记录不会被本次创建路径修复自动改写；未迁移或操作用户生产数据。如已有此类历史批次，仍需单独核对并决定数据修正，不能把新建批次回归视为历史数据已修复。

download=false 保留原契约，可能返回已失效的存储路径；需要实际文件时用 download=true。全新 Windows VM、原生模块源码编译、6 项模型/GPU 用例及其他平台覆盖仍未在本轮补测；原报告说明的环境边界保留。

每次提交前逐文件复核内容与隐私，未纳入用户另行创建的未跟踪评测目录。测试后端已停止；本地 main 使用普通快进整合，保留开发分支。完成后停止，等待用户最终验收。
