# Daily v2 fast：A1/A2 对照

本版本按已批准预算运行：A1 一组配对 40 张，A2 两组配对各 32 张，共 104 张任务图；六次运行各暖机一张，共 110 张，上限 114 张。达到预算或任务时限停止；未知提交结果不盲目重试。旧版证据保持独立。

执行顺序取原随机顺序（种子 `388226659`）的指定子集：`a2-b-r1`、`a2-a-r1`、`a1-a-r1`、`a1-b-r1`、`a2-a-r2`、`a2-b-r2`。每次为全新会话、单臂 MCP 和独立的工作流输入、模板快照、ComfyUI user/input/output/temp、MCP 数据、CLI profile 与缓存；按顺序在同一 GPU 串行执行。每次使用独立 ComfyUI 进程和一次对称的 4 steps、CFG 2.5 暖机；暖机计入预算但不算正式成绩。不同进程仍可能共享操作系统和磁盘缓存，应披露，不能声称完全冷缓存。

模板 `fixtures/qwen-fast.json` 使用固定三件模型、512×512、euler/simple、基础 steps 4、CFG 2.5。A1 参数为 `fixtures/a1-items-20.json`，后续索引追问不得重新生成。A2 为步骤 `[2,4,6]` 和 CFG `[2,2.5]` 的六种组合，`cfg-4` 是基准；每组两训练 seed，共 12 张，再对基准和训练选出的候选各用两个不同验证 seed，共 4 张。两个重复使用不同 seed；同一重复的 A/B 使用完全相同的输入。每轮参数表是 `fixtures/a2-repeat-{1,2}.json`。质量由预设量表的独立盲评判定；没有盲评时标注待确认，不能宣称质量等价。

评测材料与结果须保留版本、任务计数、完整后端审计、真实工具调用和可获取的模型 usage；不可获得的数据填 null。后端日志包含原始请求及响应，只存私有 `.analysis`，先脱敏再公开。`environment.lock.json` 已在首项任务前核对实际 runtime tools/list、instructions、模型SHA256、679种节点及硬件状态并冻结。官方instructions因明确配置测试目标而增加的路由后缀已单列，未改变官方源码或依赖版本。模型及既有 Python 环境按只读方式使用，系统权限层未强制只读。

控制脚本仅在评测私有目录：`manage-comfy.ps1 -RunId <run_id> -Action Start|Stop`。它检查固定源码、审计模块与 8190 端口，按 run 独立路径启动并仅停止能验证归属的进程；启动后由组织者只读检查服务就绪和日志，再安排暖机。官方 CLI 的 `set-default` 仅可从对应 run 的 `launch.json` 环境变量启动，配置保存在该 run 的 profile 中。不得裸运行 CLI 改写默认 profile。模板前后快照位于每次输入目录的 `workflow.json` 与 `workflow.before.json`。

双方使用同一通用持久stdio桥（mcp-bridge.mjs）：初始化和tools/list各一次预取计数；通过相同HTTP接口读取instructions、工具摘要/按名schema并执行单个MCP调用。桥不处理参数、批量调度、重试或结果，所有任务脚本由被测Agent编写。宿主使用按需工具读取，因此完整schema体积不是实际模型上下文；真实usage另采集。Agent若在任务中主动清理显存，其调用和缓存变化计入本轮。


本版本已完成。[报告](report.md)、[结果JSON](results/summary.json)、[结果CSV](results/summary.csv)、[最终检查](evidence/redacted/final-checks.json)记录110次提交及全部验收。A2画质与可用提速仍待独立判定。所有测试服务已停止。

