# Architecture: Runtime Plugin Distribution

**Status**: `Draft`
**Last updated**: 2026-05-28
**Audience**: AI agents and engineers implementing dual-mode plugin distribution.

> Companion to [`plugin-sdk`](./plugin-sdk.md) (the SDK plugins build against)
> and the feature spec [`dynamic-plugin-distribution`](../features/dynamic-plugin-distribution/spec.md).
> This doc describes **how plugins are distributed, installed, and executed** at
> runtime — `plugin-sdk.md` describes the contract; this describes the supply chain.

---

## 1. Purpose

The platform supports two distribution modes that share one code path:

- **`bundled`** (default, today): every plugin in `packages/plugins/*` is built
  into the image and discovered from disk at boot. No registry, no enable-time
  network.
- **`dynamic`**: only **core** plugins ship in the image; **distributable**
  plugins are published to npm + GitHub Packages and pulled, verified, and
  loaded at runtime when first enabled.

This decouples "what code exists in the repo" (always all of it) from "what gets
installed and shipped" (all, or core-only + on-demand). The selector is
`PLUGIN_DISTRIBUTION_MODE`; default `bundled` so existing deployments are inert
to this feature.

## 2. Why this exists

In bundled mode, `pnpm install` resolves the dependency closure of all ~49
plugins, and the image carries every plugin's third-party SDK whether or not it
is enabled. Adding integrations (Principle I + the official-SDK rule, EW-682)
therefore grows install time and image size linearly with the unique SDK trees
each plugin drags in (e.g. `@kubernetes/client-node`, `@vercel/sdk`,
`@notionhq/client`, `@aws-sdk/*`). Dynamic mode lets a deployment pay only for
the plugins it uses.

## 3. Core vs distributable

Classification is declared on the plugin via the manifest field `distribution`
(`'core' | 'registry'`), defaulting from `systemPlugin`:

- **Core** (`distribution: 'core'`) — always bundled, present in both modes,
  never fetched from a registry. Comprises **every `systemPlugin: true` plugin**:
  `agent-pipeline`, `comparison-generator`, `github`, `k8s`,
  `local-content-extractor`, `local-fs`, `openrouter`, `standard-pipeline`,
  `tavily`, `vercel`. `local-fs` doubles as the **default storage backend** so the
  API boots with working storage even when no distributable storage plugin is
  enabled.
- **Distributable** (`distribution: 'registry'`) — everything else, **including**
  the storage plugins `aws-s3`, `github-storage`, and `minio`. The API today hard
  imports those three in `apps/api/package.json`; that coupling is **removed** and
  storage is resolved through the capability facade/registry, which is what lets
  them be distributable (see EW-693 T8b).

The manifest is the source of truth; the value is denormalised onto the
`plugins` row for listing.

## 4. Build & publish

Plugins build with **tsup** exactly as today (ESM `index.js` + CJS `index.cjs` +
`index.d.ts`, deps external, `@ever-works/plugin` as peer). Distribution adds a
**publish** step:

- **Versioning**: Changesets, **independent** per plugin — a plugin release does
  not require a platform release (today all plugins are lockstep `1.0.0`).
- **Targets**: each distributable plugin is published to **both** the public npm
  registry and the **GitHub Packages** `@ever-works` registry on release, via a
  CI workflow mirroring the auth pattern of `.github/workflows/publish-cli.yml`.
- **Privacy**: distributable plugins flip `private: true → false` with
  `publishConfig`; core plugins may remain unpublished.
- **Provenance**: rely on npm package integrity (sha512) and first-party npm
  provenance; no bespoke signing in v1.

## 5. Runtime install path (dynamic mode)

```
User clicks Enable (plugin not installed)
  → plugins.controller → PluginOperationsService.enable
    → PluginInstallerService.install(pluginId)
        1. resolve pkg@exactVersion from registry (PLUGIN_REGISTRY_URL / GitHub)
        2. allowlist check FIRST (first-party @ever-works/* implicit; else
           must match an enabled plugin_allowlist row) — refuse before download
        3. download + verify integrity (sha512) — mismatch ⇒ refuse
        4. place into PLUGIN_INSTALL_DIR (default /app/plugins)
        5. PluginLoaderService.load(installPath)  ← existing dynamic import()
        6. PluginRegistryService.register + persist (source='registry',
           installedVersion, integrity, installState='installed')
    → existing enable (UserPluginEntity/WorkPluginEntity flip)
```

Key properties:

- **Install ≠ enable ≠ load** stay distinct (the SDK already separates
  load/enable). Dynamic mode inserts *install + load* in front of *enable* only
  when the plugin is absent.
- **Idempotent + concurrency-guarded** per plugin id (two simultaneous enables
  of the same plugin install once).
- **Failure isolation**: a failed install records a reason on the plugin row
  (`installState='error'`) and registers nothing partial; the rest of the system
  is unaffected (spec FR-14).
- The loader is unchanged — it already resolves `main`/`module` and
  `await import(entryPath)`, and `DEFAULT_PLUGIN_PATHS` already includes
  `./plugins` and `./node_modules/@ever-works`.

## 6. Boot reconcile

Pods are ephemeral and replicas scale horizontally; the **database is the source
of truth** for which distributable plugins are installed/enabled. On
`onApplicationBootstrap` in dynamic mode, `PluginBootstrapService` reconciles:

