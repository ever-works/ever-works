# Changesets — Ever Works npm package releases (EW-693)

Every package in the npm release — `@ever-works/contracts`, the plugin SDK
`@ever-works/plugin` and each distributable plugin under `packages/plugins/*`
— versions independently per
[EW-693 / FR-7](../docs/specs/features/dynamic-plugin-distribution/spec.md#3-functional-requirements).
A plugin release does **not** require a platform release.

## How versions are cut (since 2026-09)

**You usually do nothing.** `.github/workflows/publish-plugins.yml` runs
`scripts/release-npm-packages.mjs` on every push to `main` (every production
build). For each package it fingerprints exactly what `npm pack` would ship
and compares it with the newest published version:

- unchanged → nothing is published;
- changed → the next **patch** is published automatically (`1.0.4` → `1.0.5`);
- `package.json` ahead of everything published (a deliberate bump) → that
  version is published.

Both npmjs.org and GitHub Packages get the same tarball, publicly.

## When you do need a changeset

Only for a deliberate **minor** or **major** bump (a new SDK capability, a
breaking plugin change):

```bash
pnpm changeset            # pick the package(s) and minor/major, write a summary
```

Commit the generated `.changeset/*.md` file in your PR — that is all. The
release script reads pending changesets itself and raises the version of the
packages a changeset **names** (and only those) by the declared bump, e.g.
`@ever-works/plugin` 1.1.0 + `minor` → 1.2.0.

> **Do not run `pnpm changeset version` in this repo.** Plugins declare the
> SDK as a `workspace:*` peer dependency, and Changesets bumps every peer
> dependent to a **major** when the SDK takes a minor: one additive SDK change
> would turn ~36 plugins into `2.0.0`, and npm never lets a published version
> number be taken back.

After the bumped version is released, consume the changeset in a follow-up PR:
delete the file and set the package's `package.json` version to the released
one (otherwise a later changeset of the same type for the same package is
already satisfied and would not bump again).

## Defaults pinned in `config.json`

- `access: public` — the platform is open source; every package publishes
  publicly (it was `restricted` from 2026-06-03 until 2026-09).
- `commit: false` — changesets are NOT auto-committed; they're part of
  the PR.
- `baseBranch: develop` — release cascade matches the platform release
  flow (`develop → stage → main`).
- `updateInternalDependencies: patch` — when a workspace dep bumps,
  consuming packages get a patch bump.
- `ignore` — internal apps (`ever-works-*`, `@ever-works/cli`) and
  platform-internal packages (`@ever-works/agent`, …) version with the
  platform, **not** independently. `@ever-works/plugin` and
  `@ever-works/contracts` are intentionally NOT ignored: they ship to npm
  (the SDK for 3rd-party plugin authors, and the types it and a dozen
  plugins depend on at runtime). Changesets refuses to load a config that
  ignores a package that non-ignored packages depend on.

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
  T11 — `.github/workflows/publish-plugins.yml`; T12 — release script
  (now `scripts/release-npm-packages.mjs`).
