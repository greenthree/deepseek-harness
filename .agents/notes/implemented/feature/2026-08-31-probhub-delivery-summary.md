# Agent Note: ProbHub delivery summary projection

Status: implemented

English | [中文](2026-08-31-probhub-delivery-summary.zh.md)

## Problem

The formal delivery check exposed bounded blocker codes, but the workbench did not show the generation identity, sealed-revision comparison, package verification counts, or the resulting publication decision together. Users had to infer readiness from separate cards.

## Decision

The client validates the nested delivery projection before storing it. It accepts only bounded generation, revision, package, verification, and report fields, with at most 256 entries and capped numeric counts. The health tab renders a compact publication summary for the selected problem: generation state and completeness, source/data versus sealed revision, canonical ZIP verification, Core report status, missing problems, and the explicit confirmation required before `probhub_build`.

## Alternatives considered

**Render the Host response as an untyped object.** Rejected because a same-origin response can still be malformed or unexpectedly large, and arbitrary fields should not become model- or user-visible UI.

**Add a second Core endpoint for each detail card.** Rejected because `delivery-check` already combines the authoritative facts; extra requests would add latency and create inconsistent snapshots.

**Add a browser Build button.** Rejected because formal publication remains the model-facing `probhub_build` operation with explicit confirmation and DSH approval.

## Consequences

Users can see why a formal build is ready or blocked without inspecting raw evidence. Invalid nested responses fail closed with a visible error. The summary is selected-problem scoped even when the Host gate checks a larger set, so it never implies that unshown problems are ready.

## Testing

Client workbench tests cover the rendered summary, blocker details, malformed nested responses, and the existing job/PDF flows. TypeScript, targeted Oxlint, Host/Client ProbHub tests, and `git diff --check` pass.
