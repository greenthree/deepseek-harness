# @deepseek-ai/dsh-host-probhub

English | [中文](README.zh.md)

Read-only Host bridge for a ProbHub Workspace Schema v1 project. The plugin registers `/probhub` and `/probhub/api/*` on the existing `webServer`; it does not open a second listener or embed the ProbHub UI. API requests carry an opaque `sessionId` selector, which is checked against the live or persisted Session header before its canonical `cwd` is used. A workspace is accepted only when `<cwd>/.probhub/workspace.yaml` exists; old metadata and generated artifacts are never used as fallback.

`GET /probhub/api/overview` runs read-only Core `status` and `lint` operations and returns bounded JSON projections. `GET /probhub/api/status` and `/lint` expose the corresponding Core result; `/probhub/api/problems/<id>/status` and `/lint` scope a read to one validated problem id. `GET /probhub/api/health` reports whether the shared subprocess capability is mounted. Non-GET requests, unknown routes, missing sessions, inaccessible cwd values, and missing Schema v1 workspaces fail closed with structured JSON. No endpoint writes source files or artifacts and no judge, stress, build, distribute, or job operation is exposed.

Core execution uses the shared `SubprocessRuntime`, read-only `sandboxPolicy`/`sandbox` confinement, bounded collected output, an abort deadline, and the configured executable. Deployments that omit either sandbox service fail closed with `sandbox_unavailable`. The bridge owns route lifetime through a Cordis effect; unloading the plugin removes every route.

## Model Experience

None, as this Host-only bridge never contributes model context.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Transport session selector** — the browser supplies an opaque session id; the Host validates it against Harness-owned session state and never treats it as a path or cwd.
- **Read-only projection** — problem summaries are derived from Core JSON and intentionally omit write actions, previews, PDFs, jobs, and generated artifacts.
