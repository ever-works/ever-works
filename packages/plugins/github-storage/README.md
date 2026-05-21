# `@ever-works/github-storage-plugin`

Storage backend that writes uploaded objects as files in a GitHub repository.

## Modes

The plugin exposes a `mode` setting with two values:

### `separate-repo` (default)

A dedicated GitHub repository owned by the operator stores every upload.
The owner and repo name come from the plugin settings UI (which reuses
the OAuth-connected owner/repo selectors from the Work-creation flow)
or from the legacy environment variables.

This is the original behaviour from EW-637 and remains the default for
backwards compatibility.

### `data-repo`

Uploads are written to each Work's **existing data repo**. The plugin
resolves the destination repo per upload by reading the Work's `owner`
and storage configuration. The OAuth token of the user who owns the
Work is used for authentication.

`data-repo` mode requires the API to inject a `WorkRepoResolver` into
the plugin's `PluginContext` at boot, which is what
`apps/api/src/uploads/storage-backend.factory.ts` does for the
`github-storage` backend.

`data-repo` mode also requires that each upload carries the `workId`
field in `StoragePutInput`. The API layer threads it through from the
dashboard upload route. Anonymous uploads are not supported in this
mode — the plugin throws a configuration error in that case.

## Git LFS

When `lfsEnabled` is `true`, the plugin uploads the blob to GitHub's
LFS storage via the LFS Batch API and commits a small pointer file in
the git tree. It also keeps a `.gitattributes` entry at the repo root
that tracks `<pathPrefix>/**` via LFS (added idempotently).

`lfsEnabled` defaults to **`true`** for fresh deployments, and
**`false`** for deployments that already had the legacy env vars set
without an explicit `mode` — that preserves byte-for-byte commit shape
for existing setups (see the migration rule in the spec at
`docs/specs/features/github-storage-lfs/spec.md#8-migration--rollout`).

LFS deletes are best-effort: deleting the pointer commit removes the
file from the branch tree, but the underlying LFS object stays
referenced by any older commits and the public GitHub API does not
expose an LFS object purge endpoint. This matches the standard
`git lfs rm` behaviour and is intentional.

## Transport

The `transport` setting controls how the pointer or raw blob is
committed:

| Value            | Behaviour                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `auto` (default) | `contents-api` for `separate-repo`, `clone-and-push` for `data-repo`.                                      |
| `contents-api`   | Direct `Octokit.repos.createOrUpdateFileContents` call. No working tree.                                   |
| `clone-and-push` | `isomorphic-git` clone + commit + push — the same path the rest of the platform uses for data-repo writes. |

A future ticket will add a `git-cli` LFS transport (shell-out to `git`

- `git-lfs`); the LFS Batch API is sufficient for github.com and avoids
  a runtime dependency on the binaries.

## Environment variables

| Variable                         | Notes                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_STORAGE_MODE`            | `separate-repo` (default) or `data-repo`.                                                                                  |
| `GITHUB_STORAGE_TOKEN`           | PAT with `contents:write` on the storage repo. Required in `separate-repo` mode.                                           |
| `GITHUB_STORAGE_OWNER`           | Required in `separate-repo` mode.                                                                                          |
| `GITHUB_STORAGE_REPO`            | Required in `separate-repo` mode.                                                                                          |
| `GITHUB_STORAGE_BRANCH`          | Default `main`.                                                                                                            |
| `GITHUB_STORAGE_PATH_PREFIX`     | Default `uploads`.                                                                                                         |
| `GITHUB_STORAGE_LFS_ENABLED`     | `true`/`false`. See defaults above.                                                                                        |
| `GITHUB_STORAGE_TRANSPORT`       | `auto` / `contents-api` / `clone-and-push`.                                                                                |
| `GITHUB_STORAGE_PUBLIC_URL_BASE` | Optional: public raw URL base (e.g. CDN in front of a public repo). When unset, reads route through the authenticated API. |

## Tickets

- EW-637 — initial Storage Plugins category and the `local-fs` / S3 /
  MinIO / GitHub backends.
- EW-644 — this plugin's LFS support, `data-repo` mode, and the reused
  OAuth-backed owner/repo selectors.
