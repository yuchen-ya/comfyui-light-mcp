# 使用指南

[English](usage.md) · [项目简介](../README.zh-CN.md)

## 安装本地候选包

源码目录执行 `npm ci` 安装锁定依赖，`npm pack` 构建本地 tarball。在另一个新建目录中执行：

```powershell
npm init -y
npm install --omit=dev C:/handoff/comfyui-light-mcp-0.3.0-rc.2.tgz
Copy-Item node_modules/comfyui-light-mcp/config.env.example config.env
Copy-Item -Recurse node_modules/comfyui-light-mcp/examples workflows
```

将 `C:/handoff` 换成实际包目录，把 config.env 的 `WORKFLOWS_DIR` 改成 `./workflows`，再启动：

```powershell
node --env-file=config.env node_modules/comfyui-light-mcp/dist/index.js
```

进程会等待 MCP 客户端输入。客户端配置见 README，args 指向已安装包的 `dist/index.js`，工作流、数据和输出目录使用绝对路径。`better-sqlite3` 原生模块必须匹配 Node 与架构，请允许安装脚本；预编译二进制不可用时需要 Python 和 Visual Studio C++ Build Tools。不要复制别的机器的 node_modules。

## 配置

Node 的 `--env-file` 加载指定文件，不会自动发现 `.env`；显式环境变量优先。相对目录基于进程工作目录，不基于配置文件位置。个人配置不要放入版本控制。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | HTTP(S) 地址，可含代理路径前缀，HTTP 和 WS 均需可达 |
| `WORKFLOWS_DIR` | `./workflows` | 递归扫描 `*.manifest.json` |
| `DATA_DIR` | `./data` | SQLite 状态目录，启动时创建 |
| `OUTPUT_DIR` | `./output` | 下载文件和 JSONL 索引 |
| `AUTO_SAVE_OUTPUTS` | `true` | 完成时下载，false 则查询结果时下载 |
| `MAX_IN_FLIGHT` | `1` | 1–64，提交中、未知、排队和执行中的总上限 |
| `MAX_QUEUED_JOBS` | `1` | 1–64，不得大于 MAX_IN_FLIGHT |
| `JOB_TIMEOUT_MS` | `600000` | 墙钟截止时间，10000–86400000 毫秒 |

布尔值支持 true/false/1/0。配置示例使用 `./examples` 便于无模型检查。地址不允许凭据、查询参数或 fragment，本项目没有后端认证配置；请连接可信端点。文件修改会热加载，环境变量修改需要重启。

## 工作流与 manifest

从 ComfyUI 导出 **API 格式**：以节点 ID 为键，节点包含 class_type 与 inputs。带 nodes/links 的可视化编辑器 JSON 不适用；也接受 `{ "prompt": { ... } }` 包装。先审核工作流和自定义节点，再将图与 manifest 一起放在 WORKFLOWS_DIR 下的同一目录。

自带 solid-color 使用内置 EmptyImage → SaveImage，不需要模型。最小 manifest：

```json
{
  "name": "solid-color",
  "description": "ComfyUI 内置节点安装检查",
  "version": 1,
  "workflowFile": "solid-color.json",
  "params": [
    { "name": "color", "node": "1", "input": "color", "type": "integer", "min": 0, "max": 16777215, "default": 255 }
  ]
}
```

名称以字母开头，使用字母、数字、下划线和连字符，最长 64 字符。workflowFile 只能是同目录文件名。至少声明一个参数，每项指向已有标量输入，不能覆盖连线。类型有 string/number/integer/boolean/enum，enum 需要非空字符串数组。数值支持 min/max/step，step 相对 min 或零对齐。required=true 与 default 互斥；两者都未设置时，省略参数保留图中原值。整数 seed 可用 special=seed、default=-1；正式执行会保存实际随机 seed。

列表、运行、dry-run 调用与调度器刷新会检测文件变化。非法或删除的文件阻止新执行；待提交任务遇到指纹不符会暂停。还原原文件对可恢复旧批次；有意修改可用新工作流名、新批次。已提交任务按原提交图继续执行。

## 预检和提交

以下 JSON 是 MCP 工具参数，不是终端命令。list_workflows 列出摘要，传 `{"workflow":"solid-color"}` 获取参数和加载状态。先向 run_workflow 传入：

```json
{"workflow":"solid-color","dry_run":true,"params":{"color":255}}
```

Dry-run 检查参数、图结构及可取得的节点与模型 schema，不创建 Batch/Job/Attempt，不提交生成。valid=true 表示没有发现阻断错误，仍要检查 checks、warnings 与 validation_sources；unknown 或过期/不可用 schema 不代表后端可执行。动态自定义节点可能仍需运行验证。Dry-run 不占用幂等键，也不冻结后续执行使用的文件。

