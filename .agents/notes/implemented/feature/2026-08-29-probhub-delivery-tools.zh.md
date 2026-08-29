# Agent Note：ProbHub 交付工具

状态：已实现

[English](2026-08-29-probhub-delivery-tools.md) | 中文

## Problem

下游 ProbHub Bundle 需要面向模型的 checkpoint、seal、预览 generation、包验证和正式 build 操作，但不能把 Core 的状态、锁或发布所有权移入 DSH。模型还需要足够的结构化状态区分 incomplete、stale、missing、failed 和 published，同时不能接收本机路径或完整 Manifest。

## Decision

Host `tools` Consumer 将 Core 的 `checkpoint`、`seal`、`assemble` 和 `build` 映射为独占后台任务，将 `generation-status`、`report` 和 `verify-package` 映射为有界只读查询。验证任务也保持独占，因为它们可能写入缓存、evidence 或 stress 诊断。所有任务都从调用 Session 派生规范工作区，并要求现有的 `workspace-write` 策略；适配器不会提升权限，也不重新实现 Core 的锁、封存、事务或回滚。

正式 `probhub_build` 调用必须携带字面值 `confirm: true`，并通过标准 DSH approval 通道。工具不暴露 Core 的 `--skip-judge`、任意路径、stress 的 `--against` 或 `--fixate`。`probhub_verify_package` 只接受经过校验的题目 ID，从 `<canonical workspace>/<id>.zip` 派生路径，拒绝缺失、非普通文件、符号链接以及解析后离开工作区的路径，然后调用 Core 深度验证。

后台输出按操作类型投影。Checkpoint 和 generation 投影保留 ID、状态、哈希、完成标志和有界 missing 题目原因；build 保留批次及逐题状态摘要；只读查询保留状态、验证范围、有界计数和题目摘要。绝对路径、源码细节、secret 内容和完整 Manifest 均省略。只读 Core 调用转发工具取消信号，并等待共享进程树清理后再返回。

## Alternatives considered

**直接暴露 Core 原始 JSON。** 否决：报告、Manifest、诊断和包结果可能包含模型不需要的本机路径、源码或 secret 标识。

**允许所有操作并发运行。** 否决：Core 写任务共享工作区锁和生成状态；DSH 将它们标记为独占，只允许只读投影并行。

**把 `confirm: true` 视为足够的发布授权。** 否决：参数只记录意图，approval 通道才记录用户决定；没有 approval 通道时 build 会被拒绝。

## Consequences

- Agent 可以在不阻塞当前回合的情况下启动验证和交付任务，再通过通用 DSH job 工具收集或取消。
- 正式发布保持清晰区分，同时需要模型显式意图和部署提供的标准人工审批路径。
- 面向模型的结果足以路由后续工作，并且有界、路径安全；详细诊断仍保留在 Core 本地结果中。
- 下游包文档和生成的工具目录现在覆盖全部操作、权限类别、参数限制和发布副作用。
