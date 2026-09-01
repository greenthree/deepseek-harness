# Agent Note: ProbHub delivery tools

Status: implemented

English | [中文](2026-08-29-probhub-delivery-tools.zh.md)

## Problem

The ProbHub downstream Bundle needs model-facing checkpoint, seal, preview-generation, package, and formal-build operations without moving Core state, lock, or publication ownership into DSH. A model also needs enough structured status to distinguish incomplete, stale, missing, failed, and published results without receiving local paths or full manifests.

## Decision

The Host `tools` Consumer maps Core's `checkpoint`, `seal`, `assemble`, and `build` operations to exclusive background jobs, and maps `generation-status`, `report`, and `verify-package` to bounded read-only queries. Validation jobs remain exclusive as they can write caches, evidence, or stress diagnostics. All jobs derive the canonical workspace from the calling Session and require its existing `workspace-write` policy; the adapter never upgrades permissions or reimplements Core locks, sealing, transactions, or rollback.

Formal `probhub_build` calls require a literal `confirm: true` argument and pass through the normal DSH approval seam. The tool does not expose Core's `--skip-judge`, arbitrary paths, stress `--against`, or `--fixate`. `probhub_verify_package` accepts only a validated problem id, derives `<canonical workspace>/<id>.zip`, rejects missing, non-regular, symbolic-link, and resolved-outside-workspace paths, and invokes Core's deep verification.

Background output is projected by operation. Checkpoint and generation projections retain ids, states, hashes, completion flags, and bounded missing-problem reasons; build retains batch and per-problem status summaries; read-only queries retain state, verification scope, bounded counts, and problem summaries. Absolute paths, source details, secret content, and full manifests are omitted. Read-only Core calls forward the tool cancellation signal and wait for shared process-tree cleanup before returning.

## Alternatives considered

**Expose raw Core JSON.** Rejected because reports, manifests, diagnostics, and package results can contain local paths and source or secret identifiers that are not needed for model decisions.

**Let every operation run concurrently.** Rejected because Core writers share workspace locks and generated state; DSH marks them exclusive while allowing read-only projections to overlap.

**Treat `confirm: true` as sufficient publication authorization.** Rejected because the argument records intent while the approval seam records the user's decision. Without an approval channel the build is denied.

## Consequences

- Agents can start validation and delivery jobs without blocking the turn, then collect or cancel them through generic DSH job tools.
- Formal publication remains visibly distinct and requires both explicit model intent and the deployment's normal human approval path.
- Model-visible results are useful for routing follow-up work while bounded and path-safe; detailed diagnostics remain in Core's local result.
- The downstream package documentation and generated tool catalog describe all operations, permission classes, parameter limits, and publication effects.
