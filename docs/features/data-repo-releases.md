---
id: data-repo-releases
title: Data Repository Releases
sidebar_label: Data Repository Releases
sidebar_position: 15
---

# Data Repository Releases

Every Work in Ever Works is backed by a **data repository** — the Git repo (conventionally `<work-slug>-data`) that holds `data/`, `markdown/`, `categories.yml`, `tags.yml` and the rest of the generated content. Each generation run pushes a new commit there.

A commit hash is a poor version identifier for consumers. It does not sort, it does not say whether anything meaningful changed, and it cannot be pinned in a changelog or a release note. **Data repository releases** solve that: a small GitHub Actions workflow inside each data repository turns every content update on the default branch into an annotated `vX.Y.Z` tag plus a GitHub Release with generated notes.

Downstream, a generated website can display or pin an exact data version instead of a bare hash, and anyone browsing the repository sees a readable history of what the AI changed and when.

:::tip Nothing to configure
The workflow uses the built-in `GITHUB_TOKEN`. There are no secrets to add, no variables to set, and no external services involved.
:::

## Installation

### Automatically (the normal path)

The Ever Works data generator installs the workflow itself. Whenever it creates, imports, or regenerates a data repository, it writes `.github/workflows/release.yml` and pushes it as its own commit right after the data push succeeds:

- **first generation** — the file is created;
- **later generations** — nothing happens, unless the platform ships a newer revision of the workflow, in which case its own copy is upgraded in place;
- **a `RECREATE`** — `.github` is on the reset allowlist, so the workflow survives a full content rebuild.

Seeding is best-effort and deliberately runs _after_ the data has been pushed. If it fails, the generation still succeeds and a warning is logged; releases simply are not tagged until the cause is fixed (see [Troubleshooting](#troubleshooting)).

### Manually (any repository, including ones Ever Works does not manage)

The workflow is a plain, dependency-free GitHub Actions file. To install it by hand, copy

```
packages/agent/src/generators/data-generator/assets/data-repo-release.yml
```

into the target repository as `.github/workflows/release.yml`, commit, and push to the default branch. Nothing else is required.

### Backfilling repositories that already exist

Repositories created before this feature shipped only pick the workflow up on their next generation. To close that gap immediately, run the one-shot operator script from the platform repo root:

```bash
# preview — writes nothing
node scripts/seed-data-repo-release-workflow.mjs --dry-run

# apply to every ever-works/*-data repository
node scripts/seed-data-repo-release-workflow.mjs

# a single repository
node scripts/seed-data-repo-release-workflow.mjs --repo awesome-vector-databases-data
```

It drives the `gh` CLI, so it uses whatever GitHub login `gh auth status` reports — no token handling. It is idempotent and never overwrites a `release.yml` that the repository owner authored (see [Ownership](#ownership-of-the-file)).

Useful options: `--org <login>` (default `ever-works`), `--suffix <text>` (default `-data`), `--limit <n>`, `--include-archived`.

## What the workflow does

| Aspect          | Behaviour                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**     | Push to `main` or `master` touching `data/**`, `markdown/**`, `pages/**`, `categories.yml`, `collections.yml`, `tags.yml` or `references.yml`; plus `workflow_dispatch` for a manual run. |
| **Permissions** | `contents: write` only — enough to push a tag and cut a release, nothing more.                                                                                                            |
| **Concurrency** | Serialized per ref with `cancel-in-progress: false`, so a queued release is never cancelled mid-bump when the generator pushes several commits in quick succession.                       |
| **Output**      | An annotated `vX.Y.Z` tag on the pushed commit and a GitHub Release whose notes GitHub generates from the commits since the previous release.                                             |

A settings-only edit to `.works/works.yml` is deliberately **not** a release trigger — changing the site theme is not a new version of the data. Use the manual run if you want a release anyway.

## Version numbering

The workflow resolves the next version in this order, stopping at the first hit:

1. the explicit `version` input, when the run was started manually;
2. `version:` from `.works/works.yml` — the value the data generator already bumps on every generation — when it is a valid semver that has not been released yet;
3. the newest existing `v*` tag, incremented;
4. `0.1.0`, for a repository that has never been released.

Increments use exactly the rollover rules the platform's `DataRepository.getNextVersion()` applies, so tags and `.works/works.yml` never drift apart:

- patch + 1;
- a patch reaching **100** rolls into the next minor;
- a minor reaching **10** rolls into the next major.

Two safety properties matter in practice:

- **A commit is never released twice.** If `HEAD` already carries a `vX.Y.Z` tag the run exits without creating anything, so re-running the workflow by hand is safe.
- **A tag pushed while the run was queued does not collide.** The resolved version is bumped again until it is free.

## Ownership of the file

The workflow carries two marker comments:

```yaml
# x-ever-works-workflow: data-repo-release
# x-ever-works-workflow-version: 1
```

The platform uses them to recognise the copy it owns:

| State of `.github/workflows/release.yml` | What the generator does        |
| ---------------------------------------- | ------------------------------ |
| Absent                                   | Creates it.                    |
| Managed copy at an older revision        | Upgrades it in place.          |
| Managed copy at the current revision     | Leaves it alone.               |
| No `x-ever-works-workflow` marker        | Leaves it alone — permanently. |

So a repository owner can take full ownership of the workflow simply by deleting the marker line, or adapt it freely without bumping the version number. The platform will never overwrite a file it does not recognise as its own.

## Troubleshooting

**No release appeared after the _first_ generation.** Expected. The workflow is committed after the data push, so on a brand-new repository it is not yet present when that first content push happens. The next content update releases normally, or you can cut the first release immediately from **Actions → Release data → Run workflow**.

**No release appeared after a later generation.** Check the repository's Actions tab. The commonest causes are: the push landed on a PR branch rather than the default branch (the generator only seeds and releases on the default branch); the changed paths were outside the trigger list; or `HEAD` was already tagged.

**The generation log warns that the workflow could not be installed.** GitHub refuses a push that touches `.github/workflows/**` unless the credential carries the `workflow` scope. The platform's GitHub connection requests it as part of `GITHUB_FULL_SCOPES`, but a token minted before that scope was added will not have it — reconnect GitHub from **Settings → Git Providers** to re-authorise. For the backfill script, run `gh auth refresh -h github.com -s workflow`.

**Actions are disabled on the repository.** A workflow file can be pushed but will never run. Enable Actions in the repository settings.

## Related

- [Data Generation](../ai-agents/data-generation.md) — how the data repository is produced, and where version numbers come from.
- [Git Operations](./git-operations.md) — the `GitFacadeService` layer the generator commits and pushes through.
- [Work Changelog](./work-changelog.md) — the human-readable record of what each generation changed.
