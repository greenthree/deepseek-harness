# Agent Note: ProbHub packed profile gate

Status: implemented

English | [中文](2026-09-03-probhub-packed-profile-gate.zh.md)

## Problem

The ProbHub release workflows validated tarball contents but did not install the exact release tarballs through the DSH profile lifecycle. A payload could therefore pass packing while profile composition or removal still failed.

## Decision

The existing built-CLI profile test accepts `DSH_PROBHUB_PACKED_DIR`. When set, it uses the Host and Bundle tarballs produced by the release job; local runs keep packing the workspace packages. Both ProbHub pack workflows build the CLI and Web artifacts, pack the release, then run this test before uploading or publishing artifacts.

## Alternatives considered

**Keep the release check limited to tarball contents.** Rejected because archive completeness does not prove profile installation, composition, Web routing, or removal.

**Add a separate release-only installer script.** Rejected because it would duplicate the built CLI lifecycle instead of exercising the same `dsh plugin` path users run.

## Consequences

Release jobs now exercise installation, profile manifest registration, Host/tools composition, Web health routing, and clean removal against the same bytes that would be published. The release job is slower because it performs a complete build and one profile lifecycle test.

## Testing

The packed profile test passed locally on Windows. The complete build and hygiene gates passed on the release baseline.
