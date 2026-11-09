# Task008：工程收尾与预发布验收

> 本文保留初次交付的验证记录。后续只读复审发现三项缺陷；修复和最新复验结果见 [Task008 最终复审修复](011-task008-final-review-fixes.md)，包括更新后的包清单。本文原“未发现阻断”结论不代表复审后的状态。

日期：2026-11-09。建议候选版本：**0.3.0-rc.1**。本次只完成本地工程整合与验收，不执行 npm publish、GitHub Release、正式 tag 或远端推送。

候选产品提交：`26320ae4faf59c557f325a1bd2553503ee06567f`。本报告和脱敏证据作为随后提交加入同一候选分支，最终本地 main SHA 由交付回复及 `git rev-parse main` 给出；报告不嵌入自身提交的 SHA。

## 代码整合结论

整合前 main 与 origin/main 均为 `80fde2807e248d2ea4cc953d8e6e2d69fc704b79`。Task007 分支从 main 经 Task006 证据提交线性发展；本次从 Task007 建立 `codex/task008-prerelease`，最终使用 `git merge --ff-only` 更新本地 main，不强制覆盖、不删除任何分支。

| 已验收内容 | 提交 | 结论 |
|---|---|---|
| P4.1 整合与 R2 | `9309ba5`、`0c31896`、合并 `1903d6b` | 已在原 main 中，本次完整保留 |
| v5 旧连接写保护 | `80fde28` | 已在原 main 中，本次完整保留 |
| Task006 已脱敏证据 | `6ca3b2a` | 随已验收开发分支整合，原文件及归属声明保留，排除于 npm 包 |
| Task007 批量结果索引 | `1b22f02` | 完整整合，未改变四工具契约 |
| Task008 安装与包装 | `26320ae` | 统一版本、文件白名单、README、许可、安全依赖与 stdio 关停 |

已检查 `4.1new`、`codex/task005r-integration`、Task006、Task007 均是候选产品提交的祖先。`4.1` 是另一套实验实现；[P4.1 整合报告](006-p41-reliability-report.md) 明确记录已从中采纳连接门控及 attempt 同步方案，并以 canonical 指纹和保守恢复契约整合，不能将该旧实验分支整包覆盖回来。其分支继续保留。没有删除历史测试、历史证据或许可证。

产品与 MCP initialize 返回版本现在都从 package.json 得到 `0.3.0-rc.1`，不再分别维护 `0.1.0/0.3.0`。最低 Node 提升至 22.12.0，以适配已修补的测试工具链；实测 Node 22.22.0。

入口新增可安装 bin 和 prepack 构建。stdio EOF、SIGINT、SIGTERM 会停止本地调度、关闭客户端和数据库；不会取消远端任务。已实际验证两次启动在 stdin EOF 后退出码均为 0。

## Windows 干净安装

实际平台：Windows 11 Pro x64，系统 build 26100；Node.js 22.22.0，npm 10.9.4。

验证使用两个独立源码副本和一个 tarball 消费目录。各目录起初无 node_modules、dist、数据库；npm ci、npm install、tarball 安装分别使用独立的初始空 npm 缓存。目录名包含空格，覆盖 Windows 路径处理。这里的“干净”指依赖及运行数据隔离，**不是重装 Windows 或全新 VM**；本机原有网络、系统库和原生构建工具未移除。

| 验证 | 实际结果 |
|---|---|
| 源码副本 A：`npm ci` | 成功，安装 269 个包 |
| 源码副本 B：`npm install` | 成功，安装 269 个包 |
| A：build / typecheck / lint | 全部通过 |
| A：`npm test -- --fileParallelism=false` | 25 个文件通过，277 项通过，0 失败；4 个文件中的 6 项历史真实模型/GPU 用例跳过 |
| B：TypeScript build | 通过 |
| tarball：`npm install --omit=dev <local-tarball>` | 成功，安装 132 个包（项目包及其依赖），不依赖开发依赖 |
| better-sqlite3 | 源码安装与包安装均能加载原生 addon，真实执行 SQLite 查询 |
| 配置初始化 | 从 config.env.example 创建独立 config.env，用 Node --env-file 加载；相对路径按独立运行目录解析 |

原生模块使用预编译安装路径验证，没有要求安装新编译工具。无法取得预编译包时的源码编译路径未验证。安装提示 prebuild-install 7.1.3 和 ESLint 9.39.5 已弃用/停止支持；目前安全审计为零，未为消除提示扩大到原生库或 ESLint 主版本升级。

