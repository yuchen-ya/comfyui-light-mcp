# A3 隔离安装对照：历史授权提案

> 历史提案，保留原拟议范围和当时预算。后续准备中离线克隆失败并按停止条件终止；未安装节点或运行 A3。现状见 [pilot 报告](report.md)。

**申请一次授权：**按本文固定范围，在评测目录创建两套独立环境，从本机固定来源构造一个缺失 KJNodes 与 `color-matcher` 的共同起点，分别完成诊断、安装、测试实例重启、一次图像处理及三项回归，收集证据并在完成或触发停止条件时停止。该授权不包含生产环境修改、网络下载、其他节点安装、模型下载、驱动变更或 A3 之外工作。提案提出时尚未创建 A3 环境、安装或运行 A3。

## 固定材料与差异

- 基础 ComfyUI：`COMFY_SOURCE` 本机 checkout 对应 SHA `5cc4b870094c89090db54bd8d12649dcaf89f2ba`；用独立本地 clone，不复制 dirty 工作树。A/B 各有独立 checkout、user/input/output/temp、custom_nodes 和 Python 环境。
- 节点来源：[ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) SHA `35e5956193769d18a13136cdedb73a36a05c73e6`，源自本机现有 git 对象；不能复制该仓库的未跟踪文件。节点包源码总计约 2,842,875 字节，不含 Git 对象开销。
- 新工作流：组织者按固定节点源码输入契约构造的 [color-match-api.json](a3-proposal/color-match-api.json)，SHA256 `92e50671917ba5aa2918967425f3de7dcd4997098f78b91c379e4339411ee544`。它通过两张中性色彩图执行 `LoadImage × 2 → ColorMatch(method=hm, strength=1) → SaveImage`；素材由组织者预先生成相同渐变图、冻结 SHA256 后复制入两组输入目录。不存在素材时停止，不以私人素材代替。
- 精确依赖闭包见下表。`color-matcher` 在源环境中已安装；本实验只在**评测副本**制造缺失，在运行前两组分别验证不存在。它是受控测试起点，不能称为自然发现的真实缺失。其他依赖保留现有二进制，不从网络安装；不得改动生产环境、全局 Conda 配置、驱动或 Torch/CUDA。

| 包 | 已安装版本 | 包 | 已安装版本 |
|---|---|---|---|
| color-matcher | 0.6.0 | pillow | 11.3.0 |
| matplotlib | 3.10.7 | mss | 10.1.0 |
| opencv-python-headless | 4.12.0.88 | numpy | 2.2.6 |
| ddt | 1.7.2 | docutils | 0.22.4 |
| imageio | 2.37.2 | packaging | 25.0 |
| contourpy | 1.3.2 | cycler | 0.12.1 |
| fonttools | 4.61.0 | kiwisolver | 1.4.9 |
| pyparsing | 3.2.5 | python-dateutil | 2.9.0.post0 |
| six | 1.17.0 | | |

这是以上五个节点包直接要求的包及其默认依赖、按源环境 Python 3.10 当前平台标记递归解析的已安装分发包版本，不含未启用 extras；源码未声明的可选运行时依赖及后续兼容性不能由此保证。原始本地清单记录 359 个源环境 Python 分发包；公开的 [baseline-distributions.json](a3-proposal/baseline-distributions.json) 仅列本提案相关的 17 包。完整版本及完整性检查需要私有原始证据；公开子集不是文件完整性锁或 Conda 软件包闭包。启动和安装前必须重新采集、对比并冻结完整 Conda/Python 清单和文件证据；变化则停止重新审批。源环境只读 `pip check` 已确认一个既存冲突：`descript-audiotools==0.7.2` 要求 `protobuf>=3.9.2,<3.20`，实际为 `protobuf==6.33.1`。冻结该冲突并单列风险；A/B 克隆检查只能出现同一既存冲突，任何新增冲突均停止，不能自动升级、卸载或修改生产包。核心工作流仍须实际通过。

## 隔离准备与可执行操作

使用本机 Conda 25.9.1 的原生帮助已确认：`--clone` 复制环境，`--copy` 使用文件副本替代软/硬链接，`--offline` 禁止 Conda 网络访问。不得使用 `--system-site-packages`、硬链接或共享可写的 custom_nodes/site-packages；不得直接目录复制后假定 Conda 前缀可迁移。命令中均为评测目录逻辑别名：

```powershell
conda create --offline --copy --no-default-packages --clone SOURCE_ENV --prefix A3_A_ENV
conda create --offline --copy --no-default-packages --clone SOURCE_ENV --prefix A3_B_ENV
git clone --no-hardlinks --no-checkout COMFY_SOURCE A3_A_COMFY
git -C A3_A_COMFY checkout --detach 5cc4b870094c89090db54bd8d12649dcaf89f2ba
git clone --no-hardlinks --no-checkout COMFY_SOURCE A3_B_COMFY
git -C A3_B_COMFY checkout --detach 5cc4b870094c89090db54bd8d12649dcaf89f2ba
```

仅在评测目录设置进程级 `CONDARC` 与 `CONDA_PKGS_DIRS`，不写用户配置或全局缓存；先从现有本机缓存复制克隆所需的包到私有缓存（不使用硬链接），离线所需文件缺失则停止，不联网补齐。分别验证实际前缀、Python/Torch/CUDA 版本、359 包清单和 baseline `pip check`；扫描与源环境及两组之间的文件 ID/重解析点，确认不存在共享硬链接、指回源环境的可写链接以及复制目录之外的可写配置；检查全部绝对路径重定位和 Python 导入。若有残留、缺失包、链接、兼容问题或 `pip check` 出现既存冲突之外的新问题则停止；禁止静默使用源 site-packages。克隆对 pip 管理包的处理尚未经本机实测，这些检查是必需门槛，不将 Conda 的 `--copy` 文档当成它们已通过的证据。

