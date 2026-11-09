# Daily v1 benchmark

本目录是 Task006 的可审阅 pilot 交付，产品实现未修改。[报告](report.md)给结论与边界，[summary.json](results/summary.json)保留逐任务数字，[环境锁](environment.lock.json)与[输入锁](inputs.lock.json)记录来源。

完成 A1/A2/A4 每组各一次 pilot；A3 在共同环境准备时离线克隆失败，未开始任一被测 arm。原定正式三组重复和100项未运行；后续减量实测见 [v2 报告](../daily-v2-fast/report.md)。共92次图像提交，批准上限104；共享raw输出、A4缓存及观察覆盖缺口均在报告披露。不得把准备连通性或静态检查当正式成绩。

## 材料及边界

- prompts：中性任务模板；为每个新会话替换逻辑占位，给同等权限、预算和选定服务器文档。
- fixtures：A1参数、A2矩阵/盲评量表、A4中性20文件及素材。organizer-only 是组织者真值，不能复制到被测会话；仅将 case 自己的输入复制到独立目录。
- validators：只读验收和明确边界；参数图、文件解码和原件保全检查不替代盲评或完整观察。
- observers：被动HTTP/WS观察、宿主usage元数据白名单提取、已验证的Comfy后端审计v2。读取审计说明后仅在隔离clone接入；日志含完整明文请求，留在.analysis。
- evidence/redacted：脱敏准备、运行及验收数据；[evidence/images](evidence/images/manifest.json) 和 [evidence/traces](evidence/traces/PUBLICATION.json) 提供图像及轨迹的公开副本。图片原件、本地索引、数据库、真实任务路径和未经处理的完整日志不提交。
- formal：事前提出的三组配对顺序和新seed，状态not_authorized_not_run，不是成绩。

## 必要检查

```powershell
npm run build
npm run lint
npx vitest run tests/unit tests/http-mock tests/ws --fileParallelism=false
node --test benchmarks/daily-v1/validators/validate-check.mjs benchmarks/daily-v1/observers/prompt-observer-check.mjs benchmarks/daily-v1/observers/collect-host-usage-check.mjs
COMFY_PYTHON -m unittest discover -s benchmarks/daily-v1/observers -p test_comfy_audit.py -v
```

离线测试不执行真实ComfyUI测试目录。COMFY_PYTHON是已有Python环境的逻辑别名，不要求安装。宿主用量提取的参数为SESSION_DIR、当前父线程ID、输出JSON；仅采集本任务组织者快照与指定直接子会话的数值元数据，不能复制消息、推理正文、账户、额度或其他会话。token_count是宿主记录，不保证最终计费，缓存与reasoning不可重复相加。[口径](https://developers.openai.com/api/docs/guides/agents-api/observability)

pilot 当时的停止条件是不自动修改产品、合并或发布，且在批准预算和重新冻结前不开始后续生成。A3受批准的停止条件约束，不能因想完成对照而联网补包。
