# @deepseek-ai/dsh-host-probhub

[English](README.md) | 中文

ProbHub Workspace Schema v1 项目的 Host bridge。插件在现有 `webServer` 上注册 `/probhub` 和 `/probhub/api/*`，不打开第二监听端口，也不嵌入 ProbHub UI。API 请求携带不透明的 `sessionId` 选择器，并先在 live 或持久化 Session header 中验证，再使用其规范 `cwd`。只有 `<cwd>/.probhub/workspace.yaml` 存在时才接受工作区；不会回退到旧 metadata 或生成物。

`GET /probhub/api/overview` 执行只读 Core `status`、`lint` 和 `report`，为工作台返回有界 JSON 投影；`GET /probhub/api/status` 和 `/lint` 暴露对应 Core 结果；`/probhub/api/problems/<id>/status`、`/lint` 和 `/report` 将读取限定到经过验证的题目 ID。`GET /probhub/api/problems/<id>/preview?sessionId=...` 只从当前有效的隔离 preview generation 提供该题 PDF；Host 根据 Core 的 `generation-status` 重建路径，拒绝过期/无效 generation、符号链接、路径穿越、哈希不匹配和超过预览字节上限的文件，且不会暴露文件系统路径。`GET /probhub/api/source-targets?sessionId=...&problemId=...` 返回单题可编辑 UTF-8 文件的有界白名单。`GET /probhub/api/source?sessionId=...&problemId=...&target=statement` 读取其中一个源文件、目标对应的 Core revision 和影响预览；`POST /probhub/api/source?sessionId=...&problemId=...` 只有在 live Session 已经处于 `workspace-write` 且 `expectedRevision` 仍匹配时才保存，并使用同卷原子替换，冲突时返回 `source_conflict`。目标列表覆盖 `problem.md`、`probhub.yaml`、代码文件、样例输入和正式输入，不会暴露答案文件、链接、目录或任意路径。`POST /probhub/api/jobs?sessionId=...&problemId=...` 会为 live workspace-write Session 启动一个白名单中的非发布 Job：`judge`、`stress`、`judge-qa`、`mutation`、`checkpoint` 或 `seal`；`assemble` 是工作区级操作。stress 的 `rounds` 和 `seed` 受限，工作台默认使用 1000 轮和 seed 12345。`POST /probhub/api/jobs/cancel?sessionId=...&jobId=...` 可请求取消当前 Session 的任务；任务进入终态后重复取消也保持幂等。UI 通过既有 Session 任务流接收 Job 状态，并为运行中的任务提供取消按钮。本切片的工作台路由尚未开放正式 Build。`POST /probhub/api/context?sessionId=...&problemId=...` 会根据当前工作区校验选中的题目，并把有界的 report/status 摘要绑定到 live Agent 的 scoped prompt context；下一次模型请求会通过 Harness 的持久运行时上下文收到这份摘要。`GET /probhub/api/health` 报告共享 subprocess 能力是否挂载。未知路由、不支持的方法、缺失会话、不可访问 cwd 和缺少 Schema v1 工作区均以结构化 JSON fail closed。可选的 `@deepseek-ai/dsh-host-probhub/tools` Consumer 还提供面向模型的验证、交付和只读操作。成功的 ProbHub 工具结果会通过既有 remote-event carrier 发出有界的 `probhub/tab-requested` 工作台定位提示；客户端只接受当前 Session 且存在于最新 overview 的题目。所有操作从当前 Session 派生工作区并调用 Core 的 `--json` CLI；写任务和源文件保存都要求调用者已经获准使用 `workspace-write`，只读查询使用现有只读策略。`probhub_build` 还要求 `confirm: true` 和标准 DSH approval 通道，因为它会发布正式 PDF、ZIP、metadata 与 Manifest。任意路径、`--against` 和 `--fixate` 均不可用。Report 只保留题目元数据、测试点计数、数据组职责、累计约束、校准和 QA 状态，以及不含源码路径和 evidence 正文的有界诊断。

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
- **选题上下文** — 工作台会把经过校验的一份题目摘要绑定到 live Agent 的 scoped prompt context；下一次模型请求通过持久运行时上下文收到它，并可用 `probhub_report` 刷新。
- **规范源编辑器** — 题面编辑器用精确 Core revision 栅栏读取并保存 `problem.md`。Host 不接受任意路径，响应会明确 source/data 与正式产物失效影响，UI 可据此继续显示 stale 状态。
- **正式发布** — `probhub_build` 是唯一发布正式生成物的工具，必须提供 `confirm: true` 并通过标准 DSH approval；锁、封存、事务和回滚仍由 Core 负责。
- **ZIP 路径安全** — `probhub_verify_package` 只接受题目 ID。Host 从规范工作区派生 `<canonical workspace>/<problem_id>.zip`，拒绝缺失、非普通文件和链接后再调用 Core。
- **需要 workspace-write** — 验证和交付任务要求调用者当前 Session 策略已经是 `workspace-write`；适配器不会静默提升只读会话，也不会绕过共享 approval 流程。工作台暂未开放正式 Build。
- **隔离预览** — 工作台 PDF 页只消费经过 Core 校验的 generation；过期、不完整、超限、链接或被篡改的预览保持不可用，不回退到正式产物。
