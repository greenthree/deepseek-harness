# `@deepseek-ai/dsh-probhub`

English | [中文](README.zh.md)

An installable downstream Bundle that enables ProbHub in a compatible dsh Web profile. It mounts the existing `@deepseek-ai/dsh-host-probhub` bridge and its validation, delivery, and read-only tools. The Web workbench is supplied by the matching downstream dsh Web client; this Bundle does not copy ProbHub Core or UI, open another server, or replace the dsh Web shell.

## Install

With dsh already installed, add the Bundle to the Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-probhub
dsh --profile web
```

The command installs the package into the profile and adds its `dsh.bundle` layer to `dsh.profile.bundles`. Remove it with:

```sh
dsh plugin --profile web remove @deepseek-ai/dsh-probhub
```

The current Bundle requires the downstream dsh build that provides `sidebar.probhub` and the ProbHub workbench layout. A stock upstream dsh Web profile fails loudly at browser activation instead of silently showing an incomplete integration.

## What the Bundle mounts

The patch layer adds the ProbHub Host row and `@deepseek-ai/dsh-host-probhub/tools` to the profile. After installation, validation and delivery jobs plus bounded read-only queries are available to agents in that profile. Write jobs use the current Session workspace and the caller's already-authorized `workspace-write` policy. Formal `probhub_build` publication additionally requires `confirm: true` and the normal DSH approval channel.

The matching downstream Web client renders the workbench through its existing layout/sidebar slots and uses the shared Host prefix route and the current Session's canonical workspace. Session selection remains a dsh concern, and ProbHub Core remains the only owner of Schema, Judge, stress, mutation, evidence, locks, and transactional publishing.

## Model Experience

### ProbHub tools

#### What the model sees

After the Bundle is mounted, the model can start validation jobs (`probhub_judge`, `probhub_stress`, `probhub_judge_qa`, `probhub_mutation`), delivery jobs (`probhub_checkpoint`, `probhub_seal`, `probhub_assemble`, `probhub_build`), and read-only queries (`probhub_delivery_check`, `probhub_generation_status`, `probhub_report`, `probhub_verify_package`). Each background job returns a generic id; use `job_output` to collect bounded results and `job_kill` to request cancellation. `probhub_delivery_check` combines the current sealed revision, preview generation, report, and canonical package checks before publication. `probhub_build` is the only operation that publishes formal PDF/ZIP/metadata/Manifest artifacts and requires explicit confirmation plus approval. `probhub_verify_package` derives a canonical workspace ZIP from `problem_id` and never accepts an arbitrary path.

#### Token effect

The Bundle itself contributes only a short activation note. Tool schema and job output costs are present only while the `/tools` Consumer is mounted and remain bounded by its configuration.

#### KV Cache effect

The activation guidance is stable for the process lifetime. Each validation result is appended as ordinary job output.

## Known Limitations and Deferred Work

- **Downstream Web dependency** — the stock upstream dsh Web profile does not provide the ProbHub workbench slots; use the matching downstream Web client build.
- **No direct browser editing** — this Bundle exposes the existing read-only P0 workbench. Editing remains a separate workspace-write flow; sealing and delivery are available only through the model-facing jobs described above.
- **Core version compatibility** — the installed ProbHub Core must satisfy the version range declared by `@deepseek-ai/dsh-host-probhub`.
