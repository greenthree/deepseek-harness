# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：三栏 AppFrame（拖动手柄与让步链）加 `ctx.layout` 面板几何服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details` 和 `conversation.empty`。侧边栏的缩放边界是不可见命中条带，详情栏边界则保留其浮动胶囊；让步期间只有详情栏会收缩并随后自动关闭。关闭的侧边栏仍保留 56px 控制栏，详情栏则关闭到零宽度。该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

AppFrame 始终挂载会话栏和详情栏；已连接 Session 通过 `SessionProvider` 渲染。布局 store 是瞬时状态，侧边栏以默认宽度启动，详情栏则保持关闭，且该 store 从不读写 `localStorage`。hero 和其他未选中状态也会将详情栏的渲染宽度派生为零，但不会改变存储的宽度偏好。AppFrame 会跨越这些状态保留最后一个非 blank 会话 id：首个会话保持关闭；显式打开详情栏的操作会使用约定默认宽度；返回同一会话时恢复其未改变的宽度；选择不同会话时，详情栏会在绘制前关闭。挂载 ProbHub 工作台后，其 controller 跟随当前 Session，并把 Host 的有界 report 投影传给题面、健康和 AI 副驾驶视图；题面页可显式打开带 Core revision 栅栏的 workspace-write 源文件编辑器，目标来自白名单中的 `problem.md`、`probhub.yaml`、代码、样例输入和正式输入文件。健康与评测页会显示当前 source/data、验证、预览 generation 和正式发布清单，并可通过 Host 启动非发布的 `judge`、`stress`、`judge-qa`、`mutation`、`checkpoint`、`seal` 以及工作区级 `assemble` Job；stress 按钮默认使用 1000 轮和 seed 12345。运行中的任务会禁用对应按钮避免重复启动，工作台提供通过 Host 请求取消的操作；同时从共享会话任务流镜像当前 Session 的 ProbHub 后台任务（`running`、`stopping`、`completed`、`failed` 或 `killed`）。正式 Build 仍是后续的显式交付步骤。Host 工具结果也可将工作台定位到经过校验的 Tab，但不会修改工作区文件。会话 owner share 为空，侧边栏 owner share 只包含 `collapsed` 和 `width`；注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。

试卷 PDF 页通过同源 Host 路由嵌入当前隔离 preview generation；未返回 generation 时保持不可用。正式 Build 仍是后续的显式交付步骤。`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController` 和四个 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部。

健康与评测页可以请求有界的正式交付门禁，列出 generation、sealed revision 和 ZIP 验证阻断原因。检查后会为当前选中的题目显示发布摘要，包括 generation 完整性、revision 一致性、包计数、report 状态和 Build 前需要的确认。正式 Build 仍是需要显式确认并通过 DSH approval 的 `probhub_build` 工具操作。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板几何信息是瞬时状态**：重新加载会恢复侧边栏默认值，并使详情栏保持关闭；在不同会话 id 之间切换同样会关闭详情栏，并忘记拖动后的宽度，而未选中表面会以零宽度渲染详情栏，但不会修改几何信息。
- **让步链自动关闭通过推导零宽度实现，不会改动宽度偏好**：窗口变宽时面板会自行恢复；消费方禁止把 store 中的详情宽度当作实际渲染状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
- **ProbHub 运行时按需启用**：没有 Host 路由的 profile 保留普通 DSH 会话外壳；已安装 Host 返回迁移或 Core 错误时显示工作台提示，不展示未经验证的内容。
- **规范源编辑是显式操作**：编辑器只提供 Host 白名单中的题面、配置、代码、样例输入和正式输入目标；读取和保存都经过 Host 源文件桥接，要求 Session 已处于 `workspace-write`，外部修改会显示 revision 冲突而不会被覆盖。