共同起点只移除两份评测副本中的 `color_matcher` 包目录和 `color_matcher-0.6.0.dist-info`，在移除前逐文件复制这两项到各自私有的本地归档并记录 SHA256、归属与路径；不动其他包、脚本或共享 `tests`。具体原因：该分发包 RECORD 的 `tests/__init__.py` 和对应 pycache 同时被 `swarm`、`ultralytics` 记录，直接 `pip uninstall` 会有误删其他包文件的风险。操作前确认这两个目录下无其他分发包声明的重叠文件；若发现重叠、目录外链接或归档不能独立校验则停止。两组执行 `importlib.metadata.version('color-matcher')` 与 `importlib.util.find_spec('color_matcher')`，要求均分别抛出 PackageNotFoundError、返回 None；并确认 KJNodes 未放入两份 custom_nodes。基础依赖验证时允许仅这项预期缺失，不把其他依赖错误当作正常状态。

两组分别从本机镜像获同一 SHA 节点包到各自 custom_nodes；从各自本地归档恢复上述两个目录，逐文件比对哈希、重验 `color-matcher==0.6.0` 和依赖闭包、运行 `pip check` 并确认无新增冲突。这是**本地文件归档恢复**而非 pip 或 MCP 原生在线安装，须在计分和能力来源中标为 `shell_fallback`，不得把它记为 MCP 原生安装；两组获得等价镜像及恢复材料，独立记录成本。此方式不新下载依赖，也不将第三方源码放进公开仓库。安装期间如果被测 Agent 请求其他包、全局路径或网络，停止并记录为超出授权，不自动修复。

## 启动、任务与验收

仅使用 `127.0.0.1:8192`（A）与 `127.0.0.1:8193`（B），启动前再次核实空闲；仅允许停止、启动、重启这两套隔离测试实例，不能重启生产或既有 8190。按各组独立 base/user/input/output/temp、CLI 配置及进程级缓存启动，使用各自 Python 和 checkpoint；默认禁用 Manager、partner nodes，使用 `--offline`（仅前端 CSP/partner 节点限制，不是网络隔离）。安装前允许启动以验证节点缺失；安装后允许重启各自实例，不能共享可写 custom_nodes。既有模型仅按只读任务授权访问：不得写入源模型目录、不改源模型 ACL 或复制大模型；这不是操作系统级的强制只读隔离。

两组同样先运行并保存三项既有工作流的成功基线，然后安装节点包与缺失依赖、执行新图一次，再运行相同三项回归；逐项验证参数、可解码输出、提交句柄、原模板和环境差异。回归材料为：①已有 `qwen-image` 示例，源文件 SHA256 `f71eacf6c85f9922774d29fe6becc472e7eb793f14fff379ea213309fc97266d`；②已验证的本机 image-edit 历史图；③已准备的 ImageInvert 图。后两项的固定来源、哈希、输入及实际成功基线由组织者提供；三项任何一项未先实跑通过或材料未冻结时停止，不能把计划写成已通过。新图中的 `ColorMatch` 会捕获算法异常返回原图，所以须另检查日志无计算异常、输出可解码且尺寸正确、相对目标输入颜色有预定的非零变化，不能只凭文件存在验收。新图和全部回归计入用户已批准 pilot 的图像预算。

## 容量、范围与停止条件

| 项目 | 估算或上限 | 依据与限制 |
|---|---:|---|
| 两份 Python 环境 | 约 18.44 GiB | 源环境文件逻辑大小 9,898,503,228 字节，逐文件复制；不含额外缓存或文件系统分配开销 |
| 两份 ComfyUI 源码 | 最多以约 4.91 GiB 粗估 | 源工作区排除模型、custom_nodes、用户及输出后 2,633,494,582 字节；固定提交实际可能不同，不含 Git 对象开销 |
| 基础环境额外快照 | 约 9.22 GiB（如需要） | 仅在最多三份环境内使用，不自动创建；两组独立克隆优先 |
| 离线 Conda 缓存副本、日志与归档 | unknown | 创建前统计；若可用缓存不足则停止，不联网 |
| 生成输出 | 用户上限 10 GiB | 严格计入既有 pilot 总限额 |
| 下载 | 0（仅本机离线材料） | 缺材料即停止，不进行网络补充 |
| 当前磁盘可用 | 314.57 GiB | 只读调查时点；执行前重新核对并留足空间 |

提案时总上限为用户批准的 88 张，每任务 60 分钟、输出合计 10 GiB。原 88 张估算只含两次连通性和任务输出，漏计了独立缓存重置后的四次暖机、A4 六组候选各一次准备验证，以及 A3 两组各三项安装前回归基线。完整 pilot 的明确预算因此是最多 104 张：连通性 2 + 暖机 4 + A1 40 + A2 32 + A3 14 + A4 准备验证 6 + A4 任务 6。未获追加批准前不能超过 88 张；不因某组失败而临时放宽其单任务预算。A3 的磁盘另申请最多 40 GiB（两份环境、源码、私有缓存和归档合计；不包含既有模型或输出），下载为 0，超出立即停止。

任何文件链接隔离失败、校验不一致、版本不匹配、监听冲突、依赖新增冲突、材料缺失、超预算或生产资源被触及时立即停止，保留诊断证据，绝不自动清理或修改原环境。模型只按本任务的只读授权访问；不改源模型 ACL，现有用户的系统级写权限并未因此撤销，须将此限制单列，不能宣称实现了操作系统级写保护。申请授权覆盖上述范围及必要条件下暂停；不覆盖对缺失项的自主扩大安装。

