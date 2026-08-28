# @deepseek-ai/dsh-host-probhub

[English](README.md) | 中文

ProbHub Workspace Schema v1 项目的 Host bridge。插件在现有 `webServer` 上注册 `/probhub` 和 `/probhub/api/*`，不打开第二监听端口，也不嵌入 ProbHub UI。API 请求携带不透明的 `sessionId` 选择器，并先在 live 或持久化 Session header 中验证，再使用其规范 `cwd`。只有 `<cwd>/.probhub/workspace.yaml` 存在时才接受工作区；不会回退到旧 metadata 或生成物。

`GET /probhub/api/overview` 执行只读 Core `status` 与 `lint` 并返回有界 JSON 投影；`GET /probhub/api/status` 和 `/lint` 暴露对应 Core 结果；`/probhub/api/problems/<id>/status` 和 `/lint` 将读取限定到经过验证的题目 ID。`GET /probhub/api/health` 报告共享 subprocess 能力是否挂载。非 GET、未知路由、缺失会话、不可访问 cwd 和缺少 Schema v1 工作区均以结构化 JSON fail closed。可选的 `@deepseek-ai/dsh-host-probhub/tools` Consumer 还提供面向模型的后台 `probhub_judge`、`probhub_stress`、`probhub_judge_qa` 和 `probhub_mutation` 任务：它们从当前 Session 派生工作区，要求调用者已经获准使用 `workspace-write`，调用 Core 的 `--json` CLI，并返回通用 `ctx.jobs` id；不接受任意路径、`--against`、`--fixate`、ZIP 路径或生成物。

Core 执行使用共享 `SubprocessRuntime`、调用者已经获准的 `workspace-write` `sandboxPolicy`/`sandbox` 隔离、有界收集输出和进程树终止；缺少任一 sandbox 服务时以 `sandbox_unavailable` fail closed。插件卸载时通过 Cordis effect 移除所有路由。

## Model Experience

### 后台验证工具

#### 模型看到的内容

当 Agent preset 挂载 `@deepseek-ai/dsh-host-probhub/tools` 时，可以使用四个验证工具：`probhub_judge`、`probhub_stress`、`probhub_judge_qa` 和 `probhub_mutation`。每个工具接收 Schema v1 题目 ID，并立即返回后台 job id。使用 `job_output` 收集有界 Core JSON，使用 `job_kill` 请求取消。

#### Token 影响

Consumer 挂载期间增加固定的工具 schema 和一段简短系统提示；任务输出受配置的字节上限约束，长度随结果变化。

#### KV Cache effect

只要 Consumer 配置不变，工具 schema 和引导保持前缀稳定；每个任务结果作为普通工具输出追加。

## Known Limitations and Deferred Work

- **传输会话选择器** — 浏览器提供不透明 session id；Host 针对 Harness 自有会话状态验证它，绝不将其作为路径或 cwd。
- **只读投影** — 题目摘要来自 Core JSON，刻意不包含写操作、预览、PDF、job 和生成物。
- **需要 workspace-write** — 验证任务要求调用者当前 Session 策略已经是 `workspace-write`；适配器不会静默提升只读会话，也不会绕过共享 approval 流程。
