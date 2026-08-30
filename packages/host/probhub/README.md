# @deepseek-ai/dsh-host-probhub

English | [中文](README.zh.md)

Host bridge for a ProbHub Workspace Schema v1 project. The plugin registers `/probhub` and `/probhub/api/*` on the existing `webServer`; it does not open a second listener or embed the ProbHub UI. API requests carry an opaque `sessionId` selector, which is checked against the live or persisted Session header before its canonical `cwd` is used. A workspace is accepted only when `<cwd>/.probhub/workspace.yaml` exists; old metadata and generated artifacts are never used as fallback.

`GET /probhub/api/overview` runs read-only Core `status`, `lint`, and `report` operations and returns bounded JSON projections for the workbench. `GET /probhub/api/status` and `/lint` expose the corresponding Core result; `/probhub/api/problems/<id>/status`, `/lint`, and `/report` scope a read to one validated problem id. `GET /probhub/api/source-targets?sessionId=...&problemId=...` returns the bounded allowlist of editable UTF-8 files for one problem. `GET /probhub/api/source?sessionId=...&problemId=...&target=statement` reads one listed source file together with the target-specific Core revision and an impact preview. `POST /probhub/api/source?sessionId=...&problemId=...` saves an allowlisted source target only when the live Session is already in `workspace-write` and its `expectedRevision` still matches; writes use same-volume atomic replacement and return `source_conflict` on a lost update. The target list covers `problem.md`, `probhub.yaml`, code files, sample inputs, and secret inputs without exposing answer files, links, directories, or arbitrary paths. `POST /probhub/api/jobs?sessionId=...&problemId=...` starts one allowlisted non-publishing `checkpoint` or `seal` Job for a live workspace-write Session; `assemble` is workspace-scoped. The UI consumes the resulting Job through the normal Session job stream. `POST /probhub/api/context?sessionId=...&problemId=...` validates a selected problem against the current workspace, then binds its bounded report/status summary to that live Agent's scoped prompt context; the next model request receives the summary through Harness's durable runtime-context path. `GET /probhub/api/health` reports whether the shared subprocess capability is mounted. Unknown routes, unsupported methods, missing sessions, inaccessible cwd values, and missing Schema v1 workspaces fail closed with structured JSON. The optional `@deepseek-ai/dsh-host-probhub/tools` consumer adds model-facing validation, delivery, and read-only operations. Successful ProbHub tool results emit a bounded `probhub/tab-requested` UI hint through the existing remote-event carrier; the client accepts it only for the current Session and a problem present in its latest overview. All operations derive the current Session cwd and use Core's `--json` CLI; write jobs and source saves require the caller's already-authorized `workspace-write` policy and read-only queries use the existing read-only policy. `probhub_build` additionally requires `confirm: true` and the normal DSH approval seam because it publishes formal PDF, ZIP, metadata, and Manifest artifacts. Arbitrary paths, `--against`, and `--fixate` are unavailable. Report fields are limited to problem metadata, test counts, data-group roles, aggregate-constraint state, calibration/QA state, and bounded diagnostics without source paths or evidence text.

Core execution uses the shared `SubprocessRuntime`, the caller's already-authorized `workspace-write` `sandboxPolicy`/`sandbox` confinement, bounded collected output, process-tree termination, and the configured executable. Deployments that omit either sandbox service fail closed with `sandbox_unavailable`. The bridge owns route lifetime through a Cordis effect; unloading the plugin removes every route.

## Model Experience

### ProbHub tools

#### What the model sees

The mounted Consumer exposes validation, delivery, and bounded read-only operations through the current Session workspace.

##### Tool matrix

```markdown
When @deepseek-ai/dsh-host-probhub/tools is mounted in an agent preset, these operations are available:

| Tool | Access | Purpose |
| --- | --- | --- |
| probhub_judge, probhub_stress, probhub_judge_qa, probhub_mutation | workspace-write job | Run validation and write Core-managed caches, evidence, or stress diagnostics. |
| probhub_checkpoint, probhub_seal, probhub_assemble | workspace-write job | Create a checkpoint, seal a problem, or assemble an isolated preview generation. assemble may create a draft checkpoint when one is missing. |
| probhub_build | workspace-write job + confirm: true + approval | Publish formal PDF, ZIP, metadata, and Manifest artifacts after Core's sealed-revision checks. |
| probhub_generation_status, probhub_report, probhub_verify_package | read-only query | Return bounded generation, report, or package-verification projections. verify-package derives the ZIP from the canonical workspace and accepts only problem_id. |

Background tools return a generic job id immediately. Use job_output to collect bounded Core JSON and job_kill to request cancellation. Write jobs are exclusive; read-only queries may overlap.

validation jobs: probhub_judge, probhub_stress, probhub_judge_qa, probhub_mutation
delivery jobs: probhub_checkpoint, probhub_seal, probhub_assemble, probhub_build
read-only queries: probhub_generation_status, probhub_report, probhub_verify_package
formal publication: probhub_build requires confirm: true and the DSH approval channel
```

#### Token effect

Fixed tool-schema and one short system-prompt contribution while the Consumer is mounted; job output is data-dependent and bounded by the configured byte cap.

#### KV Cache effect

The tool schemas and guidance remain prefix-stable until the Consumer configuration changes; each job result is appended as ordinary tool output.

## Known Limitations and Deferred Work

- **Transport session selector** — the browser supplies an opaque session id; the Host validates it against Harness-owned session state and never treats it as a path or cwd.
- **Bounded projection** — model-facing query and job output keeps status, revision, generation, batch, and verification summaries while omitting absolute paths, source details, secrets, and full manifests.
- **Selected-problem context** — the workbench binds one validated problem summary to the live Agent's scoped prompt context; the next model request receives it through the durable runtime-context projection, and the model can refresh it with `probhub_report`.
- **Source editor** — the statement editor reads and saves `problem.md` with an exact Core revision fence. The Host never accepts arbitrary paths, and the response calls out the source/data and formal-artifact invalidation impact so the UI can keep stale output visible.
- **Formal publication** — `probhub_build` is the only tool that publishes formal artifacts. It requires `confirm: true` and the normal DSH approval channel; Core remains responsible for locks, sealing, transactions, and rollback.
- **ZIP path safety** — `probhub_verify_package` accepts a problem id only. The Host derives `<canonical workspace>/<problem_id>.zip`, rejects missing, non-regular, and link paths, and then invokes Core.
- **Workspace-write requirement** — validation jobs require the caller's current Session policy to already be `workspace-write`; this adapter never silently upgrades a read-only session or bypasses the shared approval flow.