```
for each DB plugin where source='registry' and (installed or enabled):
    if not present in PLUGIN_INSTALL_DIR (or integrity mismatch):
        PluginInstallerService.install(pinned version + integrity)
mark ready only after reconcile completes (readiness gate)
```

This makes a fresh replica converge to its peers without shared storage. A
shared RWX volume or a "bake popular plugins into the image" optimisation can
reduce cold-start cost later, but is not required for correctness.

## 7. Execution model

The base mechanism is the same dynamic `import()` everywhere; **where** a
capability call runs is decided by `PluginExecutionRouterService` from the
operation's `executionProfile`:

- **`sync` / short calls** (e.g. list models, resolve config): run **in-process**
  in the API via dynamic import. No job-runtime hop, lowest latency.
- **`long-running` calls** (e.g. a generation pipeline step): dispatched to the
  **pluggable job runtime** (Trigger.dev today). Plugin code imported inside the
  task process is **already isolated** there, and the result returns through the
  existing job result channel.

This is why v1 needs no bespoke sandbox: long-running third-party work inherits
the job runtime's isolation, and the install allowlist limits what can run at
all. Making the job-runtime provider itself swappable (Temporal / BullMQ /
others) is tracked in **EW-683** and is a dependency of the long-running path,
not part of this feature.

## 8. Security model

- **Supply chain**: install restricted to first-party `@ever-works/*` +
  admin-managed allowlist (`plugin_allowlist`); refusal happens before any
  network fetch. Exact-version pinning + integrity verification before `import()`.
- **Secrets**: registry auth tokens (GitHub Packages / private mirrors) are
  secrets sourced from env/secret store, never logged or returned. Plugin
  settings keep `x-secret` redaction (Principle VII / [settings-system](./settings-system.md)).
- **Isolation**: long-running plugin execution runs in the isolated job runtime;
  in-process execution is reserved for short calls and (in v1) trusted/allowlisted
  code. Full sandboxing (isolated-vm / microVM) is a documented future phase.

## 9. Deployment & filesystem

- The API image WORKDIR is `/app`; root FS is writable today
  (`readOnlyRootFilesystem: false`), and `/tmp` is an emptyDir. The runtime store
  defaults to `PLUGIN_INSTALL_DIR=/app/plugins`.
- **k8s**: mount a writable volume for the store (emptyDir per-replica with boot
  reconcile, or an optional PVC); gate readiness on reconcile completion.
- **bundled image** keeps shipping all plugins (current Dockerfile). The
  **dynamic image** variant ships core-only via a build arg.
- **Read-only-FS serverless** (Vercel, currently disabled) cannot install at
  runtime — those targets support `bundled` only.

## 10. Observability

- Events/activity-log: `plugin.install.requested|succeeded|failed`,
  `plugin.upgrade.*`, `plugin.uninstall.*` with id, version, source, duration,
  reason.
- Metrics: install latency/error-rate per plugin, boot-reconcile duration,
  catalog-fetch failures.
- Sentry tags: `plugin_id`, `plugin_source`, `distribution_mode`.

## 11. Failure modes

| Failure | Behaviour |
| ------- | --------- |
| Registry unreachable | New installs fail cleanly + retryable; installed plugins keep working; reconcile retries on next boot. |
| Package not permitted | Refused before download (allowlist), 409. |
| Integrity mismatch | Refused, nothing loaded, 424. |
| Invalid manifest / incompatible version | Recorded `installState='error'` + reason, 422; nothing registered. |
| Throwing plugin constructor | Same as load failure today — caught, recorded, isolated. |
| Mode switch (bundled↔dynamic) | Reconcile on restart; user enable choices preserved in DB. |

## 12. Constitution Reconciliation

| Principle | How this design respects it |
| --------- | --------------------------- |
| I — Plugin-first | Plugins stay the integration unit; this is supply-chain plumbing. |
| II — Capability-driven | Resolution/enable unchanged; install precedes them. |
| III — Source-of-truth repos | Unaffected. |
| IV — Trigger.dev | Long-running plugin execution routed through the job runtime. |
| V — Forward-only migrations | New columns/table additive with defaults. |
| VI — Tests | Installer/allowlist/reconcile/router/publish all tested. |
| VII — Secret hygiene | Registry tokens + plugin creds are secrets; `x-secret` preserved. |
| VIII — Plugin counts | Canonical built-in-plugins doc carries core vs distributable split. |
| IX — Behaviour-first | Behaviour in the feature spec; this is architecture. |
| X — Backwards-compat | Default `bundled` preserves current behaviour; all additions additive. |

## 13. References

- Feature spec: [`features/dynamic-plugin-distribution/spec`](../features/dynamic-plugin-distribution/spec.md)
- Plan: [`features/dynamic-plugin-distribution/plan`](../features/dynamic-plugin-distribution/plan.md)
- ADR: [`decisions/015-dynamic-plugin-distribution`](../decisions/015-dynamic-plugin-distribution.md)
- SDK: [`plugin-sdk`](./plugin-sdk.md)
- Deployment: [`deployment`](./deployment.md)
- Trigger.dev: [`trigger-integration`](./trigger-integration.md)
- Source today: `packages/agent/src/plugins/`, `packages/agent/src/plugins/plugins.constants.ts`
  (`DEFAULT_PLUGIN_PATHS`), `apps/api/src/config/constants.ts`
- Jira: EW epic (this feature), [EW-683] (job-runtime pluggability)
