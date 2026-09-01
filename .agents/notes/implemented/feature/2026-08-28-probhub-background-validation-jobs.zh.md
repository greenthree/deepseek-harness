# Agent Note：ProbHub 后台验证任务

状态：已实现

[English](2026-08-28-probhub-background-validation-jobs.md) | 中文

## Problem

只读 ProbHub Host 路由无法在不阻塞模型回合的情况下执行验证；如果增加第二个任务注册表或在 DSH 中复制 Core 的锁与发布规则，就会分裂操作所有权。验证命令还会写入缓存、evidence 或 stress 诊断，因此需要和其他后台任务相同的工作区与取消纪律。

## Decision

ProbHub Host 包导出可选的 `tools` Consumer。Agent preset 挂载它后，模型可使用 `probhub_judge`、`probhub_stress`、`probhub_judge_qa` 和 `probhub_mutation`。每次调用都会校验 Schema v1 题目 ID，从调用者 Session 派生工作区，并注册一个 `ctx.jobs` 记录。工具立即返回 job id；`job_output` 和 `job_kill` 仍使用通用任务控制。

Consumer 通过共享 `SubprocessRuntime` 和调用者已经获准的 `workspace-write` 策略调用已安装的 ProbHub Core CLI。它不接受文件系统路径、任意 CLI 参数、`--against`、`--fixate`、ZIP 路径或生成物路径。只读 Session 会被拒绝，不会静默提升权限或绕过 approval。

适配器只负责启动子进程、维护每个任务的取消标记、有界收集 stdout 和映射结果。工作区锁、快照、缓存、evidence、stress 诊断和事务发布仍由 Core 负责。若取消请求与进程退出发生竞态，正常 Core JSON 结果仍记为 completed；Core 返回取消或进程在完成前被终止时记为 killed。进程失败、输出超限、取消请求失败和清理失败都保持 failed，不会被显示为验证成功。

## Alternatives considered

**通过 HTTP 路由暴露验证。** 否决：模型调用需要第二套传输，路由会成为任务所有者，而不是复用 Harness 的 Session 任务。

**在 DSH 中实现验证逻辑。** 否决：Core 是 Schema 解析、锁、evidence、进程策略和事务写入的唯一所有者；适配器应调用已安装的 CLI。

## Consequences

本包不增加第二个 HTTP 监听器、第二个任务注册表、常驻 worker、进度事件或新的 Core 协议。后台任务使用现有进程内 owner 隔离、准入、取消和清理语义。只读 `/probhub` 路由保持不变。
