# Agent Note: ProbHub background validation jobs

Status: implemented

English | [中文](2026-08-28-probhub-background-validation-jobs.zh.md)

## Problem

The read-only ProbHub Host route cannot run validations without blocking a model turn, while adding a second task registry or duplicating Core's locks and publication rules would split ownership of the operation. Validation commands also write caches, evidence, or stress diagnostics, so they need the same workspace and cancellation discipline as other background work.

## Decision

The ProbHub Host package exports an optional `tools` Consumer. Agent presets mount it when they want model-facing `probhub_judge`, `probhub_stress`, `probhub_judge_qa`, and `probhub_mutation` operations. Each call validates a Schema v1 problem id, derives the workspace from the caller's Session, and registers one `ctx.jobs` record. The tool returns the job id immediately; `job_output` and `job_kill` remain the generic job controls.

The Consumer invokes the installed ProbHub Core CLI through the shared `SubprocessRuntime` and the session's already-authorized `workspace-write` policy. It never accepts a filesystem path, arbitrary CLI flags, `--against`, `--fixate`, a ZIP path, or a generated-artifact path. A read-only Session is rejected instead of being silently upgraded or bypassing approval.

The adapter owns only child-process startup, the per-job cancellation marker, bounded stdout collection, and result mapping. Core owns workspace locks, snapshots, caches, evidence, stress diagnostics, and transactional publication. A normal Core JSON result is completed even when a cancellation request races after process exit; a Core cancellation or process termination before completion is killed. Failed process, output-limit, cancellation-request, and cleanup conditions remain failed job outcomes and are not presented as validation success.

## Alternatives considered

**Expose validation over the HTTP route.** Rejected because model calls would need a second transport and the route would become a task owner instead of reusing Harness session-scoped jobs.

**Implement validation logic in DSH.** Rejected because Core is the single owner of Schema parsing, locks, evidence, process policy, and transactional writes; the adapter must invoke its installed CLI.

## Consequences

The tools package is an optional Consumer: the HTTP Host route remains read-only, while presets that mount the Consumer gain background validation. It does not add a second HTTP listener, a second job registry, a persistent worker, progress events, or a new Core protocol. Background jobs are process-local and use the existing owner isolation, admission, cancellation, and cleanup semantics. Read-only `/probhub` routes remain unchanged.
