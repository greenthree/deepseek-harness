# Agent Note: Windows 下以无 shell 方式运行 npm 发布步骤

Status: implemented

[English](2026-09-01-windows-shell-free-npm-release.md) | 中文

## 问题

发布脚本通过无 shell 方式启动 npm。Windows 的包管理器 shim 以 PowerShell 脚本和命令包装文件形式提供，因此对 Node 的无 shell 子进程 API 来说，直接启动 `npm` 并不可靠。

## 决策

所有发布和打包安装验证中的 npm 调用统一使用 `npmInvocation` helper。POSIX 主机直接调用 `npm`；Windows 则通过 `process.execPath` 执行与当前 Node 可执行文件同目录下的 npm CLI。registry 查询、发布尝试和打包安装依赖因此共享同一套无 shell 解析。registry integrity 解析同时接受 npm 的字符串形式和单元素 JSON 数组形式，并拒绝缺失或含糊的值。

## 备选方案

**直接启动 `npm.cmd`。** 不采用，因为 Node 在 Windows 上的无 shell 启动并不能在所有受支持环境中稳定执行命令包装文件。

**通过 `cmd.exe` 运行 npm。** 不采用，因为这会把 shell 参数转义和环境语义引入本来只需调用 npm CLI 的路径；直接由 Node 执行更明确。

**在每个调用方保留独立的 Windows 分支。** 不采用，因为发布和打包安装路径可能逐渐不一致，再次引入同类故障。

## 影响

当 npm 随标准 Node 一起安装时，Windows 发布不再因 `spawnSync npm ENOENT` 失败。helper 假定标准 Node 目录中存在 `node_modules/npm/bin/npm-cli.js`；非标准 Node 安装会在 npm 调用处报告具体 CLI 错误，而不是被误判成找不到 `npm` 可执行文件。对于把选定 integrity 投影为字符串或单元素数组的 npm 版本，重复发布都能正常运行。单元测试覆盖 POSIX、Windows 分支和 integrity 解析。
