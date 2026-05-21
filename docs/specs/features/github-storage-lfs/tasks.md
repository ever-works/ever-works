# Task Breakdown — github-storage LFS + dual repo modes (EW-644)

**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md) · **Status**: `Draft` · **Updated**: 2026-05-21

Tasks are numbered T1…Tn. Each commit on the PR references its T-IDs in the body.

---

## Phase 1 — Contract additions (1 commit)

- [ ] **T1.** Add optional `workId?: string` to `StoragePutInput` in [`packages/plugin/src/contracts/capabilities/storage.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/storage.interface.ts). JSDoc the meaning and "ignored by backends that don't need it" semantics.
- [ ] **T2.** Rebuild `@ever-works/plugin` declarations and confirm no consumer breaks (`pnpm build --filter @ever-works/plugin && pnpm type-check`).

## Phase 2 — Plugin core: helpers and transports (1 commit)

- [ ] **T3.** New `packages/plugins/github-storage/src/lfs-pointer.ts`: `formatPointer(oid, size)` returns the 3-line pointer payload; `parsePointer(content)` returns `{oid, size}` (used by `getObject` to detect pointer files). Vitest unit covers happy path + malformed input.
- [ ] **T4.** New `lfs-batch.ts`: `lfsBatch({owner, repo, token, oid, size, operation})` POSTs to `https://github.com/<owner>/<repo>.git/info/lfs/objects/batch` and returns `{href, header, alreadyExists}`. `lfsUpload({href, headers, body})` PUTs the bytes. Uses Node `fetch` (Node 22 globalThis). Vitest covers: happy path, already-exists response (`actions: {}`), error responses.
- [ ] **T5.** New `transport/contents-api.ts`: `class ContentsApiTransport implements Transport` with `commitFile({owner, repo, branch, path, content, message, sha?})`. Pulls the existing Octokit logic out of `github-storage.plugin.ts` verbatim. Vitest exercises 404→create vs sha→update.
- [ ] **T6.** New `transport/clone-and-push.ts`: `class CloneAndPushTransport implements Transport`. Uses `@ever-works/plugin/git` `GitOperations` to clone shallowly into a tmpdir, write the file, commit, push, clean up. Vitest mocks `GitOperations`.
- [ ] **T7.** New `transport/git-cli.ts`: `class GitCliTransport implements Transport`. Uses `execa` to run `git clone --depth 1`, `git lfs install --local`, `git lfs track`, `git commit`, `git push`. Vitest mocks `execa` and asserts argv shape.
- [ ] **T8.** New `work-repo-resolver.ts`: `interface WorkRepoResolver { resolve(workId: string): Promise<{owner: string; repo: string; branch: string; token: string}> }`. Plugin reads it from `(context as any).workRepoResolver`.

## Phase 3 — Plugin core: orchestrator (1 commit)

- [ ] **T9.** Rewrite `github-storage.plugin.ts`:
  - Read full settings (mode, transport, lfs*, owner/repo/branch/pathPrefix, token) from env + settings store.
  - In `putObject({buffer, filename, ownerId, workId})`:
    1. Resolve destination via `mode`. If `data-repo`, require `workId`; otherwise resolve from settings.
    2. Compute `oid`, `size`, `ext`, `path = <pathPrefix>/<ownerId>/<oid><ext>`.
    3. Pick `transport`: explicit value, or `auto` → `clone-and-push` for `data-repo`, `contents-api` for `separate-repo`.
    4. If `lfsEnabled`:
       - `await lfsBatch(...)` for upload action.
       - If `actions.upload.href` present, `await lfsUpload(...)`.
       - Ensure `.gitattributes` line exists for `pathPrefix` (read-then-write via the chosen transport, idempotent).
       - Write pointer via transport.
    5. Else: write raw bytes via transport (same shape as today).
- [ ] **T10.** `getObject`: if file content matches the pointer regex, fetch via LFS (use the batch API with `operation: download`); otherwise base64-decode the file content as today.
- [ ] **T11.** `deleteObject`: unchanged for direct blobs. For LFS pointer files, delete the pointer commit and best-effort delete the LFS object (best-effort because the LFS purge endpoint is not always available; log a warning).
- [ ] **T12.** Update `package.json` `everworks.plugin` block: bump version to `1.1.0`, add new env vars, add `"lfs"` to `capabilities`.
- [ ] **T13.** Update `README.md` for the plugin: new modes, LFS, transport choices, migration note from §8 of the spec.

## Phase 4 — API uploads integration (1 commit)

- [ ] **T14.** `apps/api/src/uploads/work-repo-resolver.service.ts`: NestJS service implementing `WorkRepoResolver`. Resolves owner/repo/branch from `Work.owner`, the Work's storage metadata, and the user's GitHub OAuth token from the `IntegrationAccount` table. Includes a small TTL cache to avoid hammering the DB on every upload.
- [ ] **T15.** `storage-backend.factory.ts`: when `wanted === 'github-storage'`, attach the resolver to the stub `PluginContext` before `onLoad()`.
- [ ] **T16.** `uploads.controller.ts`: accept optional `?workId=` (validated UUID) on the dashboard upload route. Anonymous route stays unchanged.
- [ ] **T17.** `uploads.service.ts`: thread `workId` into `StoragePutInput`.
- [ ] **T18.** Jest spec for `storage-backend.factory.spec.ts`: ensures the resolver gets attached only for `github-storage`. Other backends keep working with no extra context fields.
- [ ] **T19.** Jest spec for `uploads.service.workid.spec.ts`: posting an upload with `workId` reaches the mocked backend with `workId` set; without `workId`, backend receives `undefined`.

## Phase 5 — Web UI (1 commit)

- [ ] **T20.** Extract `OwnerFilter` (and the per-org repo fetch) from `RepositorySelector.tsx` into a small reusable hook: `useGitHubOwners(providerId)` returning `{ owners, loading, refresh }`. The existing component keeps working; the hook is shared.
- [ ] **T21.** Add `GithubOwnerWidget.tsx`: uses `useGitHubOwners`, renders the same Select as `OwnerFilter`, persists the owner login as the field value.
- [ ] **T22.** Add `GithubRepoWidget.tsx`: lists repos for the chosen owner, persists the full `owner/repo` string. Default selection: if the user already has a Work, suggest its data repo.
- [ ] **T23.** `PluginSettingsField.tsx`: route `x-widget === 'github-owner' | 'github-repo'` to the new widgets.
- [ ] **T24.** i18n strings for the new UI copy (mode labels, LFS toggle, transport options) under `apps/web/messages/en.json` and the existing locale set.

## Phase 6 — End-to-end tests (1 commit)

- [ ] **T25.** Playwright spec `apps/web/e2e/github-storage-settings.spec.ts`:
  - Open `/dashboard/plugins/github-storage`.
  - Toggle mode `separate-repo` → `data-repo` and assert owner/repo/branch/pathPrefix fields disappear.
  - Toggle LFS on/off and assert the `lfsTransport` field shows/hides.
  - Save, reload, assert persistence.
- [ ] **T26.** Playwright spec `apps/web/e2e/github-storage-upload.spec.ts`:
  - Mock the Octokit + LFS Batch API endpoints with `page.route(...)`.
  - Post a small upload via the dashboard upload form.
  - Assert: (a) LFS batch POST happened, (b) blob PUT to signed URL happened, (c) pointer commit PUT happened, (d) the file appears in the uploads list under the expected key.

## Phase 7 — PR + bot loop (NN #14 / #18 / #19)

- [ ] **T27.** Push branch `session/github-storage-lfs-ew644`, open PR. Title: `feat(github-storage): LFS + dual repo modes (EW-644)`. Body links spec/plan/tasks + JIRA.
- [ ] **T28.** Poll `gh pr checks` until CI green. Triage failures, fix, push, re-poll.
- [ ] **T29.** Poll `gh pr view --comments` for CodeRabbit / Greptile / Codex / Copilot review. Apply P0/P1/P2 fixes or annotate with rationale. Re-poll until the second pass is clean.
- [ ] **T30.** Report PR URL back to the operator with a one-line summary. Do not merge — the operator drives merge per NN #18.
