# @deepseek-ai/dsh-host-probhub

English | [中文](README.zh.md)

Host bridge for a ProbHub Workspace Schema v1 project. The plugin registers `/probhub` and `/probhub/api/*` on the existing `webServer`; it does not open a second listener or embed the ProbHub UI. API requests carry an opaque `sessionId` selector, which is checked against the live or persisted Session header before its canonical `cwd` is used. A workspace is accepted only when `<cwd>/.probhub/workspace.yaml` exists; old metadata and generated artifacts are never used as fallback.

`GET /probhub/api/overview` runs read-only Core `status` and `lint` operations and returns bounded JSON projections. `GET /probhub/api/status` and `/lint` expose the corresponding Core result; `/probhub/api/problems/<id>/status` and `/lint` scope a read to one validated problem id. `GET /probhub/api/health` reports whether the shared subprocess capability is mounted. Non-GET requests, unknown routes, missing sessions, inaccessible cwd values, and missing Schema v1 workspaces fail closed with structured JSON. The optional `@deepseek-ai/dsh-host-probhub/tools` consumer adds model-facing `probhub_judge`, `probhub_stress`, `probhub_judge_qa`, and `probhub_mutation` background jobs. They derive the current Session cwd, require the caller's already-authorized `workspace-write` policy, use Core's `--json` CLI, and return generic `ctx.jobs` ids; they never accept arbitrary paths, `--against`, `--fixate`, ZIP paths, or generated artifacts.

Core execution uses the shared `SubprocessRuntime`, the caller's already-authorized `workspace-write` `sandboxPolicy`/`sandbox` confinement, bounded collected output, process-tree termination, and the configured executable. Deployments that omit either sandbox service fail closed with `sandbox_unavailable`. The bridge owns route lifetime through a Cordis effect; unloading the plugin removes every route.

## Model Experience

### Background validation tools

#### What the model sees

When `@deepseek-ai/dsh-host-probhub/tools` is mounted in an agent preset, four validation tools are available: `probhub_judge`, `probhub_stress`, `probhub_judge_qa`, and `probhub_mutation`. Each accepts a Schema v1 problem id and returns a background job id immediately. Use `job_output` to collect bounded Core JSON and `job_kill` to request cancellation.

#### Token effect

Fixed tool-schema and one short system-prompt contribution while the Consumer is mounted; job output is data-dependent and bounded by the configured byte cap.

#### KV Cache effect

The tool schemas and guidance remain prefix-stable until the Consumer configuration changes; each job result is appended as ordinary tool output.

## Known Limitations and Deferred Work

- **Transport session selector** — the browser supplies an opaque session id; the Host validates it against Harness-owned session state and never treats it as a path or cwd.
- **Read-only projection** — problem summaries are derived from Core JSON and intentionally omit write actions, previews, PDFs, jobs, and generated artifacts.
- **Workspace-write requirement** — validation jobs require the caller's current Session policy to already be `workspace-write`; this adapter never silently upgrades a read-only session or bypasses the shared approval flow.
