# Agent Note：ProbHub 打包 profile 门禁

状态：已实现

English | [中文](2026-09-03-probhub-packed-profile-gate.md)

## 问题

ProbHub 发布工作流此前只验证 tarball 内容，没有通过 DSH profile 生命周期安装实际发布的 tarball。因此仅通过打包并不能保证 profile 组装或卸载成功。

## 决策

已有的 built CLI profile 测试新增 `DSH_PROBHUB_PACKED_DIR` 支持。设置该变量时测试使用发布工作流生成的 Host 和 Bundle tarball；本地运行仍从工作区目录打包。两个 ProbHub 打包工作流现在都会先构建 CLI 和 Web 产物、打包发布文件，再运行该测试，最后才上传或发布产物。

## 备选方案

**继续只检查 tarball 内容。** 放弃，因为归档完整并不能证明 profile 安装、组装、Web 路由或卸载可用。

**新增只在发布时使用的安装脚本。** 放弃，因为这会重复 built CLI 的生命周期逻辑，而不是验证用户实际执行的 `dsh plugin` 路径。

## 结果

发布任务会使用即将发布的相同字节验证安装、profile 清单注册、Host/tools 组装、Web 健康路由和干净卸载。代价是完整构建和一次 profile 生命周期测试会增加发布任务耗时。

## 测试

Windows 本地 packed profile 测试通过。发布基线的完整构建和 hygiene 门禁通过。
