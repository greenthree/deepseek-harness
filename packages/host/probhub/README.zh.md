# @deepseek-ai/dsh-host-probhub

[English](README.md) | 中文

ProbHub Workspace Schema v1 项目的只读 Host bridge。插件在现有 `webServer` 上注册 `/probhub` 和 `/probhub/api/*`，不打开第二监听端口，也不嵌入 ProbHub UI。API 请求携带不透明的 `sessionId` 选择器，并先在 live 或持久化 Session header 中验证，再使用其规范 `cwd`。只有 `<cwd>/.probhub/workspace.yaml` 存在时才接受工作区；不会回退到旧 metadata 或生成物。

`GET /probhub/api/overview` 执行只读 Core `status` 与 `lint` 并返回有界 JSON 投影；`GET /probhub/api/status` 和 `/lint` 暴露对应 Core 结果；`/probhub/api/problems/<id>/status` 和 `/lint` 将读取限定到经过验证的题目 ID。`GET /probhub/api/health` 报告共享 subprocess 能力是否挂载。非 GET、未知路由、缺失会话、不可访问 cwd 和缺少 Schema v1 工作区均以结构化 JSON fail closed。任何端点都不会写入规范源或产物，也不暴露 judge、stress、build、distribute 或 job。

Core 执行使用共享 `SubprocessRuntime`、只读 `sandboxPolicy`/`sandbox` 隔离、有界收集输出和 deadline；缺少任一 sandbox 服务时以 `sandbox_unavailable` fail closed。插件卸载时通过 Cordis effect 移除所有路由。

## Model Experience

None，因为此 Host-only bridge 不贡献模型上下文。

#### KV Cache effect

None；此包不组装模型输入。

## Known Limitations and Deferred Work

- **传输会话选择器** — 浏览器提供不透明 session id；Host 针对 Harness 自有会话状态验证它，绝不将其作为路径或 cwd。
- **只读投影** — 题目摘要来自 Core JSON，刻意不包含写操作、预览、PDF、job 和生成物。
