# ComfyUI Light MCP

[English](README.md) · MIT · 候选版本 **0.3.0-rc.1**（尚未发布）

通过本地 stdio MCP，让 AI 客户端执行你已审核的 ComfyUI 工作流。

- **Workflow-first**：先导出 API 工作流，再用 manifest 声明参数白名单；每次调用只传参数，无需反复传递大图。
- **Batch-native**：一次提交最多 200 项带 label 的任务，内置持久化、调度窗口、幂等键与保守恢复。
- **Context-light**：四个工具提供摘要和分页状态，全部结果交付为本地 JSONL 索引，避免将日志、图像或完整工作流塞进对话。这里描述接口特点，不承诺固定的 token 或费用降幅。

要求 Windows 11 x64、**Node.js 22.12+**（实测 22.22.0）。ComfyUI 需另行安装并启动；已验证后端为 ComfyUI 0.41.0，其他版本和 Windows ARM64 未验证。本项目不安装 ComfyUI、自定义节点或模型。

## Windows 安装

在候选版本的源码目录中使用 PowerShell：

```powershell
npm ci
npm run build
Copy-Item config.env.example config.env
node --env-file=config.env dist/index.js
```

也支持 `npm install`；`npm ci` 按已提交 lockfile 安装。`better-sqlite3` 是原生模块，必须与 Node 版本、架构匹配。正常 Windows x64 环境使用预编译二进制；无法取得时需要 Python 和 Visual Studio C++ Build Tools。不要使用 `--ignore-scripts`，也不要复制其他机器的 node_modules。

本地包交付（无需公开发布）：

```powershell
# 源码目录；prepack 会自动 build。
npm pack
# 在另一个新建的安装目录中：
npm init -y
npm install --omit=dev C:/handoff/comfyui-light-mcp-0.3.0-rc.1.tgz
Copy-Item node_modules/comfyui-light-mcp/config.env.example config.env
Copy-Item -Recurse node_modules/comfyui-light-mcp/examples workflows
# 先将 config.env 中 WORKFLOWS_DIR 改为 ./workflows。
node --env-file=config.env node_modules/comfyui-light-mcp/dist/index.js
```

`C:/handoff` 是占位示例，请替换。安装还提供 npm 本地命令 `comfyui-light-mcp`。MCP 客户端应直接启动 `node`，避免 npm 启动横幅混入 stdout。直接在终端启动会等待 MCP JSON-RPC 输入，并非交互式命令行。

## 配置 ComfyUI 地址和数据目录

编辑 `config.env`，由 Node `--env-file` 加载。项目没有配置向导，也不会自动发现 `.env`。显式环境变量优先于 env 文件；个人配置不要提交到仓库。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | 已运行的 ComfyUI HTTP(S) 地址，HTTP 与 WebSocket 都须可达 |
| `WORKFLOWS_DIR` | `./workflows` | 启动时递归扫描 `*.manifest.json` |
| `DATA_DIR` | `./data` | SQLite 持久化目录，启动自动创建 |
| `OUTPUT_DIR` | `./output` | 下载结果与 JSONL 索引目录 |
| `AUTO_SAVE_OUTPUTS` | `true` | 完成时自动下载；`false` 时由 get_result 按需下载 |
| `MAX_IN_FLIGHT` | `1` | 在途上限 1–64；提交结果未知的任务继续占位 |
| `MAX_QUEUED_JOBS` | `1` | 排队上限 1–64，不能大于 MAX_IN_FLIGHT |
| `JOB_TIMEOUT_MS` | `600000` | 单任务墙钟超时，范围 10000–86400000 毫秒 |

布尔值接受 `true/false/1/0`。相对目录基于进程工作目录解析，不基于 env 文件位置。配置示例使用 `./examples`，可直接运行无模型示例；正式使用应改为专用 workflows 目录。MCP 客户端配置请使用绝对路径。同一个数据库只运行一个 MCP 进程；ComfyUI 应位于可信本地网络，本版本没有认证配置。

## 导出 Workflow API JSON

在 ComfyUI 中启用开发者选项（部分前端版本需要），然后使用 **API 格式**保存/导出工作流。菜单名称随前端版本变化。正确格式是以节点 ID 为键，节点含 `class_type` 与 `inputs` 的对象；包含 `nodes/links` 的编辑器 JSON 不适用。加载器也接受 `{ "prompt": { ... } }` 包装。

