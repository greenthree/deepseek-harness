# Agent Note: 独立下游 ProbHub Bundle

Status: implemented

[English](2026-08-29-standalone-probhub-bundle.md) | 中文

## Problem

ProbHub bridge 和 Web 工作台目前与下游 dsh checkout 绑定。dsh 用户无法将这套集成作为一个包安装进 profile，而上游仓库也不是这套集成的接纳目标。

## Decision

发布一个独立的下游 dsh Bundle `@deepseek-ai/dsh-probhub`，声明 `dsh.bundle.patch`，并挂载已有的 ProbHub Host bridge 和后台验证工具。Bundle 依赖现有 Client 包提供的匹配下游 Web 工作台，不尝试向原版 Web 客户端补充 UI。Bundle 通过 `dsh plugin --profile web add <package>` 安装，并提供预构建产物，因此普通 npm 或 tarball 安装不会执行源码 checkout。ProbHub Core 继续负责工作区校验、进程控制、evidence、锁和事务发布。

默认 Web Bundle 不挂载可选的 ProbHub Host 行和验证 Consumer。安装独立 Bundle 后，这些行才会进入 profile 层，因此集成可以显式启用，也可以在不改变 dsh Web 外壳的情况下移除。Host 与 Bundle 属于独立的 `probhub` 发布族，共用独立于 dsh 根版本的版本线，从 `probhub-v<版本>` tag 发布，并由 `release-probhub.yml` 和 `release-probhub-publish.yml` 按 Host 后 Bundle 的顺序打包与发布。官方 dsh 发布族排除这两个包。

## Alternatives considered

- **将 ProbHub 保留在默认 Web Bundle 中**：否决，因为每个 dsh Web 用户都会得到可选领域集成及其面向模型的工具，无法按 profile 选择。
- **要求用户分别安装 Host、Client 和工具包**：否决，因为 profile 会暴露多个排序和版本选择，而这些可以由一个 Bundle 统一管理。
- **在 Bundle 中复制 WebUI 或 ProbHub Core**：否决，因为这会产生第二套实现，并与 Core 及现有 dsh slot/runtime 约定逐渐分叉。
- **依赖 DSH 上游接纳**：否决，因为这套下游集成独立于上游仓库维护。

## Consequences

- 下游 Web 客户端兼容时，用户可以用 `dsh plugin --profile web add/remove @deepseek-ai/dsh-probhub` 安装或移除集成。
- 集成拥有独立版本、tag、pack 和发布 workflow，ProbHub 发布不会修改或重新发布官方 dsh 发布族。
- 没有匹配下游工作台的原版上游 Web 客户端无法提供题目工作台；安装诊断和文档会持续明确这一兼容要求。
- 打包安装与 profile 测试覆盖 tarball payload、组合、路由健康、卸载清理，以及两包尚未进入 registry 时所需的临时依赖 override。
