# @deepseek-ai/dsh-host-probhub

[English](README.md) | 中文

ProbHub Workspace Schema v1 项目的 Host bridge。插件在现有 `webServer` 上注册 `/probhub` 和 `/probhub/api/*`，不打开第二监听端口，也不嵌入 ProbHub UI。API 请求携带不透明的 `sessionId` 选择器，并先在 live 或持久化 Session header 中验证，再使用其规范 `cwd`。只有 `<cwd>/.probhub/workspace.yaml` 存在时才接受工作区；不会回退到旧 metadata 或生成物。

`GET /probhub/api/overview` 执行只读 Core `status` 与 `lint` 并返回有界 JSON 投影；`GET /probhub/api/status` 和 `/lint` 暴露对应 Core 结果；`/probhub/api/problems/<id>/status` 和 `/lint` 将读取限定到经过验证的题目 ID。`GET /probhub/api/health` 报告共享 subprocess 能力是否挂载。非 GET、未知路由、缺失会话、不可访问 cwd 和缺少 Schema v1 工作区均以结构化 JSON fail closed。可选的 `@deepseek-ai/dsh-host-probhub/tools` Consumer 还提供面向模型的验证、交付和只读操作：所有操作从当前 Session 派生工作区并调用 Core 的 `--json` CLI；写任务要求调用者已经获准使用 `workspace-write`，只读查询使用现有只读策略。`probhub_build` 还要求 `confirm: true` 和标准 DSH approval 通道，因为它会发布正式 PDF、ZIP、metadata 与 Manifest。任意路径、`--against` 和 `--fixate` 均不可用。

Core 执行使用共享 `SubprocessRuntime`、调用者已经获准的 `workspace-write` `sandboxPolicy`/`sandbox` 隔离、有界收集输出和进程树终止；缺少任一 sandbox 服务时以 `sandbox_unavailable` fail closed。插件卸载时通过 Cordis effect 移除所有路由。

## Model Experience

### ProbHub 工具

#### 模型看到的内容

挂载 Consumer 后，模型可通过当前 Session 工作区使用验证、交付和有界只读操作。

##### Tool matrix

```markdown
When @deepseek-ai/dsh-host-probhub/tools is mounted in an agent preset, these operations are available:

| Tool | Access | Purpose |
| --- | --- | --- |
| probhub_judge, probhub_stress, probhub_judge_qa, probhub_mutation | workspace-write job | Run validation and write Core-managed caches, evidence, or stress diagnostics. |
| probhub_checkpoint, probhub_seal, probhub_assemble | workspace-write job | Create a checkpoint, seal a problem, or assemble an isolated preview generation. assemble may create a draft checkpoint when one is missing. |
| probhub_build | workspace-write job + confirm: true + approval | Publish formal PDF, ZIP, metadata, and Manifest artifacts after Core's sealed-revision checks. |
| probhub_generation_status, probhub_report, probhub_verify_package | read-only query | Return bounded generation, report, or package-verification projections. verify-package derives the ZIP from the canonical workspace and accepts only problem_id. |

Background tools return a generic job id immediately. Use job_output to collect bounded Core JSON and job_kill to request cancellation. Write jobs are exclusive; read-only queries may overlap.

validation jobs: probhub_judge, probhub_stress, probhub_judge_qa, probhub_mutation
delivery jobs: probhub_checkpoint, probhub_seal, probhub_assemble, probhub_build
read-only queries: probhub_generation_status, probhub_report, probhub_verify_package
formal publication: probhub_build requires confirm: true and the DSH approval channel
```

#### Token 影响

Consumer 挂载期间增加固定的工具 schema 和一段简短系统提示；任务输出受配置的字节上限约束，长度随结果变化。

#### KV Cache effect

只要 Consumer 配置不变，工具 schema 和引导保持前缀稳定；每个任务结果作为普通工具输出追加。

## Known Limitations and Deferred Work

- **传输会话选择器** — 浏览器提供不透明 session id；Host 针对 Harness 自有会话状态验证它，绝不将其作为路径或 cwd。
- **有界投影** — 面向模型的查询和 job 输出保留状态、revision、generation、批次和验证摘要，但省略绝对路径、源码细节、secret 与完整 Manifest。
- **正式发布** — `probhub_build` 是唯一发布正式生成物的工具，必须提供 `confirm: true` 并通过标准 DSH approval；锁、封存、事务和回滚仍由 Core 负责。
- **ZIP 路径安全** — `probhub_verify_package` 只接受题目 ID。Host 从规范工作区派生 `<canonical workspace>/<problem_id>.zip`，拒绝缺失、非普通文件和链接后再调用 Core。
- **需要 workspace-write** — 验证任务要求调用者当前 Session 策略已经是 `workspace-write`；适配器不会静默提升只读会话，也不会绕过共享 approval 流程。
