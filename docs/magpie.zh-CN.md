# 通过 Magpie 安装

[English](magpie.md) · [使用指南](usage.zh-CN.md) · [项目简介](../README.zh-CN.md)

可以直接安装提供的 tarball。下方 npm 命令需要对应版本已在 npm 发布，Magpie 发现还需要对应的 Registry 条目；如果包或条目尚不可用，请使用本地 tarball 方式。

## 使用前准备

需要 Windows 11 x64 和 Node.js 22.12+。请另行安装并启动 ComfyUI，准备工作流所需的模型和自定义节点；npm 安装须允许运行 native SQLite 的安装脚本。

准备一个目录，放入工作流 API JSON 与对应的 `*.manifest.json`。首次可以把随包 `solid-color` 的两个文件复制进去，运行不需要模型。本服务器不会安装 ComfyUI、下载模型或替你建立工作流库。

## 添加已发布条目

发布后，在 Magpie 搜索 `comfyui-light-mcp`，核对仓库为 [yuchen-ya/comfyui-light-mcp](https://github.com/yuchen-ya/comfyui-light-mcp)、Registry 名称为 `io.github.yuchen-ya/comfyui-light-mcp`，然后选择 npm/stdio 项。

请自行填写以下四项：

| 配置 | 应填值 |
|---|---|
| `COMFYUI_URL` | 已启动且可信的 ComfyUI HTTP(S) 地址，常见为 `http://127.0.0.1:8188`。HTTP 和 WebSocket 都要可达，不支持凭据、查询参数或 fragment。 |
| `WORKFLOWS_DIR` | 已存在的绝对目录，包含审核后的工作流 JSON 与 manifest 文件对。 |
| `DATA_DIR` | 可写绝对目录，用于 SQLite 状态；不同并发 MCP 进程使用不同目录。 |
| `OUTPUT_DIR` | 可写绝对目录，用于下载文件和 JSONL 索引。 |

含空格路径直接填写完整值，不要额外加引号。这些目录位于运行 MCP 服务器的电脑。Magpie 不会替你选择地址、复制工作流或准备模型。

启动命令应固定具体版本。本次预发布在 npm 发布后的命令是：

```text
npx -y --package comfyui-light-mcp@0.3.0-rc.2 comfyui-light-mcp
```

请检查客户端实际使用的命令，不要假设 `latest` 指向这个候选。能找到条目不等于已经连上你的 ComfyUI，上述四项仍需与本机安装一致。

## 安装本地 tarball

按[使用指南](usage.zh-CN.md#安装本地候选包)把提供的 tarball 安装到独立目录，无需源码目录。手工配置时，可将下面的 command/args/env 内容放入客户端的 stdio 条目：

```json
{
  "command": "node",
  "args": ["C:/mcp/install/node_modules/comfyui-light-mcp/dist/index.js"],
  "env": {
    "COMFYUI_URL": "http://127.0.0.1:8188",
    "WORKFLOWS_DIR": "C:/mcp/my workflows",
    "DATA_DIR": "C:/mcp/my data",
    "OUTPUT_DIR": "C:/mcp/my output"
  }
}
```

这些是通用占位路径，请替换为自己的路径与 ComfyUI 地址。Windows 安装后也会提供 `node_modules/.bin/comfyui-light-mcp.cmd`。

程序读取进程环境，不会自动寻找 `.env`。如需 env 文件，应显式给 Node 添加 `--env-file=<绝对文件路径>`。相对路径基于进程工作目录，而非包目录或 env 文件目录，因此客户端配置应填写绝对路径。

## 可选配置与首次使用

未传入时，程序采用 `AUTO_SAVE_OUTPUTS=true`、`MAX_IN_FLIGHT=1`、`MAX_QUEUED_JOBS=1`、`JOB_TIMEOUT_MS=600000`。这些是程序默认值，不表示 Magpie 已经填写可选字段。需要修改时，请通过客户端支持的服务器设置编辑环境变量；队列上限不能大于在途上限。详见[配置说明](usage.zh-CN.md#配置)。

连接客户端后先调用 `list_workflows`，再向 `run_workflow` 传入：

```json
{"workflow":"solid-color","dry_run":true,"params":{"color":255}}
```

执行前检查错误、警告和 `unknown` 项，省略 `dry_run` 即可运行示例。直接在终端启动只会等待 JSON-RPC，不会打开网页。stdout 保留给 MCP，诊断看 stderr。

离线安装需要已有的依赖包和 native addon 缓存，仅有 tarball 不能补齐缺失依赖。本服务器没有后端认证配置，应连接可信的 ComfyUI 地址。
