# Agent Note: ProbHub formal delivery gate

Status: implemented

English | [中文](2026-08-30-probhub-delivery-gate.zh.md)

## Problem

The DSH workbench could show validation and preview state, but it had no bounded, shared view of whether a formal ProbHub publication was ready. A user or model could see separate status fragments and still miss an incomplete generation or sealed-revision mismatch before requesting publication.

## Decision

The Host exposes a read-only `delivery-check` route and the model-facing `probhub_delivery_check` tool. Both combine Core `status`, `report`, `generation-status`, sealed-revision matching, and canonical package verification into one bounded result with stable blocker codes. Missing ZIP files are reported as `missing` without blocking the first build because Core creates and verifies packages transactionally; invalid or unreadable existing packages remain blocking. The client health tab requests this projection explicitly and lists the returned blockers. Formal publication remains exclusive to `probhub_build`, which still requires `confirm: true`, the DSH approval seam, and Core's own sealed-revision and transaction checks.

## Alternatives considered

**Let the client infer readiness from overview fields.** Rejected because generation and package state are cross-problem Core facts and duplicating the inference would drift from Core semantics.

**Expose a browser Build endpoint that bypasses the tool approval path.** Rejected because a workbench click is not an open Agent turn and cannot safely call the durable DSH approval service; the existing model-facing tool remains the single publication entry.

**Require an existing valid ZIP before every build.** Rejected because the first formal build has no ZIP to verify; staged package verification inside Core is the authoritative pre-publication check.

## Consequences

The workbench now gives users concrete, bounded reasons to run checkpoint/seal/assemble or repair revisions before publication. The extra read-only Core calls add latency only when the user requests the gate, and the Host still does not own locks, transactions, generation state, or package semantics.

## Testing

Host route and tool tests cover ready, incomplete, mismatched, missing-package, and path-redaction cases. Client tests cover rendering blocker codes and the explicit gate request.
