# `@greenthree/dsh-probhub`

[English](README.md) | 中文

可安装的下游 Bundle，用于在兼容的 dsh Web profile 中启用 ProbHub。它挂载已有的 `@greenthree/dsh-host-probhub` bridge 以及验证、交付和只读工具。Web 工作台由匹配的下游 dsh Web 客户端提供；Bundle 不复制 ProbHub Core 或 UI，不启动第二个服务器，也不替换 dsh Web 外壳。

## 安装

在已安装 dsh 的环境中，将 Bundle 加入 Web profile：

```sh
dsh plugin --profile web add @greenthree/dsh-probhub
dsh --profile web
```

该命令会把包安装到 profile，并将它的 `dsh.bundle` 层加入 `dsh.profile.bundles`。卸载：

```sh
dsh plugin --profile web remove @greenthree/dsh-probhub
```

当前 Bundle 要求使用提供 `sidebar.probhub` 和 ProbHub 工作台布局的下游 dsh 构建。原版上游 dsh Web profile 会在浏览器激活时明确失败，而不是静默显示不完整的集成。

## Bundle 挂载内容

patch 层向 profile 增加 ProbHub Host 行和 `@greenthree/dsh-host-probhub/tools`。安装后，该 profile 中的 Agent 即可使用验证、交付后台任务和有界只读查询。写任务使用当前 Session 工作区和调用者已经获准的 `workspace-write` 策略；正式 `probhub_build` 还要求 `confirm: true` 和标准 DSH approval 通道。

匹配的下游 Web 客户端通过已有的 layout/sidebar slot 渲染工作台，并使用共享 Host prefix route 和当前 Session 的 canonical workspace。Session 选择仍由 dsh 负责，Schema、Judge、stress、mutation、evidence、锁和事务发布仍由 ProbHub Core 唯一负责。

## 模型体验

### ProbHub 工具

#### 模型看到的内容

Bundle 挂载后，模型可以启动验证任务（`probhub_judge`、`probhub_stress`、`probhub_judge_qa`、`probhub_mutation`）、交付任务（`probhub_checkpoint`、`probhub_seal`、`probhub_assemble`、`probhub_build`）和只读查询（`probhub_delivery_check`、`probhub_generation_status`、`probhub_report`、`probhub_verify_package`）。每个后台任务返回通用 job id；使用 `job_output` 获取有界结果，使用 `job_kill` 请求取消。`probhub_delivery_check` 会在发布前组合当前 sealed revision、预览 generation、report 和规范包检查。只有 `probhub_build` 会发布正式 PDF/ZIP/metadata/Manifest，并且需要显式确认和 approval。`probhub_verify_package` 根据 `problem_id` 从规范工作区派生 ZIP，不接受任意路径。

#### Token 影响

Bundle 本身只增加一段简短的激活提示。工具 schema 和任务输出仅在 `/tools` Consumer 挂载时存在，并受其配置的输出上限约束。

#### KV Cache 影响

激活提示在进程生命周期内稳定；每次验证结果作为普通任务输出追加。

## 已知限制与暂缓事项

- **依赖下游 Web**：原版上游 dsh Web profile 不提供 ProbHub 工作台 slot，必须使用匹配的下游 Web 客户端构建。
- **暂不支持直接编辑**：Bundle 当前提供已有的只读 P0 工作台；编辑仍需 workspace-write 流程，封题和交付通过上面的模型后台任务执行。
- **Core 版本兼容**：已安装 ProbHub Core 必须满足 `@greenthree/dsh-host-probhub` 声明的版本范围。
