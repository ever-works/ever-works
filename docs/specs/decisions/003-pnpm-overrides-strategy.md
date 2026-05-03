# ADR-003: `pnpm.overrides` for Transitive Vulnerability Pinning

## Status

**Accepted** — In use

## Date

2026-05-02

## Context

Like every monorepo with a deep dependency graph, the Ever Works
platform regularly accumulates Dependabot vulnerability alerts on
**transitive** dependencies — packages we don't import directly but
that come in via something we do (e.g. `protobufjs` via Google AI
SDK, `minimatch` via every Glob library, `vite` via Docusaurus).

In one cleanup pass during this session we went from **74
vulnerability alerts (1 critical, 37 high, 33 moderate, 3 low)** down
to **23 (0 critical, 9 high, 13 moderate, 1 low)** without bumping
any of our direct dependencies. The remaining 23 are alerts where
the safe upgrade is also a major-version bump for one of our
top-level deps and needs separate validation.

This ADR records how we did it, why we chose this mechanism over the
alternatives, and the rules we follow when adding/removing entries.

## Decision

We use **`pnpm.overrides`** in the root `package.json` to force-pin
unsafe transitive dependencies to safe versions across the entire
workspace.

```jsonc
// package.json (excerpt — current state on develop)
{
	"pnpm": {
		"overrides": {
			"protobufjs@<7.5.5": ">=7.5.5",
			"protobufjs@>=8.0.0 <8.0.1": ">=8.0.1",
			"minimatch@<3.1.4": ">=3.1.4",
			"minimatch@>=4.0.0 <9.0.7": ">=9.0.7",
			"minimatch@>=10.0.0 <10.2.3": ">=10.2.3"
			// ... 17 more entries
		}
	}
}
```

Every entry uses **versioned override syntax**: the key is the
range that should be replaced (e.g. `"protobufjs@<7.5.5"`), the
value is the safe range (`">=7.5.5"`). Entries are scoped to the
problem semver range so we don't accidentally force-bump a major
version when only some sub-ranges are vulnerable.

## Rules of the Road

### Adding an override

A new override is justified when:

1. Dependabot (or `pnpm audit`) reports a CVE on a transitive
   package.
2. We can't easily upgrade the direct dep that pulls it in (because
   that's a major-version bump or because the maintainer hasn't
   shipped a patched version yet).
