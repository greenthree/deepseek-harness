# Agent Note: ProbHub workbench report context

Status: implemented

[English](2026-08-30-probhub-workbench-report.md) | 中文

## Problem

ProbHub 工作台的只读题目列表能够选择题目，但题面和 AI 副驾驶缺少来自 Core 的数据覆盖、累计约束、Judge QA 与校准摘要。浏览器不能自行读取工作区生成物，也不能复制 Core 的报告逻辑。

## Decision

DSH Host 在现有 `/probhub/api/overview` 中调用 Core 的只读 `report`，并通过 `/probhub/api/problems/<id>/report` 提供单题读取。Host 只投影题目元数据、测试点计数、数据组角色、累计约束状态、校准/QA/mutation 状态和有限诊断代码与级别；源码路径、secret、evidence 正文及原始诊断消息不会跨越 Host。工作台在题面 Tab 显示测试点和累计约束，在健康 Tab 显示数据组、Judge QA、累计约束和校准状态，AI 副驾驶显示同一份选题上下文。所有请求继续从当前 Harness Session 的 canonical cwd 派生，并保持只读策略。

## Alternatives considered

**浏览器直接读取 `problem.md`、`probhub.yaml` 或报告文件：** 拒绝，因为这会绕过 Host 的 Session/canonical cwd 校验，并在浏览器侧复制 Schema 与脱敏规则。

**在 DSH 中重新实现数据组、QA 或校准判定：** 拒绝，Core 是唯一事实来源，重复实现会造成状态漂移。

**把完整 report JSON 原样转发给浏览器和模型：** 拒绝，报告包含路径、诊断正文和可能关联 secret 的细节；Host 必须执行字段级有界投影。

## Consequences

工作台和副驾驶可以在不写入规范源或正式生成物的情况下看到同一份 Core 验证上下文；Overview 会多启动一次只读 report 子进程，报告本身仍由 Core 计算。没有 ProbHub Host 路由的 profile 保留原有 DSH 会话外壳；已安装 Host 返回 `migration_required` 或其他真实错误时才显示 fail-closed 工作台提示。当前切片显示结构化摘要，不提供题面全文编辑、验证任务启动按钮或正式交付操作；这些仍属于后续 P1/P2。
