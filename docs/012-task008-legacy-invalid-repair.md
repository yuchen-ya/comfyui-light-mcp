# Task008：旧库全 invalid 批次终态修复

日期：2026-11-09。基线 main：`d6dc78094ba9c3594ed5d0f40b9cadbef2215e0b`；产品修复提交：`c363602a51a5c219b035719beae33666c533bd7c`。按用户要求，由 `gpt-6.1-sol / high` 子智能体修复，并由另一名同模型/推理级别的独立子智能体审核；父智能体负责完整检查、实际安装验证和推送。

本次处理 [上一轮复审](011-task008-final-review-fixes.md) 保留的历史数据问题：旧库中所有 job 已 invalid，但 batch 仍 running，导致 get_batch/幂等重放与结果索引不一致。不是只修复新建路径。

## 实现与数据边界

`repairLegacyInvalidBatches` 用一条共享 UPDATE 修复且仅修复：

1. batch.status=running，total>0；
2. 实际 job 数量等于 batch.total；
3. 所有 job.status 均为 invalid。

只更新 batch.status=failed 和 finished_at。finished_at 保留已有值，否则取该批次最大 job.finished_at；全部缺失时回退 batch.created_at。没有以升级时间伪造执行时间，重复执行稳定。

迁移事务在安装 v5 writer guard 后调用此修复，覆盖旧 schema 升级及已存在 v5 库重新打开。启动恢复入口通过 BatchStore 调用同一实现。schema 仍为 v5，不新增依赖、配置、工具或生成重试逻辑。

unknown/submission_unknown、paused、pending、在途、混合状态、空批次、记录不完整及已结束批次不被此修正误改。job、Attempt、错误、工作流指纹、请求指纹、幂等键和 kv 数据保留。不产生远端提交、取消或下载。

## 回归与独立审核

新增 `tests/unit/legacy-invalid-batches.test.ts` 共 **12 项**：

- v2、实验 4.1、4.1new、v4、已有 v5 的磁盘库升级/重开，四种时间取值、相邻状态排除、数据保留、重复迁移和重开幂等。
- v2/v4 注入拒绝 UPDATE 的触发器，验证数据、schema 和写保护安装随同一事务回滚。
- 缺少正确 v5 writer capability 时修复被拒绝。
- openDb 后再注入历史状态，分别经过真实 Engine.recover 和 scheduler，覆盖 continue_on_error=true/false，防止迁移掩盖恢复缺陷。
- get_batch、JSONL 索引、幂等重放和单项 invalid 错误保持一致；job 不变、无新增 Attempt、POST/下载/interrupt/queue delete 均为零。

修复前首批 10 项新增回归全部按预期失败；修复后相关 11 文件、130 项测试通过。父智能体随后执行完整检查：

| 检查 | 结果 |
|---|---|
| build | 通过 |
| typecheck | 通过 |
| lint | 通过，显式忽略用户另行创建的未跟踪评测目录 |
| 完整测试 | **294 通过、6 跳过、0 失败**；26 文件通过、4 个历史真实 GPU 测试文件跳过 |
| npm audit | **0 漏洞** |
| git diff --check | 通过 |

所有完整测试使用不可达的 loopback 后端地址；迁移和恢复使用真实 SQLite、真实 Engine 及模拟后端，未连接生产 ComfyUI，未把它们称为 GPU 验证。

独立审核者直接以内存转译当前源码执行，复核五种 schema 的 **110 个批次筛选案例**、四种时间规则、重复执行、v2/v4/v5 失败回滚及 writer 拒绝。独立结论为通过、未发现阻断，上一轮确认的历史数据残留已解决。

## 实际 npm 包安装及旧 v5 数据验证

重新执行 npm pack dry-run 和实际 pack。新包仍为未公开的 `0.3.0-rc.1`，**40 文件、31 个运行 JS**；压缩 **62,958 bytes**，展开 **196,355 bytes**。两份实际文件清单一致，完整清单见 [012 npm 包清单](012-task008-pack-dry-run.json)。发布白名单未扩大，许可证与既有依赖许可清单保留。

在独立空消费目录、独立初始空 npm 缓存中执行 `npm install --omit=dev <local-tarball>`，成功安装 132 个包，报告 0 漏洞。然后：

1. 用初次交付的旧安装包，在本轮新建测试目录中创建真实 schema v5 磁盘库；通过其真实 BatchManager 产生两个 invalid job 但 batch=running 的原始缺陷。
2. 用新安装包启动 stdio MCP，后端指定不可达 loopback，不启动 ComfyUI。
3. 确认 get_batch=failed，结果索引 status=failed、complete=true、两条 invalid；同键请求 reused=true 且 failed。
4. 关闭并重新启动，再次得到一致结果。原始 job 逐字段不变，Attempt=0，schema=5，完整性及外键检查通过。

详细脱敏证据：[旧库安装复验 JSON](012-task008-legacy-invalid-verification.json)。运行库、完整日志和脚本仅保留在 gitignored `.analysis/task008-legacy-fix/`。未使用或改写用户生产库。

最新版本地 tarball 为 `.analysis/task008-legacy-fix/comfyui-light-mcp-0.3.0-rc.1.tgz`。此前两个目录中的同版本 tarball 是历史快照，不包含本轮修复；本次尚未公开发布，交付应使用最新包。

## 交付结论

旧库全 invalid/running 的剩余问题已修复，迁移、恢复及实际安装验证均通过。v5 写保护、原始记录与不确定远端任务语义保留。此前未覆盖的全新 Windows VM、原生模块源码编译及历史 GPU/模型用例仍未在本轮补测。

用户明确授权完成后推送 main；推送包括此前尚未同步的本地 Task006、Task007、Task008 提交。推送前逐文件检查本次提交和全部待推送内容的隐私，并核对原有公开证据副本；不纳入用户未跟踪评测目录。仅普通快进整合及推送，不创建 Release 或 tag，不执行 npm publish。完成后停止，等待最终验收。