将图文件及同目录 manifest 放入 `WORKFLOWS_DIR`，重启 MCP。自带 `examples/solid-color.json` 使用内置 `EmptyImage → SaveImage`，不需要模型，生成小 PNG。

## Manifest 参数白名单

自带 manifest 提供 color、width、height；最小示例如下：

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

名称须以字母开头，只用字母、数字、下划线和连字符，最长 64 字符。`workflowFile` 只能是同目录文件名；至少声明一个参数。参数必须指向已有标量输入，不能覆盖连线。

类型为 `string/number/integer/boolean/enum`；enum 必须提供非空字符串数组 `enum`。数值支持 min/max/step，step 相对 min 对齐，未设置 min 时相对 0。`required: true` 与 default 互斥；两者都未提供时，省略参数保留图中原值。整数 seed 可用 `special: "seed"`、`default: -1`；实际随机种子写入 resolved 参数。

未声明的参数会被拒绝；节点、模型名称及图的最终合法性由 ComfyUI 检查。导入前审核图及自定义节点。运行批次记录内容指纹，修改图或 manifest 后，待执行任务会暂停，避免悄悄使用新图。恢复旧批次需保留原始文件对；有意修改时建议使用新工作流名称并建立新批次。

## 四个工具与批量示例

| 工具 | 用途 |
|---|---|
| `list_workflows` | 工作流摘要；传 workflow 获取参数详情 |
| `run_workflow` | params 单任务或 runs 批量提交，立即返回 batch_id |
| `get_batch` | 状态计数与分页列表；limit 默认 20、上限 100，支持 offset/status |
| `get_result` | 单项结果 index 默认 0；mode=index 生成批次 JSONL 索引 |

以下 JSON 是 MCP 工具参数，在客户端中调用，不是终端命令。先向 `list_workflows` 传 `{"workflow":"solid-color"}` 查看说明。

向 `run_workflow` 提交单任务：

```json
{"workflow":"solid-color","params":{"color":255},"idempotency_key":"single-demo-1"}
```

向 `run_workflow` 提交批量：

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

params 与 runs 二选一。同一个幂等键和相同内容返回已有批次；同键不同内容报 `IDEMPOTENCY_CONFLICT`。批量中非法项独立记录，不妨碍其他项。`continue_on_error/max_attempts` 只适用于 runs 形式，默认继续执行、共一次尝试；只有确认远端失败后才允许重试，远端状态未知不会盲目重发。

## Batch 查询和结果索引

向 `get_batch` 传：

```json
{"batch_id":"<返回的 batch_id>","limit":20,"offset":0}
```

建议每 1–2 秒轮询并设置客户端截止时间。unknown、paused 单列，不计入失败。任务终结后向 `get_result` 传：

```json
{"batch_id":"<返回的 batch_id>","mode":"index","download":true}
```

工具只返回计数、complete、unavailable_outputs、index_path、updated_at。`OUTPUT_DIR/<batch_id>/results.jsonl` 按原始 index 每项一行，包括 label、状态、可取得的实际 seed、全部 outputs 和精简错误。输出包含 availability、字节数及可用时的绝对 local_path。

读取索引需要客户端另有本地文件权限，本 MCP 没有文件读取工具；如果 MCP 运行在另一台机器上，路径属于那台主机。`complete=true` 仅代表执行均已终结，还需检查 `unavailable_outputs === 0`。重复获取会重试缺失下载，不会重新生成。`download=false` 仅索引现有本地文件。索引是最新快照，不是不可变历史。单项详情使用 `{"batch_id":"<id>","index":0,"download":true}`，可查 resolved 参数和 outputs。

## 输入素材管理

通过 ComfyUI 界面上传源图片、音频、视频，或复制到 **ComfyUI 的 input 目录**。在 manifest 中将 LoadImage 等节点的文件名暴露为 string 参数，如 `"image":"source.png"`。文件由 ComfyUI 所在主机解析，不由 MCP 主机解析。

有待执行任务时保持素材名称和工作流版本稳定。本版没有上传工具、任意 URL 下载入口或模型管理器。数据库备份不包含源素材，应另行保存。

## MCP Client 配置

通用客户端配置示例；请将所有 `C:/mcp/...` 占位路径换成自己的绝对路径，写在客户端设置中，不提交个人配置。

```json
{
  "mcpServers": {
    "comfyui-light": {
      "command": "node",
      "args": ["C:/mcp/comfyui-light-mcp/dist/index.js"],
      "env": {
        "COMFYUI_URL": "http://127.0.0.1:8188",
        "WORKFLOWS_DIR": "C:/mcp/workflows",
        "DATA_DIR": "C:/mcp/data",
        "OUTPUT_DIR": "C:/mcp/output"
      }
    }
  }
}
```

