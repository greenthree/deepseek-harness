# Agent Note: ProbHub 正式交付门禁

Status: implemented

[English](2026-08-30-probhub-delivery-gate.md) | 中文

## Problem

DSH 工作台可以显示验证和预览状态，但没有一个有界、统一的结果说明正式 ProbHub 发布是否已经具备条件。用户或模型看到分散的状态后，仍可能漏掉未完成 generation 或 sealed revision 不一致，就请求正式发布。

## Decision

Host 新增只读 `delivery-check` 路由和面向模型的 `probhub_delivery_check` 工具。两者组合 Core 的 `status`、`report`、`generation-status`、sealed revision 一致性和规范 ZIP 验证，返回有界结果与稳定阻断码。缺少 ZIP 时显示为 `missing`，但不阻断首次构建，因为 Core 会在事务中创建并验证 ZIP；已有 ZIP 无效或不可读时仍会阻断。客户端健康页按需请求该投影并列出阻断原因。正式发布仍只能通过 `probhub_build`，继续要求 `confirm: true`、DSH approval，以及 Core 自己的 sealed revision 和事务检查。

## Alternatives considered

**让客户端根据 overview 字段自行推导就绪状态。** 不采用，因为 generation 和包状态是跨题目的 Core 事实，重复推导会逐渐偏离 Core 语义。

**开放浏览器 Build 路由绕过工具审批。** 不采用，因为工作台点击不处于打开的 Agent turn 中，不能安全调用持久的 DSH approval 服务；保留现有面向模型的工具作为唯一发布入口。

**每次构建都要求已有且有效的 ZIP。** 不采用，因为首次正式构建没有 ZIP；Core 内部对 staging 包的验证才是发布前的权威检查。

## Consequences

工作台现在可以给出具体且有界的原因，指导用户执行 checkpoint、seal、assemble 或修复 revision 后再发布。用户主动检查门禁时会增加几次只读 Core 调用，但 Host 仍不拥有锁、事务、generation 状态或包语义。

## Testing

Host 路由和工具测试覆盖就绪、不完整、不一致、包缺失和路径脱敏；客户端测试覆盖阻断码展示与显式门禁请求。
