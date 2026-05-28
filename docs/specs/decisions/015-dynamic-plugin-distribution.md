# ADR-015: Dual-Mode Plugin Distribution (bundled + runtime npm install)

## Status

**Accepted** — decisions locked with @evereq 2026-05-28; implementation tracked under EW-693.

## Date

2026-05-28

## Context

Every plugin under `packages/plugins/*` is part of the pnpm workspace and is
built into the platform image. Consequences today:

- A clone + `pnpm install` resolves the dependency closure of **all** ~49
  plugins, pulling every plugin's third-party SDK even for plugins that will
  never be enabled.
- The deployed artifact (and image) carries every plugin and its SDK regardless
  of what any tenant enables. Plugins are discovered from disk
  (`DEFAULT_PLUGIN_PATHS`) and dynamically `import()`-ed; there is no
  tree-shaking by enable-state.
- "Enable" is purely a DB flag flip today — all plugins are pre-loaded at boot.
- The official-SDK rule (EW-682, AGENTS.md NN #22) means each new integration
  adds a real runtime dependency, so install time and image size grow linearly
  with the unique SDK trees plugins introduce.

We want to keep the simple "everything bundled" model **and** add a mode where a
deployment ships only core plugins and pulls the rest at runtime when enabled.

## Decision

Introduce a platform setting **`PLUGIN_DISTRIBUTION_MODE`** with two values:

- **`bundled`** (default): current behaviour — all plugins in the image,
  discovered from disk, no registry. Existing deployments are unaffected.
- **`dynamic`**: only **core** plugins are bundled; **distributable** plugins are
  published to a registry and pulled, integrity-verified, and loaded at runtime
  on first enable, then reconciled from the database on every boot.

Supporting decisions:

1. **Core vs distributable is declared on the plugin** via a new manifest field
   `distribution: 'core' | 'registry'`, defaulting from `systemPlugin`. Core =
   all `systemPlugin: true` plugins + any plugin the API cannot boot without.
2. **Publish to BOTH public npm and GitHub Packages** (`@ever-works` org), with
   **independent per-plugin versioning** via Changesets. Registry endpoints are
   configurable so self-hosters can use a mirror/private registry.
3. **Trust model: first-party + allowlist.** Only `@ever-works/*` (implicit) or
   admin-allowlisted packages are installable; verify integrity before load. No
   arbitrary-npm execution and no bespoke sandbox in v1.
4. **Execution location is routed per operation.** Short/`sync` calls run
   in-process via dynamic import; `long-running` calls run inside the pluggable
   job runtime (Trigger.dev today), which already isolates plugin code. This
   depends on, but does not duplicate, the job-runtime-pluggability work
   (EW-683).

## Consequences

**Positive**

- Lean installs/images for deployments that enable few plugins.
- Plugin releases decouple from platform releases (independent versions).
- Clear path to a future community/third-party plugin ecosystem (allowlist →
  marketplace) without re-architecting.
- Isolation for long-running third-party code reuses existing infrastructure.

**Negative / costs**

- New supply-chain surface: registry availability, auth, integrity, allowlist
  administration.
- Cold-start install cost on fresh replicas (mitigated by boot reconcile +
  optional baking/PVC).
- Dynamic mode requires a writable runtime store, so read-only-FS serverless
  targets (Vercel) remain `bundled`-only. The store is just a writable directory
  (default `/app/plugins`), per-replica with boot reconcile — no shared volume or
  external service required.
- The API's hard imports of storage plugins (`aws-s3`, `minio`, `github-storage`)
  are **removed**; storage is resolved via the capability facade and those three
  become distributable. `local-fs` stays core as the default storage so the API
  boots without any distributable plugin (EW-693 T8b).

**Neutral**

- The loader, registry, lifecycle, and per-user/per-work enable model are reused
  unchanged; this is additive plumbing, not a rewrite.

## Alternatives considered

- **Public npm only** — simpler, but loses the GitHub-native auth/mirroring story
  for self-hosters and private plugins. Rejected in favour of dual-publish.
- **Self-hosted Verdaccio only** — maximum control but new infra to operate;
  kept as an optional self-host mirror behind the configurable registry URL.
- **First-party only** (no third-party) — simplest trust model, but forecloses
  the ecosystem; rejected in favour of first-party + allowlist.
- **Open to any npm package** — requires signing + sandboxing + review pipeline
  up front; deferred to a future phase.
- **In-process sandbox (isolated-vm/microVM) for all plugin code** — heavy; not
  needed in v1 given allowlist + job-runtime isolation for long-running work.

## References

- Feature spec: [`features/dynamic-plugin-distribution/spec`](../features/dynamic-plugin-distribution/spec.md)
- Plan: [`features/dynamic-plugin-distribution/plan`](../features/dynamic-plugin-distribution/plan.md)
- Architecture: [`architecture/runtime-plugins`](../architecture/runtime-plugins.md)
- Related: [`plugin-sdk`](../architecture/plugin-sdk.md), [`deployment`](../architecture/deployment.md)
- Jira: EW epic (this feature), EW-683 (job-runtime pluggability), EW-682 (official-SDK audit)
