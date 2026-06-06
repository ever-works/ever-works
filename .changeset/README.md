# Changesets — Ever Works plugin releases (EW-693)

Each distributable plugin under `packages/plugins/*` versions
independently per [EW-693 / FR-7](../docs/specs/features/dynamic-plugin-distribution/spec.md#3-functional-requirements).
A plugin release does **not** require a platform release.

## Quick start

```bash
# 1. Add a changeset describing your plugin change
pnpm changeset

# 2. Inspect: a markdown file appears under .changeset/
# Add a one-line summary and pick patch/minor/major per plugin.

# 3. CI handles the rest:
#    - pnpm changeset version  → bumps versions + writes CHANGELOG.md
#    - pnpm changeset publish  → publishes to npm + GitHub Packages
#    Triggered by .github/workflows/publish-plugins.yml on push to main
#    or manual workflow_dispatch.
```

## Defaults pinned in `config.json`

- `access: restricted` — plugins publish as **PRIVATE** packages on npm.
  The user explicitly directed this (2026-06-03): no plugin goes public
  without case-by-case authorisation. To flip a single plugin to
  public, override `"access": "public"` on the changeset markdown OR
  set `publishConfig.access` on that plugin's `package.json` and add
  a reviewer note.
- `commit: false` — changesets are NOT auto-committed; they're part of
  the PR.
- `baseBranch: develop` — release cascade matches the platform release
  flow (`develop → stage → main`).
- `updateInternalDependencies: patch` — when a workspace dep bumps,
  consuming packages get a patch bump.
- `ignore` — internal apps (`ever-works-*`) and platform-internal
  packages (`@ever-works/agent`, `@ever-works/contracts`, …) version
  with the platform, **not** independently. `@ever-works/plugin` is
  intentionally NOT in `ignore` — it ships to npm as the SDK consumed
  by 3rd-party plugin authors.

## Why per-plugin versioning?

Until EW-693, every plugin under `packages/plugins/*` was at lockstep
`1.0.0`. That works when everything ships in one image but does not
work for dynamic distribution:

- A bug-fix to `@ever-works/notion-extractor-plugin` should bump that
  plugin's patch version, not every other plugin's.
- The platform's runtime installer pins
  `@ever-works/<name>@<exact-version>` and verifies integrity (FR-10).
  Lockstep makes "pin exact version" meaningless — every install
  resolves to the same version regardless of what changed.

Independent versions also let the catalog UI surface "1.2.0 available"
correctly per plugin.

## Spec links

- Spec: `docs/specs/features/dynamic-plugin-distribution/spec.md` — FR-7.
- Plan: `docs/specs/features/dynamic-plugin-distribution/plan.md` — Phase 3.
- Tasks: T9 — this config; T10 — `private:false` + `publishConfig`;
  T11 — `.github/workflows/publish-plugins.yml`; T12 — orchestrator
  script.
