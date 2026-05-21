# Implementation Plan — github-storage LFS + dual repo modes (EW-644)

**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md) · **Status**: `Draft` · **Updated**: 2026-05-21

---

## 0. PR scope

One PR against `develop`, branch `session/github-storage-lfs-ew644`. The PR touches three packages:

| Package                                | What changes                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ever-works/plugin`                   | Additive: `workId?: string` on `StoragePutInput`. No breaking change.                                                                                                                                     |
| `@ever-works/github-storage-plugin`    | Settings schema + `package.json` `everworks.plugin` block grow; new `lfs-batch.ts`, `work-repo-resolver.ts` helper modules; `github-storage.plugin.ts` is rewritten around the mode/transport/LFS switch. |
| `apps/api/src/uploads`                 | `StorageBackendFactory` wires a `workRepoResolver` into the github-storage plugin context; `UploadsController`/`UploadsService` thread `workId` from the dashboard route into `StoragePutInput`.          |
| `apps/web/src/components/plugins/form` | Two new widgets: `GithubOwnerWidget`, `GithubRepoWidget`. They reuse the dropdown bits from `RepositorySelector.tsx`.                                                                                     |

No DB migration. No new dependencies.

## 1. Sequencing rationale

Build the plugin core first (most blast radius, easiest to test in isolation) → wire through the API uploads pipeline (needs `workId`) → finally the Web UI widgets. The PR sequences commits the same way, so a reviewer reading top-to-bottom never has to context-switch between layers more than once.

## 2. Code map (proposed file additions)

```
packages/plugins/github-storage/src/
  github-storage.plugin.ts        # rewritten — mode/transport/LFS switch, lazy config
  lfs-batch.ts                    # NEW — LFS Batch API client (no native deps)
  lfs-pointer.ts                  # NEW — pointer file format + .gitattributes helpers
  transport/
    contents-api.ts               # NEW — extracted Octokit Contents API path
    clone-and-push.ts             # NEW — isomorphic-git path (uses @ever-works/plugin GitOperations)
    git-cli.ts                    # NEW — execa shell-out for lfsTransport=git-cli
  work-repo-resolver.ts           # NEW — interface only; impl lives in apps/api
  __tests__/
    github-storage.plugin.spec.ts # NEW — Vitest, mode × LFS × transport matrix
    lfs-batch.spec.ts             # NEW
    lfs-pointer.spec.ts           # NEW

packages/plugin/src/contracts/capabilities/
  storage.interface.ts            # additive: workId?: string on StoragePutInput

apps/api/src/uploads/
  storage-backend.factory.ts      # extend stub context with workRepoResolver for github-storage
  work-repo-resolver.service.ts   # NEW — NestJS impl reading from WorkRepository
  uploads.controller.ts           # accept optional workId on the dashboard route (existing JWT-gated)
  uploads.service.ts              # thread workId into StoragePutInput
  __tests__/
    storage-backend.factory.spec.ts # exercise workRepoResolver wiring
    uploads.service.workid.spec.ts  # asserts workId reaches the backend

apps/web/src/components/plugins/form/
  GithubOwnerWidget.tsx           # NEW — reuses OwnerFilter
  GithubRepoWidget.tsx            # NEW — reuses repo list
  PluginSettingsField.tsx         # widget switch gains "github-owner" + "github-repo"

apps/web/e2e/
  github-storage-settings.spec.ts # NEW — Playwright UI walkthrough
  github-storage-upload.spec.ts   # NEW — mocked upload round-trip
```

## 3. Risks and mitigations

| Risk                                                                                                                       | Mitigation                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clone-and-push` per upload is slow under load.                                                                            | Default `transport: auto` resolves to `contents-api` for mode A. Document the trade-off in the spec §11 and ship a perf-follow-up ticket if observed in practice. No magical batching in this PR.         |
| LFS pointer commit succeeds but blob PUT to the signed URL fails (network) — repo now has a dangling pointer.              | Order: blob PUT **first**, then pointer commit. If PUT fails, no pointer is written, so a retry is safe and idempotent. Test: simulate PUT failure via `nock` and assert no commit happens.               |
| `useGitCli` requires binaries the container may not have.                                                                  | Plugin probes for `git` and `git-lfs` at `onLoad()` when `lfsTransport: git-cli` is selected; throws a clear configuration error if missing. Test exercises the missing-binary path.                      |
| `WorkRepoResolver` introduces a circular import (uploads → agent → uploads).                                               | Resolver is wired through `PluginContext` (`as unknown as`), not via direct workspace import. Plugin defines an interface; the API supplies the impl. Existing `makeStubContext` already uses this trick. |
| Existing `STORAGE_BACKEND=github-storage` deployments behave differently after upgrade because LFS now defaults to `true`. | Migration rule §8 in spec: if no `mode` and no `lfsEnabled` keys exist in the settings record AND the GH*STORAGE*\* env vars are set, `lfsEnabled` resolves to `false`. Codified in unit tests.           |
| `showIf` in the form renderer compares `value === expected`, but `mode` may briefly be `undefined` during initial render.  | Unit test the resolver with `undefined` → default; the existing renderer already handles undefined gracefully (treats it as `!== expected` → hide). Verified visually in the e2e setting walkthrough.     |

## 4. Roll-back plan

- Revert the PR. No DB migration, no settings migration to roll back.
- For deployments that already enabled LFS and then need to roll back: existing LFS pointer files in the repo remain valid (LFS is widely supported), but reading them through the plugin requires LFS enabled. Document that disabling LFS on a repo that already has LFS pointer files leaves those keys un-fetchable through the plugin until the operator re-enables LFS or migrates the bytes back. Add this to the README.

## 5. Definition of done

- All acceptance criteria in spec §10 ticked.
- `pnpm test` green at the repo root.
- `pnpm lint` and `pnpm type-check` green.
- Bot review on the PR (CodeRabbit + Greptile + Codex) resolved per NN #14 / #18.
- CI green per NN #19.
- PR description links the spec, plan, tasks, and JIRA EW-644.