单项执行：

```json
{"workflow":"solid-color","params":{"color":255},"idempotency_key":"single-demo-1"}
```

批量执行最多 200 项：

```json
{
  "workflow": "solid-color",
  "idempotency_key": "colors-demo-1",
  "continue_on_error": true,
  "max_attempts": 1,
  "runs": [
    { "label": "blue", "params": { "color": 255 } },
    { "label": "green", "params": { "color": 65280 } },
    { "label": "red", "params": { "color": 16711680 } }
  ]
}
```

params 和 runs 二选一，均省略则按默认参数运行单项。批量非法项独立记为 invalid；单项参数非法则拒绝调用。两种形式都接受 max_attempts（含首次共 1–5 次，默认 1）和 continue_on_error（默认 true；false 在最终失败后放弃剩余未提交任务）。只有确认远端失败后才能重试，未知提交不会自动重复。相同幂等键和相同内容复用批次；内容、重试选项或工作流指纹变化会报 IDEMPOTENCY_CONFLICT。先检查旧批次，再考虑替换请求。

## 查询与取回结果

向 get_batch 传 `{"batch_id":"<返回的 id>","limit":20,"offset":0}`。limit 最大 100；用 next_offset 翻页，可按 status 筛选任务。unknown 和 paused 不计入失败。建议每隔数秒轮询，并设置客户端截止时间。

向 get_result 传 `{"batch_id":"<id>","mode":"index","download":true}`，生成 OUTPUT_DIR/<batch_id>/results.jsonl。每个原始任务一行，按 index 排序，含标签、状态、可取得的实际 seed、精简错误及全部输出引用。每个文件含可用性、字节数及可用时的本地绝对路径。MCP 仅返回摘要和 index_path，客户端需另有文件读取权限；远端主机上的路径属于远端。

complete 只表示执行终结，还要检查 unavailable_outputs。重复调用可补下载，不会重新生成。download=false 仅索引已存在文件。索引是最新快照；单项详情用 `{"batch_id":"<id>","index":0,"download":true}` 查看实际参数和输出。

## 输入素材、恢复与备份

通过 ComfyUI 上传素材或复制到它的 input 目录，在 manifest 中暴露加载器文件名参数，如 image=source.png。文件由 ComfyUI 主机解析。待处理期间保持素材稳定。本项目没有上传、工作流编辑、模型管理或取消工具。

状态位于 DATA_DIR/comfyui-light.db，使用 WAL。同一数据库只运行一个 MCP 进程，放在本地可写磁盘。v1–v4 事务迁移至 v5，未知新 schema 拒绝打开。缺少历史指纹的旧 pending 暂停；未决尝试先对照后端 queue/history 再决定是否可重试。不要直接编辑任务状态或删除写保护。

升级前停止进程并等待退出，在无写入期间复制整个 DATA_DIR，包括仍存在的 WAL/SHM。活跃数据库使用 SQLite 在线备份 API。OUTPUT_DIR、工作流/manifest 和 ComfyUI 输入素材另行备份。回退时在独立目录使用匹配版本与备份，不能用旧程序写升级后的数据库。客户端断开/EOF、SIGINT/SIGTERM 会关闭本地调度与数据库，不取消远端生成；重启后对账。

| 现象 | 处理 |
|---|---|
| 原生模块缺失或 ABI 不符 | 使用匹配的 Node 架构，允许安装脚本后重新安装 |
| 找不到工作流或加载非法 | 检查 API 格式、manifest 文件名及目标输入，查看 list_workflows 错误 |
| COMFY_UNREACHABLE 或任务 pending | 检查端点及 HTTP、WebSocket 连通性 |
| submission_unknown / TIMEOUT_UNCONFIRMED | 保留数据库和后端历史，等待对账，重提前核实远端工作 |
| paused / WORKFLOW_VERSION_MISMATCH | 还原原文件对，或使用新工作流名创建新任务 |
| complete 但文件缺失 | 查看 availability 和 unavailable_outputs，恢复后端文件再获取 |
| 客户端 JSON 解析失败 | 直接启动 node，stdout 专供 MCP |

恢复依赖 queue/history，清空证据可能让任务长期未知。自定义输出格式可能没有可下载引用。相同 seed 不保证跨节点、模型、版本和硬件复现。磁盘保留和清理由用户管理。目前仅支持 Windows 11 x64，其他平台和 Node 主版本未验证。