## 真实 ComfyUI 与 stdio 验证

使用已有的 ComfyUI 0.41.0 测试代码与 Python 环境，启动独立 loopback 端口的实例；全部 base/user/input/output/temp/models 目录在本轮私有测试根下。CPU 模式，模型目录为空，禁用自定义节点、partner 节点和在线功能。没有修改或启动生产 ComfyUI，没有下载、安装、复制或上传模型。

运行内置 `EmptyImage → SaveImage` 的纯色工作流，真实经过 HTTP、WebSocket、调度器、MCP stdio 和 SQLite，不能将此称为扩散模型/GPU 回归。两条安装路径分别使用新目录、新数据库执行同样验收：

| 项目 | 源码安装 / tarball 安装 |
|---|---|
| initialize 版本 | 都为 0.3.0-rc.1 |
| 工具注册 | 恰好 list_workflows、run_workflow、get_result、get_batch |
| 工作流扫描 | 成功注册 solid-color |
| 单任务 | 成功，resolved color 正确，输出文件存在 |
| 批量 | 2 项成功、1 项 invalid，批次为 partial；非法项未产生 Attempt |
| get_batch | 成功/非法计数准确 |
| get_result mode=index | 3 行 JSONL，label 与顺序正确；2 个成功输出 availability=available，文件字节数准确 |
| 索引重取 | 重启后路径和 updated_at 不变，没有重新生成 |
| SQLite 持久化 | 2 batches、4 jobs、3 attempts；重启后记录可读，尝试数仍为 3 |
| 数据完整性 | integrity_check=ok，foreign_key_check 为空 |
| 在线备份 | better-sqlite3 backup 成功，独立备份中的尝试数正确 |
| 客户端断开 | 两次启动均在 stdin EOF 后自行退出，退出码 0 |

复用验收脚本（仅面向明确隔离的后端）：

```powershell
node scripts/verify-install.mjs <已安装包目录> <尚不存在的运行目录> <隔离的ComfyUI地址>
```

脚本拒绝复用既有运行目录；原始 stderr、运行库、生成文件及 npm 日志仅保留在 gitignored `.analysis/task008/`。公开证据没有本机绝对路径、进程 ID 或用户配置：[Windows 验收 JSON](010-task008-windows-acceptance.json)。

## Migration 与旧库兼容

没有新 schema；保留 v5。检查全部顺序迁移、事务回滚、旧状态转换与持久写保护。相关离线测试使用真实 SQLite 文件及历史 schema 夹具，不操作生产库。

- 新增 v1 磁盘库升级测试：应用 v2–v5，保留既有 kv 数据，索引安装正确；两次重新打开均通过完整性和外键检查。
- 保留 v2、实验 4.1/4.1new、v4、v5 的既有升级、历史记录、pending 重试与写保护测试。
- 缺失历史工作流指纹的 pending 继续 paused，不以当前工作流伪造旧快照；未确认远端终态的上一 Attempt 继续占位对账。
- v3/v4 的旧 pending 重试继续由 R2 迁移恢复取消/成功意图，不绕过远端确认。
- DDL 与 user_version 事务回滚测试通过；重复迁移幂等。
- 新增未知 v6 拒绝测试：拒绝打开，原 user_version 与既有数据保持不变。
- v5 对四张表三类写入的旧连接阻断测试保留并通过。回退必须使用升级前备份及独立 DATA_DIR。

## npm 包装

实际执行 `npm pack --dry-run --json`，并实际 `npm pack` 得到本地 tarball 供独立安装。**没有 npm publish**。

- 文件数：**40**。
- 压缩体积：**62,162 bytes**；展开体积：**193,990 bytes**。
- 完整实际文件名、大小和 mode：[npm pack dry-run 原始清单](010-task008-pack-dry-run.json)。实际 tarball 的文件清单与其一致。
- 包含 31 个 dist JavaScript 模块、2 个无模型示例 JSON、配置模板、2 份 README、LICENSE、NOTICE、THIRD_PARTY_LICENSES.txt 和 package.json。
- files 白名单排除 tests、benchmarks、历史图片、模型、源码、source maps、.analysis、运行数据库、日志、个人配置和 node_modules；依赖由 npm 安装。
- 按全部 src 模块核对 dist 条目，无缺失；生产依赖安装后即可 stdio 启动，无开发环境绝对路径依赖。
- 保留所有历史测试在源码仓库，只是不装入运行包。

