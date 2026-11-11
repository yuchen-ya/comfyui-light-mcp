# ComfyUI Light MCP

[English](README.md) · [使用指南](docs/usage.zh-CN.md) · [Magpie 安装](docs/magpie.zh-CN.md) · MIT · 预发布版本 0.3.0-rc.2

本地 stdio MCP 服务器：让 AI 客户端运行你预先审核过的 ComfyUI 工作流。

- **工作流优先**：从 ComfyUI 导出一次 API 格式工作流，用 manifest 声明客户端可修改的参数白名单；此后每次调用只传参数，不传完整工作流图。
- **面向批量**：一次调用最多提交 200 个带标签的任务，支持幂等键、SQLite 持久化与中断后的保守恢复。
- **只有 4 个工具**：`list_workflows`、`run_workflow`、`get_batch`、`get_result`。工具返回摘要与分页状态，结果写入本地 JSONL 索引文件，不在对话中返回图像数据。

要求 Windows 11 x64 与 Node.js 22.12+；ComfyUI 需另行安装并保持运行。本项目不安装 ComfyUI、自定义节点或模型。

## 与官方 Comfy MCP 的区别

Comfy Org 官方的 [Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) 定位是让 AI 通用驱动 ComfyUI：基于 Python（依赖 comfy-cli），提供约 40 个工具，可以搜索官方模板库、获取并修改工作流图、对照本地安装校验图等，另有托管在 Comfy Cloud 的云端版本。

相比之下，本项目没有的这些能力是有意不做的：

- **不通过 MCP 编辑工作流。** 工作流就是 `WORKFLOWS_DIR` 里的普通 JSON 文件，与配套 manifest 放在一起，Agent 可以用自己的文件工具维护。下一次列表、运行或 dry-run 调用及调度器会检测变化并热加载；非法修改会阻止新执行，不会回退旧图。已排队的本地待提交任务若与保存的指纹不符，会暂停等待处理。
- **MCP 接口面保持最小。** 只有必须经过服务器的环节才走 MCP：提交白名单参数、调度批次、跟踪状态、收集结果。模板库、上传、模型管理都不在范围内；工作流文件始终是 Agent 可以直接读写的普通文件。

| | 官方 Comfy MCP | 本项目 |
|---|---|---|
| 定位 | 让 Agent 通用驱动本地（或云端）ComfyUI | 只运行预先审核的本地工作流 |
| 工作流来源 | 官方模板库，由 Agent 获取、组装、修改 | 本地导出的 API JSON + manifest 参数白名单 |
| 工具数量 | 约 40 个（搜索、组装、修改、校验等） | 4 个（列表 / 提交 / 查询 / 取结果） |
| 每次调用内容 | Agent 可发送并修改完整工作流图 | 只传白名单内的参数 |
| 技术栈与许可 | Python + comfy-cli，AGPL-3.0 或商业许可 | Node.js 22，MIT |
| 平台 | 跨平台 | 仅支持 Windows 11 x64 |

两者有重叠但并非互相替代：需要 Agent 通过 MCP 工具调用现场组装、修改工作流时，用官方版；工作流以普通文件维护、由 Agent 用自己的文件工具修改、MCP 只负责执行（含批量）时，本项目是一种更窄的选项。

## 给 AI Agent 的安装指引

按以下步骤为用户安装本服务器。目标环境：Windows 11 x64、Node.js ≥ 22.12、ComfyUI 已在运行（默认 `http://127.0.0.1:8188`）。

1. 克隆或解压源码后，在源码目录执行：

   ```powershell
   npm ci          # 不要加 --ignore-scripts；better-sqlite3 需要加载原生模块
   npm run build
   ```

2. 把下面的配置加入用户的 MCP 客户端设置，占位路径替换为实际绝对路径，环境变量按需修改：

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

3. 将工作流 API JSON 与对应的 `*.manifest.json` 放入 `WORKFLOWS_DIR`。首次可把 `examples/` 中两个文件一起复制进去。之后文件修改自动热加载；环境变量修改仍需重启服务器。
4. 用 `list_workflows` 查看，再向 `run_workflow` 传入 `{"workflow":"solid-color","dry_run":true,"params":{"color":255}}`。执行前检查错误、警告与 `unknown` 项；省略 `dry_run` 即可运行无模型示例。

手工配置时可直接以 `node .../dist/index.js` 启动；通过包启动的方式见 [Magpie 安装说明](docs/magpie.zh-CN.md)。stdout 保留给 MCP 协议；在终端直接启动只会等待 JSON-RPC 输入，属正常现象。全部配置项见 `config.env.example`，最小 manifest 示例见 `examples/`。

[使用指南](docs/usage.zh-CN.md) 包含本地 tarball 安装、配置、批量提交、结果索引、备份与恢复。同一数据库只运行一个 MCP 进程，ComfyUI 应位于可信本地环境；本项目没有后端认证配置，不承诺固定的 token 或费用节省。开发命令见 [CONTRIBUTING.md](CONTRIBUTING.md)。
