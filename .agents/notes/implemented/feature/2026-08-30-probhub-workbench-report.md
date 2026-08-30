# Agent Note: ProbHub workbench report context

Status: implemented

English | [中文](2026-08-30-probhub-workbench-report.zh.md)

## Problem

The ProbHub workbench could select a problem from the read-only list, but the problem view and AI copilot lacked Core-owned summaries for data coverage, aggregate constraints, Judge QA, and calibration. The browser must not read workspace artifacts directly or duplicate Core report logic.

## Decision

The DSH Host calls Core's read-only `report` operation as part of `/probhub/api/overview` and exposes a scoped `/probhub/api/problems/<id>/report` read. The Host projects only problem metadata, test counts, data-group roles, aggregate-constraint state, calibration/QA/mutation state, and bounded diagnostic codes and severities; source paths, secrets, evidence text, and raw diagnostic messages stay inside Core. The workbench shows test counts and aggregate-constraint state in the statement tab, data groups, Judge QA, aggregate constraints, and calibration in the health tab, and the copilot shows the same selected-problem context. Requests continue to derive the canonical workspace from the current Harness Session and use the existing read-only policy.

## Alternatives considered

**Browser reads `problem.md`, `probhub.yaml`, or report files directly:** Rejected because this bypasses Host Session/canonical-cwd validation and duplicates Schema and redaction rules in the browser.

**Reimplement data-group, QA, or calibration decisions in DSH:** Rejected because Core is the only source of truth and a second implementation would drift.

**Forward complete report JSON to the browser and model:** Rejected because the report can contain paths, diagnostic text, and details associated with secrets; the Host must perform a field-level bounded projection.

## Consequences

The workbench and copilot can show the same Core verification context without writing sources or formal artifacts; Overview starts one additional read-only report process, and Core still computes the report. A profile without the ProbHub Host route keeps the original DSH conversation shell; an installed Host that returns `migration_required` or another real error displays the fail-closed workbench notice. This slice shows structured summaries only; full statement editing, validation job controls, and formal delivery remain later P1/P2 work.
