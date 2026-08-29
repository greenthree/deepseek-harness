# `@deepseek-ai/dsh-probhub`

[English](README.md) | 中文

可安装的下游 Bundle，用于在兼容的 dsh Web profile 中启用 ProbHub。它挂载已有的 `@deepseek-ai/dsh-host-probhub` bridge 和 4 个后台验证工具。Web 工作台由匹配的下游 dsh Web 客户端提供；Bundle 不复制 ProbHub Core 或 UI，不启动第二个服务器，也不替换 dsh Web 外壳。

## 安装

在已安装 dsh 的环境中，将 Bundle 加入 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-probhub
dsh --profile web
```

该命令会把包安装到 profile，并将它的 `dsh.bundle` 层加入 `dsh.profile.bundles`。卸载：

```sh
dsh plugin --profile web remove @deepseek-ai/dsh-probhub
```

当前 Bundle 要求使用提供 `sidebar.probhub` 和 ProbHub 工作台布局的下游 dsh 构建。原版上游 dsh Web profile 会在浏览器激活时明确失败，而不是静默显示不完整的集成。

## Bundle 挂载内容

patch 层向 profile 增加 ProbHub Host 行和 `@deepseek-ai/dsh-host-probhub/tools`。安装后，该 profile 中的 Agent 即可使用 4 个验证工具；它们使用当前 Session 工作区和调用者已经获准的 `workspace-write` 策略。

匹配的下游 Web 客户端通过已有的 layout/sidebar slot 渲染工作台，并使用共享 Host prefix route 和当前 Session 的 canonical workspace。Session 选择仍由 dsh 负责，Schema、Judge、stress、mutation、evidence、锁和事务发布仍由 ProbHub Core 唯一负责。

## 模型体验

### 后台验证工具

#### 模型看到的内容

Bundle 挂载后，模型可以启动 `probhub_judge`、`probhub_stress`、`probhub_judge_qa` 和 `probhub_mutation`。每个工具返回通用后台 job id；使用 `job_output` 获取有界结果，使用 `job_kill` 请求取消。

#### Token 影响

Bundle 本身只增加一段简短的激活提示。工具 schema 和任务输出仅在 `/tools` Consumer 挂载时存在，并受其配置的输出上限约束。

#### KV Cache 影响

激活提示在进程生命周期内稳定；每次验证结果作为普通任务输出追加。

## 已知限制与暂缓事项

- **依赖下游 Web**：原版上游 dsh Web profile 不提供 ProbHub 工作台 slot，必须使用匹配的下游 Web 客户端构建。
- **暂不支持直接编辑**：Bundle 当前提供已有的只读 P0 工作台；编辑、封题和交付属于后续 4.7 任务。
- **Core 版本兼容**：已安装 ProbHub Core 必须满足 `@deepseek-ai/dsh-host-probhub` 声明的版本范围。
