# Feature Specification: Dynamic Plugin Distribution (dual-mode)

> Behaviour-first spec per [Constitution Principle IX](../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Implementation
> lives in [`plan.md`](./plan.md); execution in [`tasks.md`](./tasks.md).

**Feature ID**: `dynamic-plugin-distribution`
**Branch**: `session/ew693-dynamic-plugins`
**Status**: `Implemented`
**Created**: 2026-05-28
**Last updated**: 2026-06-03
**Owner**: @evereq

---

## 1. Overview

Today every plugin in `packages/plugins/*` is built and shipped inside the
platform image. A clone installs all ~49 plugins' third-party SDKs at
`pnpm install`, and the deployed artifact carries every plugin whether or not
an operator ever enables it. This feature makes plugin distribution **dual-mode**
so an operator can choose between:

- **Bundled mode** (today's behaviour, default): all plugins built into the
  image and discovered from disk at boot. No registry, no network at enable-time.
- **Dynamic mode**: only **core** plugins are bundled; every other plugin is
  published to an npm registry and **pulled, validated, and loaded at runtime**
  the first time a user enables it. The platform image and a fresh install stay
  lean, and operators add only the plugins they actually use.

The two modes coexist permanently and are selected by a single platform
setting. Bundled mode remains the default so existing deployments are unaffected.
The capability/enable/settings model the user already sees does not change —
"Enable" simply gains an install-and-load step when a dynamic-mode plugin
isn't present yet.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** an operator running in bundled mode (the default), **when** they
  deploy the platform, **then** all plugins are available exactly as today and
  no registry network calls occur at enable-time.
- **Given** an operator running in dynamic mode, **when** a user opens the
  plugins page, **then** core plugins show as installed and every other
  published plugin shows as **available** (listed from the registry catalog)
  with an Install/Enable action.
- **Given** a user in dynamic mode, **when** they click **Enable** on an
  available non-core plugin (e.g. `notion-extractor`), **then** the platform
  resolves the package from the configured registry, verifies it, installs it
  into the runtime plugin store, loads it, registers its capabilities, and the
  plugin transitions to enabled — without an operator redeploy.
- **Given** a plugin's source changes and a new version is released, **when**
  CI publishes it, **then** the new version is available in **both** the public
  npm registry and the GitHub Packages org registry, and dynamic-mode
  deployments can pick it up on next install/upgrade.
- **Given** a short, synchronous capability call (e.g. resolving an AI
  provider's model list), **when** it runs, **then** the dynamically-installed
  plugin executes in-process via dynamic import with no extra hop.
- **Given** a long-running capability call (e.g. a full generation pipeline
  step), **when** it runs, **then** the job-runtime worker first ensures the
  plugin is installed in its own store (lazy install-on-use), then executes it
  inside the isolated task process, returning the result through the existing
  job result channel.
- **Given** a plugin was enabled on one API replica, **when** a later request
  for it is routed to a _different_ replica (or the worker) that has not yet
  installed it, **then** that node lazily installs it on first use and serves the
  request — no restart or shared volume required.
- **Given** a fresh pod / new replica in dynamic mode, **when** it boots,
  **then** it warms its local store by pre-installing the DB-recorded
  installed/enabled set, and in any case lazily installs any plugin on first use.

### 2.2 Edge cases & failures

- **Given** the registry is unreachable, **when** a user clicks Enable in
  dynamic mode, **then** the install fails with a clear, user-visible error,
  the plugin stays in an `error`/not-installed state, and no partial/half-loaded
  plugin is registered. Already-installed plugins keep working.
- **Given** a requested package is **not** first-party and **not** on the
  allowlist, **when** install is attempted, **then** it is rejected before any
  download with an "package not permitted" error.
- **Given** a package's downloaded integrity hash does not match the pinned
  expectation, **when** install runs, **then** it is rejected and nothing is
  loaded.
- **Given** a plugin fails to load (invalid manifest, version incompatibility,
  throwing constructor), **when** install runs, **then** the failure is recorded
  against that plugin with a reason, the user sees it, and the rest of the
  system is unaffected.
- **Given** a user disables a dynamically-installed plugin, **when** they do so,
  **then** it stops being used immediately (per existing enable/disable rules);
  whether its files are removed from the store is governed by a retention policy
  (default: keep installed, just disabled).
- **Given** an operator switches a running deployment from bundled to dynamic
  mode (or back), **when** the platform restarts, **then** it reconciles to the
  new mode without losing any user's enabled-plugin choices.
- **Given** a core plugin, **when** any user attempts to "uninstall" it in
  dynamic mode, **then** the action is refused — core plugins are always present
  and (for `systemPlugin`) cannot be disabled.
- **Given** dynamic mode and no distributable storage plugin enabled, **when**
  the platform boots, **then** the core default storage (`local-fs`) is available
  so storage-dependent features still function.

## 3. Functional Requirements

Distribution mode & core set:

- **FR-1** The system MUST support a platform-level distribution mode with at
  least the values `bundled` and `dynamic`, defaulting to `bundled`.
- **FR-2** In `bundled` mode the system MUST behave exactly as today: all
  plugins discovered from disk at boot, no registry access required.
- **FR-3** The system MUST classify every plugin as either **core** (always
  bundled in the image, present in both modes) or **distributable** (published
  to a registry, runtime-installable in dynamic mode). The classification MUST
  be declared on the plugin (manifest), not hard-coded in the platform.
- **FR-4** Core MUST include every plugin marked `systemPlugin: true`, and the
  API MUST NOT statically depend on any **distributable** plugin to boot.
  Storage plugins `aws-s3`, `minio`, and `github-storage` are **distributable**;
  the API's current hard imports of them MUST be removed and storage resolved via
  the capability facade/registry. `local-fs` (a `systemPlugin`) remains core and
  is the default storage backend so the platform boots with working storage even
  when no distributable storage plugin is enabled.
- **FR-5** The system MUST NOT require core plugins to be fetched from a
  registry in either mode.

Publishing:

- **FR-6** The system MUST publish each distributable plugin to **both** the
  public npm registry and the GitHub Packages org registry on release.
- **FR-7** Publishing MUST be automated in CI and triggered by plugin source
  changes / releases, and MUST version plugins independently (a plugin release
  MUST NOT require a platform release).
- **FR-8** The platform MUST read the registry endpoint(s) and any auth from
  configuration so self-hosters can point at their own mirror or private
  registry.

Runtime install / enable:

- **FR-9** In dynamic mode, when a user enables a distributable plugin that is
  not yet installed, the system MUST resolve, verify, install, load, register,
  and then enable it as a single user-observable action.
- **FR-10** The system MUST verify a downloaded plugin's integrity (pinned
  version + integrity hash) before loading it.
- **FR-11** The system MUST only install packages that are first-party
  (`@ever-works/*`) or present on an admin-managed allowlist; any other package
  MUST be refused before download.
- **FR-12** The system MUST persist, per plugin, its distribution source
  (`bundled` | `registry`), the installed package spec, the installed version,
  and the integrity value used.
- **FR-13** Every node — each API replica **and** each job-runtime worker — MUST
  ensure a distributable plugin is installed in its own local store before
  invoking it (**lazy install-on-use**), so a plugin enabled on one replica is
  usable on all replicas and in the worker **without** requiring a restart or a
  shared volume. This is the correctness guarantee for per-replica stores.
- **FR-13a** On boot in dynamic mode, a node SHOULD pre-install (warm) the
  DB-recorded installed/enabled distributable set to avoid a first-request
  latency spike. Boot reconcile is an optimisation, not the correctness
  mechanism (FR-13 is).
- **FR-14** A failed install MUST leave the plugin in a clearly-failed state
  with a recorded reason and MUST NOT register a partially-loaded plugin.

Execution model:

- **FR-15** The system MUST be able to execute a dynamically-installed plugin's
  capability call in-process via dynamic import (for short/synchronous calls).
- **FR-16** The system MUST be able to execute a dynamically-installed plugin's
  capability call inside the pluggable job runtime (long-running calls), reusing
  the existing job-dispatch and result channel.
- **FR-17** The choice of execution location MUST be driven by the
  operation/capability (declared classification), not hard-coded per plugin id.

Catalog & UI:

- **FR-18** The plugins UI MUST show, per plugin, an install state distinct
  from enable state: at minimum **available** (not installed), **installing**,
  **installed**, and **error**.
- **FR-19** In dynamic mode the plugins UI MUST list distributable plugins that
  are available from the registry catalog even when not yet installed (the
  manifest summary is listable without instantiating the plugin).
- **FR-20** The system MUST surface install progress and install failures to
  the user who triggered them.

Compatibility:

- **FR-21** Enabling/disabling and per-user / per-work scoping rules MUST remain
  unchanged from today; dynamic mode only adds an install/load step in front of
  enable when the plugin is absent.
- **FR-22** The system MUST NOT change behaviour for existing bundled-mode
  deployments that take no action (default stays `bundled`).

## 4. Non-Functional Requirements

- **Performance**: In-process enable-and-install of a single first-party plugin
  SHOULD complete within a few seconds on a warm registry connection; the call
  MUST be async/non-blocking from the user's perspective with progress feedback.
  Short capability calls MUST NOT incur a job-runtime round-trip.
- **Reliability**: A registry outage MUST degrade gracefully — already-installed
  plugins keep working; new installs fail cleanly and are retryable. Boot-time
  reconcile MUST be idempotent and safe to run on every replica.
- **Security & privacy**: Only allowlisted/first-party packages are installable
  (no arbitrary npm execution in v1). Integrity is verified before load. Plugin
  credentials continue to follow `x-secret` rules. Registry auth tokens are
  treated as secrets. Long-running third-party code runs in the isolated job
  runtime.
- **Observability**: Plugin install attempts, successes, failures, version, and
  source MUST emit activity-log/events and metrics; install failures MUST be
  visible in monitoring.
- **Compatibility**: Requires `@ever-works/plugin` SDK additions to be additive
  and semver-compatible. Plugin manifests gaining new fields MUST remain valid
  under the existing validator (forward-compatible).

## 5. Key Entities & Domain Concepts

| Entity / concept     | Description                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution mode    | Platform setting selecting `bundled` (all in image) vs `dynamic` (core in image, rest from registry).                                                                                                       |
| Core plugin          | A plugin always shipped in the image and present in both modes (every `systemPlugin`, incl. `local-fs` as the boot default storage). Distributable storage (`aws-s3`/`minio`/`github-storage`) is NOT core. |
| Runtime plugin store | A writable directory on a node (default `/app/plugins`) where pulled plugins are written so Node can `import()` them — per-replica, reconciled on boot; not external infrastructure.                        |
| Distributable plugin | A plugin published to a registry and installable at runtime in dynamic mode.                                                                                                                                |
| Plugin registry      | The npm source(s) plugins are published to and pulled from — public npm + GitHub Packages, configurable.                                                                                                    |
| Plugin catalog       | The listable set of distributable plugins (manifest summaries) shown in the UI before install.                                                                                                              |
| Install state        | Lifecycle of a plugin's presence on a node: available → installing → installed / error (distinct from enabled).                                                                                             |
| Plugin allowlist     | Admin-managed set of non-first-party packages permitted for runtime install, with version/integrity pinning.                                                                                                |
| Boot reconcile       | Start-up routine that makes a node's plugin store match the DB record of installed/enabled plugins.                                                                                                         |
| Execution location   | Where a capability call runs: in-process (short) vs job runtime (long-running).                                                                                                                             |

## 6. Out of Scope

- A public third-party plugin **marketplace** with self-serve submission,
  ratings, or billing (this v1 is first-party + admin allowlist only).
- Strong per-plugin sandboxing beyond what the job runtime already provides
  (no isolated-vm / microVM execution in v1).
- Plugin code signing beyond npm integrity + first-party provenance.
- Hot **unload** / live in-process re-instantiation of a plugin without a
  process restart (today the platform never re-instantiates in-process; dynamic
  install adds first-load, not hot-swap).
- Making the job-runtime provider itself pluggable — that is tracked separately
  in [EW-683] and is a dependency, not part of this feature.
- Per-tenant private registries (single configurable registry set in v1).

## 7. Acceptance Criteria

- [ ] With no configuration change, an existing deployment runs in `bundled`
      mode and behaves identically to today (no registry calls at enable-time).
- [ ] Setting distribution mode to `dynamic` ships an image containing only core
      plugins; non-core plugins are absent from the image.
- [ ] In dynamic mode, enabling a first-party distributable plugin installs and
      loads it at runtime and it becomes usable without a redeploy.
- [ ] Each distributable plugin is published to both public npm and GitHub
      Packages by CI on release, with independent versions.
- [ ] A non-allowlisted third-party package is refused before download.
- [ ] A corrupted/integrity-mismatched download is refused and nothing loads.
- [ ] A registry outage fails new installs cleanly while installed plugins keep
      working; retry succeeds when the registry returns.
- [ ] A plugin enabled on one API replica is served by a different replica that
      never handled the enable, via lazy install-on-use, with no restart.
- [ ] A long-running call for a runtime-installed plugin succeeds in the
      job-runtime worker (worker lazily installs it into its own store first).
- [ ] Short capability calls run in-process; long-running ones run in the job
      runtime — verified by an integration test of each path.
- [ ] Core/`systemPlugin` plugins cannot be uninstalled or disabled.
- [ ] All functional requirements have a passing test (unit or e2e).

## 8. Open Questions

All initial open questions were resolved with @evereq on 2026-05-28:

- **Default mode** — `bundled` everywhere (hosted SaaS and self-host alike);
  `dynamic` is strictly opt-in. _(Resolved: bundled default.)_
- **Multi-replica plugin store** — per-replica ephemeral store + boot reconcile;
  **no shared RWX volume required**. A shared PVC is an optional optimization,
  not a prerequisite. _(Resolved: per-replica reconcile.)_
- **Disable retention** — keep installed files on disable; **no garbage
  collection** in v1. _(Resolved: keep installed.)_
- **API storage plugins** — **remove** the API's hard imports of `aws-s3`,
  `minio`, `github-storage` and make them **distributable**; resolve storage via
  the capability facade; keep `local-fs` as the core default. _(Resolved:
  decouple + distributable.)_
- **Allowlist administration** — **both** env/config and an admin API.
  _(Resolved: both surfaces.)_

## 9. Constitution Gates

- [x] Plugin-first if introducing an external integration (Principle I) — the
      registry/installer is platform infrastructure; plugins stay the integration unit.
- [x] Capability-driven resolution if touching cross-plugin behaviour
      (Principle II) — resolution/enable semantics unchanged; install precedes them.
- [x] Source-of-truth repos preserved (Principle III) — unaffected.
- [x] Long-running work via Trigger.dev (Principle IV) — long-running plugin
      execution is explicitly routed through the job runtime.
- [x] Schema changes ship as forward-only migrations (Principle V) — new plugin
      columns + allowlist table are additive.
- [x] Tests accompany the change (Principle VI).
- [x] Secrets handled per `x-secret` rules (Principle VII) — plugin creds and
      registry tokens are secrets.
- [x] Plugin counts touch the canonical doc only (Principle VIII) — counts and
      core/distributable split documented in the canonical built-in-plugins doc.
- [x] Behaviour-first — no implementation in this spec (Principle IX).
- [x] Backwards-compatible API/SDK/schema changes (Principle X) — default
      `bundled` keeps current behaviour; SDK/manifest additions are additive.

## 10. References

- Related features: [`plugin-system`](../plugin-system/spec.md)
- Related ADRs: [`016-dynamic-plugin-distribution`](../../decisions/016-dynamic-plugin-distribution.md)
- Related architecture: [`runtime-plugins`](../../architecture/runtime-plugins.md),
  [`plugin-sdk`](../../architecture/plugin-sdk.md),
  [`deployment`](../../architecture/deployment.md),
  [`trigger-integration`](../../architecture/trigger-integration.md)
- Related Jira: EW epic (this feature), [EW-683] (job-runtime pluggability — dependency),
  [EW-682] (official-SDK audit — related)
