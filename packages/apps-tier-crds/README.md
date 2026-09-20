# `@ever-works/apps-tier-crds`

The **Kubernetes API contract** of the Ever Works Apps hosting tier (APW-10): the five
`hosting.ever.works/v1alpha1` CRD schemas as code, and the generator that renders them to
[`deploy/crds/*.yaml`](deploy/crds/).

| Kind          | File                                                 | Manifest                                             |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `Work`        | [`src/crds/work.ts`](src/crds/work.ts)               | [`works.yaml`](deploy/crds/works.yaml)               |
| `AppBuild`    | [`src/crds/appbuild.ts`](src/crds/appbuild.ts)       | [`appbuilds.yaml`](deploy/crds/appbuilds.yaml)       |
| `UsageReport` | [`src/crds/usagereport.ts`](src/crds/usagereport.ts) | [`usagereports.yaml`](deploy/crds/usagereports.yaml) |
| `SelfCheck`   | [`src/crds/selfcheck.ts`](src/crds/selfcheck.ts)     | [`selfchecks.yaml`](deploy/crds/selfchecks.yaml)     |
| `AbuseSignal` | [`src/crds/abusesignal.ts`](src/crds/abusesignal.ts) | [`abusesignals.yaml`](deploy/crds/abusesignals.yaml) |

## Why this is a library

Both ends of the hosting tier need the same schema and **neither may fork it**:

- the **platform** (`apps/api`, through the `apps-tier` plugin capability) _writes_ `Work` objects
  and _reads_ their `status`;
- the **controller** ([`apps/apps-tier-controller`](../../apps/apps-tier-controller/)) runs inside
  the hosting zone and reconciles them.

Nothing here touches a cluster, reads a kubeconfig, or reconciles anything — it is pure schema, so
every spec is hermetic by construction. Constants (`APPS_TIER_API_GROUP`, `APPS_TIER_API_VERSION`,
`APPS_TIER_MAX_SEALED_ENV_BYTES`, …) are imported from `@ever-works/contracts` and never re-spelled.

> **Layout note (owner ruling, 2026-09-20).** This shipped originally as `apps/apps-tier-controller`.
> It moved here because `apps/*` in this monorepo means “a thing that starts a process”, and this
> package has no `start` and no `bin` — it builds dual CJS+ESM with `.d.ts`, which is a library.
> The process half kept the old path and the old package name.

## Commands

```bash
pnpm --filter @ever-works/apps-tier-crds test              # 47 tests, incl. the manifest drift gate
pnpm --filter @ever-works/apps-tier-crds type-check
pnpm --filter @ever-works/apps-tier-crds generate:crds     # rewrite deploy/crds/*.yaml
pnpm --filter @ever-works/apps-tier-crds generate:crds:check   # one-line drift report for CI
```

## The drift gate

`deploy/crds/*.yaml` are **generated artefacts that are committed**, and
[`src/crds/__tests__/crds.spec.ts`](src/crds/__tests__/crds.spec.ts) compares the committed bytes
against a fresh generation — including the header comment, which is part of the artefact. So:

- a hand edit to a manifest fails the suite, and the header's first line says where the edit belongs;
- a schema change and the manifests it produces are always **one commit**;
- a stray `.yaml` in that directory is drift too — the zone's installer applies the whole directory,
  so an ungenerated manifest would be installed by nobody's schema.

Run `generate:crds` and commit the result; never edit `deploy/crds/` by hand.