本地包位于 `.analysis/task008/comfyui-light-mcp-0.3.0-rc.1.tgz`，不提交二进制包。预发布前若代码或 README 再变动，需重新 pack 并复核交付包。

## 许可证、安全与隐私

保留 MIT LICENSE。补全改编代码的 MetaBrain-Labs 原版权头和完整 MIT 文本；NOTICE 新增 MCP SDK 归属及依赖清单指引。历史 comfy-mcp 的 Apache 许可证和 NOTICE 继续留在 benchmark 证据目录，未误改为本项目 MIT。

[依赖许可清单](010-task008-dependency-licenses.json) 来自最终 lockfile：131 个 runtime 条目、188 个 development 条目，含未在本平台安装的可选包；所有条目都有明确 license 元数据。runtime 许可证为 MIT、ISC、Apache-2.0、BSD-2-Clause、BSD-3-Clause 或含这些许可的多选表达式，无未知许可。development 还含 BlueOak-1.0.0、Python-2.0、MPL-2.0。直接 runtime 依赖均为 MIT，better-sqlite3 内嵌 SQLite 为公有领域；安装包中各依赖自带的许可证继续保留。许可检查是本次工程清单核对，不作法律结论。

审计起点为 11 个告警（2 critical、1 high、8 moderate）。针对受影响链更新 Zod 至 4.6.7、Vitest 至 5.1.0、typescript-eslint 至 8.72.1，并仅在 typescript-estree 下覆盖 minimatch 至修补的 11.x（锁定 11.0.5）。Zod 4 的错误文本大小写变化相应调整既有测试，保留类型拒绝断言。最终 `npm audit --json` 和 `npm audit --omit=dev --json` 均 **0 漏洞**，生产 tarball 安装也返回 0 漏洞。审计反映 2026-11-09 注册表已知风险，不是无漏洞保证。

相关上游安全公告：[Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)、[Vitest GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)、[Tinypool GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)、[minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)。

提交前逐文件检查本次完整变更、lockfile、文档和示例，扫描密钥/令牌/密码、真实用户目录、私有磁盘路径、内部网络地址及运行数据。未发现需公开排除的信息；README 中仅保留明确标注的占位路径和公开 loopback 示例；公开许可证原署名按要求保留。Task006 的原有脱敏发布清单校验通过（354 文件），不将其视为对实验结论的重新科学验收。

## 安装和运行入口

[English README](../README.md) 与 [中文 README](../README.zh-CN.md) 均覆盖定位、Windows 安装、地址、API 导出、manifest、批量、Batch 查询/索引、素材、排错、SQLite 备份、客户端配置及限制。

源码启动最小示例：

```powershell
npm ci
npm run build
Copy-Item config.env.example config.env
node --env-file=config.env dist/index.js
```

默认配置示例会加载无模型的 solid-color 工作流；ComfyUI 仍需用户自己启动。实际客户端应按 README 使用 node 直接启动，并明确配置工作流、数据和输出绝对目录。

## 未解决项与建议

当前未发现阻断本地候选安装和核心流程的产品问题。验收范围仍有以下限制：

1. 未在全新 Windows VM 上复验；本次是 Windows 11 本机干净目录、依赖和缓存验证。若验收要求操作系统级全新环境，应在发布前另补一次 VM 安装。
2. 6 项历史模型/GPU 集成测试本轮跳过；真实 ComfyUI 协议验收使用内置无模型节点，不替代生成质量、特定模型或 GPU 验证。
3. 预编译原生包不可达时的源码编译路径、Windows ARM64、其他 Node 主版本和其他 ComfyUI 版本未验证。
4. prebuild-install 弃用与 ESLint 9 停止支持提示保留，属于后续维护事项；本次没有已知安全告警。
5. 单进程本地数据库、无认证配置、无上传/取消工具、后端 history 丢失可长期 unknown、无自动数据清理等现有限制已写入两份 README。

建议最终工程验收后保留 **0.3.0-rc.1** 作为首个候选编号；完成所需环境覆盖及用户验收后，再单独决定正式版本。此次没有创建 tag、公开版本或远端推送，没有增加 GUI 或其他收尾无关功能。完成后停止，不监控 CI、发布或合并状态，等待最终工程验收。
