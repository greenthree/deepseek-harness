# Agent Note: Standalone downstream ProbHub Bundle

Status: implemented

English | [中文](2026-08-29-standalone-probhub-bundle.zh.md)

## Problem

The ProbHub bridge and Web workbench are currently coupled to a downstream dsh checkout. A dsh user cannot install the integration into a profile as one package, and the upstream repository is not an adoption target for this integration.

## Decision

Publish one downstream dsh Bundle, `@deepseek-ai/dsh-probhub`, that declares `dsh.bundle.patch` and mounts the existing ProbHub Host bridge, validation/delivery jobs, and bounded read-only queries. The Bundle relies on the matching downstream Web workbench supplied by the existing client packages; it does not add UI to a stock Web client. Profile installation uses `dsh plugin --profile web add <package>`; the package ships prebuilt artifacts so normal npm or tarball installation does not execute a source checkout. ProbHub Core remains the owner of workspace validation, process control, evidence, locks, and transactional publishing.

The default Web bundle does not mount the optional ProbHub Host row or validation Consumer. Installing the standalone Bundle adds those rows to the profile layer, so the integration is explicit and can be removed without changing the dsh Web shell. The Host and Bundle form the independent `probhub` release family: they share a version separate from the dsh root, publish from `probhub-v<version>` tags, and are packed and published by `release-probhub.yml` and `release-probhub-publish.yml` in Host-then-Bundle order. The official dsh release family excludes both packages.

## Alternatives considered

- **Keep ProbHub in the default Web bundle** — rejected because every dsh Web user would receive an optional domain integration and its model-facing tools, with no profile-level opt-in.
- **Ask users to install Host, Client, and tool packages separately** — rejected because the profile would expose several ordering and versioning choices that a single Bundle can own.
- **Copy the WebUI or ProbHub Core into the Bundle** — rejected because it would create a second implementation and drift from the Core and existing dsh slot/runtime contracts.
- **Depend on upstream DSH acceptance** — rejected because this downstream integration is maintained independently of the upstream repository.

## Consequences

- Users can install or remove the integration with `dsh plugin --profile web add/remove @deepseek-ai/dsh-probhub` when the downstream Web client is compatible.
- The integration has independent version, tag, pack, and publish workflows, so a ProbHub release does not modify or republish the official dsh family.
- A stock upstream Web client without the matching downstream workbench cannot provide the browser workbench; installation and documentation keep this compatibility requirement explicit.
- Packed-install and profile tests cover tarball payload, composition, route health, unload cleanup, and the temporary dependency override used before the packages exist in the registry.