tarball 安装时将 args 指向 `node_modules/comfyui-light-mcp/dist/index.js`。客户端找不到 Node 时使用 node.exe 的绝对路径。日志写入 stderr，stdout 专供 MCP。客户端断开/EOF 或 SIGINT/SIGTERM 会停止本地调度并关闭连接及数据库，不会取消远端生成；重启时会对账恢复。

## SQLite 位置、升级和备份

数据库位于 `DATA_DIR/comfyui-light.db`，使用 WAL。DATA_DIR 应位于本地可写磁盘；禁止多个 MCP 进程共享同一数据库。v1–v4（包括实验 P4.1 两种变体）事务迁移至 v5；缺少历史工作流指纹的 pending 会暂停，前次尝试未确认终态时先对账再考虑重试。重复打开 v5 幂等；未知新 schema 拒绝打开。v5 触发器拒绝旧程序连接写入，不能删除保护来降级使用。

升级前停止 MCP 客户端进程并等待退出，无写入期间复制整个 DATA_DIR，包括仍存在的 `-wal/-shm`。活跃数据库请使用 SQLite 在线备份 API，不能只复制 `.db`。OUTPUT_DIR、工作流/manifest 和 ComfyUI 输入素材另外备份。在线一致性备份示例，在已安装包目录执行：

```powershell
@'
import Database from "better-sqlite3";
const db = new Database(process.argv[2], { readonly: true });
try {
  await db.backup(process.argv[3]);
} finally {
  db.close();
}
'@ | node --input-type=module - 'C:/mcp/data/comfyui-light.db' 'C:/mcp/backups/before-upgrade.db'
```

该单引号 here-string 兼容 Windows PowerShell 5.1 和 PowerShell 7；路径含空格时需保留引号。先创建备份目录并使用新的备份文件名；该操作生成独立备份，不迁移原库。回退需使用相应升级前备份和独立 DATA_DIR，不能让旧程序写升级后的库。恢复备份后，未知远端任务仍需对账，不能直接重新提交。

## 常见错误

| 现象 | 排查 |
|---|---|
| 原生模块缺失、ABI 不匹配 | 使用 Node 22 x64 重跑 npm ci；允许安装脚本和预编译下载，或提供编译工具 |
| 找不到工作流、启动加载失败 | 检查目录、API JSON、同目录 manifest；修改后重启 |
| COMFY_UNREACHABLE、任务 pending | 检查地址及 HTTP/WebSocket；后端离线时 MCP 仍能启动 |
| INVALID_PARAMS / COMFY_REJECTED | 核对参数名及范围；查看节点错误摘要中的模型、节点、枚举问题 |
| submission_unknown / paused | 保留数据库和后端 history，恢复连接或原始工作流；不要直接改状态或盲目重提 |
| complete 但文件缺失 | 检查 unavailable_outputs 和逐输出 availability，恢复后端文件再取结果；不安全路径仍会被拒绝 |
| 客户端 JSON 解析失败 | 直接启动 node dist/index.js，避免 npm 横幅或其他 stdout 日志 |
| 数据库锁定、迁移失败 | 停止重复进程，检查目录权限，必要时使用一致性备份；保留原库 |

## 当前限制

只面向可信本地单实例，只有 stdio；没有 GUI、认证选项、工作流编辑、热加载、上传工具、取消工具、云编排或分布式调度。每批最多 200 项。恢复依赖后端 queue/history，证据被清理时可能长期保持未知。输出收集依赖 history 中的可下载文件引用，自定义节点格式可能不同。相同 seed 不能保证跨模型、节点、设备或版本复现。数据库、输出和索引无自动保留清理策略，需要自行备份和管理空间。

## 开发与包装边界

```powershell
npm run build
npm run typecheck
npm run lint
npm test -- --fileParallelism=false
npm pack --dry-run
```

历史真实后端测试在 COMFYUI_URL 可达时运行，会提交或中断任务，只能连接隔离测试实例；离线回归用 `COMFYUI_URL=http://127.0.0.1:1`。npm 白名单仅包含运行 JavaScript、无模型示例、配置模板、中英文 README 和许可证；不包含 tests、benchmarks、图片、数据库、日志或个人配置。源码验收报告位于 docs。第三方归属见 LICENSE、NOTICE、THIRD_PARTY_LICENSES.txt。