3. The override version is **a patch / minor bump within the same
   major** as the version we'd be using anyway. If it's a major bump,
   it goes into a follow-up rather than an override (see "When NOT
   to use overrides" below).

Steps:

1. Read the Dependabot alert to confirm the CVE applies to our
   actual usage (some CVEs only fire under specific configs).
2. Add a versioned override (`"<pkg>@<vulnerable-range>": ">=<safe-version>"`).
   Use a precise lower bound — `<7.5.5` not just `*` — so we don't
   force-pin packages that aren't vulnerable.
3. Run `pnpm install` and watch for resolution errors. If pnpm
   refuses (peer dep mismatch), back off to a wider safe range or
   drop the override.
4. **Run `pnpm --filter ever-works-docs build` and `pnpm test`.**
   Overrides are a blunt instrument — they can break consumers that
   relied on the old API. We learned this the hard way (see "Lessons
   Learned" below).
5. Commit with a message that names the package and the CVE class,
   e.g. `chore(security): force minimatch >=9.0.7 to fix CVE-XXX`.

### Removing an override

An override should come out when:

1. The package that pulled in the vulnerable version has shipped a
   release that pins a safe range itself, **and** we've upgraded to
   that release.
2. We've moved off the package entirely (rare for transitives).

Steps:

1. Verify with `pnpm why <pkg>` that the new direct-dep version no
   longer pulls in the vulnerable range.
2. Remove the override entry.
3. Run `pnpm install` + Docusaurus build + tests.
4. Commit with `chore(security): drop now-unnecessary <pkg> override`.

We **don't** leave dead overrides around "just in case" — they
silently cap future upgrades and accumulate maintenance debt.

### When NOT to use overrides

`pnpm.overrides` is the wrong tool when:

- **The required version is a major bump** that breaks the
  consumer's API. We hit this with `path-to-regexp` — Docusaurus 6
  uses `v6` API; forcing `>=8.4.0` produced
  `(0, path_to_regexp.default) is not a function` at build time.
  Reverted, then the right answer was to wait for Docusaurus to
  release a version that pulls a safe `path-to-regexp` itself.
- **The fix needs a code change in our code.** If the CVE requires
  a config change (e.g. disabling a vulnerable feature) the override
  alone won't help.
- **The CVE doesn't actually apply to our usage.** Sometimes the CVE
  fires on a code path we don't take. Documenting "we don't use this
  feature so the CVE is N/A" in a comment near the dep is better
  than silently force-bumping.
- **The package is in our own workspace.** Workspace packages move
  via direct version bumps in their `package.json`, not via the
  root override block.

## Implementation

The whole mechanism is a single block in the root `package.json` —
no scripts, no CI integration, no extra tooling. `pnpm install`
applies overrides automatically; `pnpm.lockfile` records the
resolved versions for reproducibility.

We rely on:

- **pnpm's versioned override syntax** to scope each override to a
  specific range, so we don't force-bump packages that aren't
  vulnerable.
- **The lockfile** (`pnpm-lock.yaml`) to ensure all developers and
  CI converge on the same resolved versions.
- **Dependabot security alerts** as the source of truth for which
  packages need overrides.

## Why this and not the alternatives

### Why `pnpm.overrides` over `npm overrides` / Yarn `resolutions`

We're already on pnpm — those alternatives don't apply. pnpm's
override syntax is the workspace-aware version of the same mechanism.

### Why not fork the dependency

For most CVEs, the upstream fix is a patch release away. Forking
adds a maintenance burden that scales linearly with the number of
patched packages — the override block stays at zero maintenance once
written.

We'd consider forking only if:

- The package is unmaintained (no fix coming).
- The fix requires a behaviour change we have a strong opinion about.
- The package is small enough to fork and maintain in-tree.

None of those apply to any current override.

### Why not patch-package / `pnpm.patchedDependencies`

Patches are great when the fix is **a code change to the dep**.
Overrides are right when the fix is **a version bump**. Most CVEs in
our tree are version-bump fixes — the upstream maintainer fixed it
in a later release, the issue is just that some intermediate
package hasn't updated its peer dep yet.

We'll switch to a patch when:

- The fix isn't in any released version yet.
- We've been waiting > 30 days for upstream.

Currently zero patched dependencies on `develop`.

### Why not just bump the direct dependency

When we can, we do — it's strictly better than an override because
it doesn't accumulate the "this is here because of CVE-XYZ" memory
cost. But many of our direct deps cap their transitive ranges in
`package.json` peer constraints — bumping them requires bumping the
direct dep itself (often a major), which is its own validation
exercise.

The override block is the bridge: ship the safe version
**immediately** to clear the alert, queue the proper direct-dep
upgrade as a follow-up, then drop the override when the direct-dep
upgrade lands.

## Consequences

### Positive

- One PR can clear multiple CVE alerts in minutes rather than
  separate dep-upgrade PRs each with their own validation.
- Transitives stay current automatically across the workspace —
  every `pnpm install` re-applies the rules.
- The override block is a transparent record of "what's being
  patched" — easy to audit, easy to remove.

### Negative

- Overrides are global and wholesale. A bad override breaks every
  consumer of the package in the workspace. We hit this once already
  (path-to-regexp + Docusaurus).
- Versioned overrides are easy to write incorrectly — the syntax is
  subtle (`@<X.Y.Z` vs `@>=A.B.C <X.Y.Z`) and pnpm errors are
  cryptic.
- An override silently caps the dep at `>=safe-version` even when
  the original consumer would have happily picked something newer.
  Periodic cleanup is required.

### Mitigations

- **Always rebuild the docs site after adding an override.** The
  Docusaurus build is the canary — it pulls in the most third-party
  code in the workspace and surfaces breakage fast.
- **Always run the full test suite after adding an override.**
  Especially the agent package, which exercises the most diverse
  transitive surface.
- **Document non-obvious overrides** with a comment in `package.json`
  (when JSON5 is allowed) or a one-line note in the commit message.
- **Periodic sweeps** — every couple of months, run `pnpm why <pkg>`
  on each override and drop the ones whose direct-dep
  consumers have caught up.

## Lessons Learned

- **path-to-regexp**: forced `>=8.4.0` to clear a CVE; Docusaurus 6
  uses the v6 API; build broke with `(0, path_to_regexp.default) is
not a function`. Resolution: drop the override, wait for the
  Docusaurus 7 upgrade. The takeaway: **major-version overrides on
  packages with API changes are not safe**, even when the lower
  bound is correct.
- **Em-dash slug collisions in markdown**: unrelated to overrides
  but discovered during the same session — Docusaurus collapses
  some Unicode dashes differently in slug generation. Always run
  the docs build after content changes too.
- **CRLF warnings on `git status`**: some files show as modified
  with CRLF warnings but no actual diff content. These are noise
  from the platform line-ending normalization, safe to ignore when
  staging a commit but easy to confuse with real changes.

## Related

- Root `package.json` — the canonical override block
- `pnpm-lock.yaml` — the resolved versions
- [`architecture/deployment`](../architecture/deployment.md) — env
  pins and Docker image build flow that consume the locked tree
- [GitHub Dependabot alerts](https://github.com/ever-works/ever-works/security/dependabot)
  — source of truth for which CVEs need handling
- [`decisions/001-pipeline-checkpointing`](./001-pipeline-checkpointing.md)
- [`decisions/002-trigger-worker-callback-channel`](./002-trigger-worker-callback-channel.md)
