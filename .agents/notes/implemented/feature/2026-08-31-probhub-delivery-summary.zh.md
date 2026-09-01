# Agent Note：ProbHub 交付摘要投影

Status: implemented

[English](2026-08-31-probhub-delivery-summary.md) | 中文

## Problem

正式交付门禁已经返回有界阻断码，但工作台没有把 generation 标识、sealed revision 比对、ZIP 验证计数和发布结论放在一起。用户仍需从多个卡片自行推断是否可以交付。

## Decision

客户端在保存门禁结果前先校验嵌套投影，只接受有界的 generation、revision、package、verification 和 report 字段，条目数最多 256，数值计数也有上限。健康页为当前选中的题目展示紧凑的发布前摘要：generation 状态和完整性、source/data 与 sealed revision、规范 ZIP 验证、Core report 状态、缺失题目，以及执行 `probhub_build` 前必须进行的显式确认。

## Alternatives considered

**把 Host 响应作为无类型对象直接渲染。** 不采用，因为同源响应仍可能格式错误或异常膨胀，未知字段不应直接进入用户或模型可见的 UI。

**为每个详情卡增加一个 Core 请求。** 不采用，因为 `delivery-check` 已经组合了权威事实；额外请求会增加延迟并产生不一致快照。

**增加浏览器 Build 按钮。** 不采用，因为正式发布仍只能通过需要显式确认和 DSH approval 的面向模型 `probhub_build` 操作完成。

## Consequences

用户无需查看原始 evidence 就能知道正式构建为何可用或被阻断。嵌套响应无效时会 fail closed 并在页面显示错误。摘要限定当前选中题目，即使 Host 检查了更大的题目集合，也不会暗示未展示题目已经就绪。

## Testing

客户端工作台测试覆盖摘要渲染、阻断详情、嵌套响应错误，以及既有任务和 PDF 流程。TypeScript、定向 Oxlint、Host/Client ProbHub 测试和 `git diff --check` 均通过。
