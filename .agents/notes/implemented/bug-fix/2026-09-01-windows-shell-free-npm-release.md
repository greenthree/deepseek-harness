# Agent Note: Run npm release steps shell-free on Windows

Status: implemented

English | [中文](2026-09-01-windows-shell-free-npm-release.zh.md)

## Problem

Release scripts spawn npm without a shell. Windows package-manager shims are exposed as PowerShell and command-wrapper files, so a bare `npm` command is not a reliable executable for Node's shell-free child-process API.

## Decision

All release and packed-install npm calls use one `npmInvocation` helper. POSIX hosts invoke `npm` directly; Windows invokes the npm CLI bundled beside the running Node executable through `process.execPath`. Registry queries, publication attempts, and packed-install dependency installation therefore use the same shell-free resolution.

## Alternatives considered

**Invoke `npm.cmd` directly.** Rejected because Node's shell-free Windows spawn does not consistently launch command-wrapper files across supported environments.

**Run npm through `cmd.exe`.** Rejected because it adds shell argument quoting and environment semantics to a path that only needs the npm CLI, while direct Node execution keeps the boundary explicit.

**Keep a separate Windows branch in each caller.** Rejected because release and packed-install paths could drift and reintroduce the same failure.

## Consequences

Windows release publication no longer fails with `spawnSync npm ENOENT` when npm is installed with Node. The helper assumes the standard Node distribution layout containing `node_modules/npm/bin/npm-cli.js`; a nonstandard Node installation fails at the npm invocation with its concrete CLI error instead of being mistaken for a missing executable name. The invocation descriptor is unit-tested for POSIX and Windows branches.
