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

### LFS transport

The `lfsTransport` setting picks how LFS objects reach the server:

| Value           | Behaviour                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api` (default) | Calls the GitHub LFS Batch API over HTTPS directly via the Octokit token. No `git`/`git-lfs` binaries needed. Recommended for almost every deployment.                                                                                                                                |
| `git-cli`       | Shells out to `git` + `git-lfs`. Clones to a temp dir, runs `git lfs install --local`, `git lfs track "<pathPrefix>/**"`, writes the file, `git add`, `git commit`, `git push`. Requires both binaries on PATH (the plugin probes at boot and refuses to start if either is missing). |

The `git-cli` path is reserved for hosts that would rather rely on the
native binaries than HTTP signed URLs — e.g. environments that proxy
git but block the LFS Batch host, or shops with strict supply-chain
rules about which HTTP clients can talk to GitHub.

## Write transport (non-LFS)

The `transport` setting controls how the pointer or raw blob is
committed when **`lfsTransport: api`** is in use (the `git-cli` path
handles the whole flow itself):

| Value            | Behaviour                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `auto` (default) | `contents-api` for `separate-repo`, `clone-and-push` for `data-repo`.                                      |
| `contents-api`   | Direct `Octokit.repos.createOrUpdateFileContents` call. No working tree.                                   |
| `clone-and-push` | `isomorphic-git` clone + commit + push — the same path the rest of the platform uses for data-repo writes. |

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
| `GITHUB_STORAGE_LFS_TRANSPORT`   | `api` (default) / `git-cli`. The `git-cli` path requires `git` ≥ 2.40 and `git-lfs` ≥ 3.4 on PATH.                         |
| `GITHUB_STORAGE_TRANSPORT`       | `auto` / `contents-api` / `clone-and-push`.                                                                                |
| `GITHUB_STORAGE_PUBLIC_URL_BASE` | Optional: public raw URL base (e.g. CDN in front of a public repo). When unset, reads route through the authenticated API. |

## Tickets

- EW-637 — initial Storage Plugins category and the `local-fs` / S3 /
  MinIO / GitHub backends.
- EW-644 — this plugin's LFS support, `data-repo` mode, and the reused
  OAuth-backed owner/repo selectors.
