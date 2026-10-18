# FL-11 — Files & clipboard · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a `**Test**` line; every task ships with its tests (Constitution VI) and is small enough for
> one PR. Tasks marked `(parallel)` may run alongside the task above them.

**Epic ID:** `FL-11-files`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run with `pnpm` from the root unless stated.
- Runners: `packages/contracts`, `apps/node`, `apps/web` unit → Vitest; `packages/agent`, `apps/api`
  → Jest; `apps/web/e2e` → Playwright.
- **No migration**: CONTRACTS §13 reserves no FL-11 slot; a PR that adds a schema change here is
  wrong by construction.
- FL-02 owns the link core (`apps/node/src/core/link/` mux and `link/modules/index.ts`), the relay
  bus, operations and the viewer gateway; this epic adds `link/modules/files.ts`,
  `link/modules/clip.ts` and helpers under `link/modules/files/` (CONTRACTS R-40) and imports the
  shared resolver `apps/node/src/core/link/allowed-roots.ts` (R-39). FL-01 owns
  `apps/web/src/components/fleet/registry.ts` and role derivation (`FleetAccessService`); FL-07 owns
  `apps/node/src/core/screen/desktop-host.ts` and the Desktop tab. Tasks that touch them say so.
- Never name a third-party product anywhere (program rule 16); run the banned-terms grep before
  every PR.
- Commit style: `feat(fleet-files): …`, `feat(node-files): …`, `test(fleet-files): …`.

---

## P1.A — Contracts

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-files.types.ts` (`FLEET_FILES_CAPABILITY`,
      `FleetFileRootView`, `FleetFileEntryView`, `FleetFileListView`, `FleetFileConflictView`,
      `FLEET_FILE_CONFLICT_POLICIES`, `FleetFilesOperationView`, `FLEET_FILES_LIMITS`,
      `FLEET_CREDENTIAL_FILE_PATTERNS`, `isCredentialShapedName`) and
      `fleet-clip.types.ts` (`FLEET_CLIP_MAX_BYTES`, request/result); export from
      `packages/contracts/src/fleet/index.ts`; add `node.files.list|read|write|copy|delete` and
      `node.clip.paste` to `packages/contracts/src/fleet/fleet-panic.types.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-files.types.spec.ts` (guards; limits
      equal CONTRACTS §10; credential-name truth table with negatives `env.ts`, `keyboard.ts`,
      `README.md`), `fleet-clip.types.spec.ts`; extend `fleet-panic.spec.ts` and `index.spec.ts`.

## P1.B — Node files module

- [ ] **T-02**. `apps/node/src/core/link/modules/files/path-guard.ts`: `resolveInsideRoot(root,
      rel, io)` over the shared resolver's `isUnderAllowedRoot` (T-03), `lstat` walk per component,
      link-target check, UNC refusal; typed refusals `escape | link-escape | not-found`. Never a
      second canonicalisation rule.
      **Test**: `apps/node/src/core/link/modules/files/path-guard.spec.ts` — `..`, absolute, `C:\`,
      `\\server\share`, link out of root, link inside root, case-insensitive match on `win32` via
      injected platform.
- [ ] **T-03** (parallel). Import the shared resolver `apps/node/src/core/link/allowed-roots.ts`
      (CONTRACTS R-39; create it with FL-08's API `resolveAllowedRoots({ checkouts, workspaceRoot,
      extraRoots })` / `isUnderAllowedRoot(path)` only if neither FL-08 nor FL-14 has landed it):
      roots from the checkout registry (FL-14; fallback: worktree pool entries under the workspace
      root from `apps/node/src/core/workspaces/fleet-task-workspace.ts`), the workspace root, and
      `--files-root` entries; home never implied; missing roots refused with a log line. Add
      `start --files-root <dir>` (repeatable) to `apps/node/src/cli/program.ts` reusing the
      `--workspace-root` absolute-path parser, unless already present; `doctor` prints roots.
      **Test**: `apps/node/src/core/link/allowed-roots.spec.ts` (extend, do not duplicate);
      `apps/node/src/cli/program.files-root.spec.ts` (relative path is a usage error, exit 2).
- [ ] **T-04**. `apps/node/src/core/link/modules/files/list.ts` (`files.list`/`files.stat`:
      `readdir` `withFileTypes`, `lstat` per entry, 5 000 cap + `truncated`, hidden filter per OS,
      flags `credentialShaped`, `linkInsideRoot`) and `credential-shaped.ts` (re-export from
      contracts).
      **Test**: `list.spec.ts` — cap, hidden per platform, flags, a 5 001-entry fixture truncates.
- [ ] **T-05**. `apps/node/src/core/link/modules/files/pack.ts`: tar (`tar-stream`) of the selection, in-set
      links as links, out-of-set links skipped and counted, `DATA` ≤ 64 KiB, sender window 8 MiB
      from `ACK`, `END` + `operation.done`; refuses > 5 000 entries or > 2 GiB **before** the first
      byte.
      **Test**: `pack.spec.ts` — tar listing equals the selection; link rules; a slow ACK pauses the
      sender at exactly one window; limits refuse before any `DATA`.
- [ ] **T-06**. `apps/node/src/core/link/modules/files/unpack.ts`: extract into `<dest>/.ever-works-partial-<opId>/`,
      per-entry policy (`skip` default, `replace`), rename on `END`, remove the partial dir on
      `CLOSE`/cancel/failure, `ACK` as consumed; `delete.ts`: canonical check per entry, `fs.rm`
      recursive, never follows links out of root.
      **Test**: `unpack.spec.ts` — no partial file after cancel/interrupt/failure; `skip` leaves the
      original byte-identical; `delete.spec.ts` — link target outside root untouched.
- [ ] **T-07**. `apps/node/src/core/link/modules/files.ts` — the `files` `NodeModule` (D8, CONTRACTS
      R-40) wiring T-02…T-06, with one entry in `apps/node/src/core/link/modules/index.ts`; `files`
      tag from its `tags(env)` (iff `--manage` and roots non-empty); the channel handler implementing
      plan §6.3 (every request answered with its `requestId`; limits before the first byte; `CLOSE`
      removes partial dirs; `link.pause` closes in-flight operations).
      **Test**: `apps/node/src/core/link/modules/files.spec.ts` (message table; refusal codes;
      `link.pause`); extend `capabilities.spec.ts` (`files` iff roots).

## P1.C — Platform: service, transfer bridge, API

- [ ] **T-08**. `packages/agent/src/fleet/files/fleet-files.service.ts`: audience check
      (`FleetAccessService.assertFamily(node, userId, 'files')`, FL-01), consent check from
      `FleetNode.consents`, kill switch, credential gate (people: `confirmation_required` class
      `confirm` until `confirm: true`; Agents: `permission_denied`), delete gate
      (`confirm-destructive`: `confirmName` compared with the target, CONTRACTS §2.2), same-folder
      refusal, audit rows
      (`node.files.list` once per root per visit, `read`, `write`, `delete`) with `root`, `path`,
      `entries`, `bytes`, `requestedBy`, `confirmed`.
      **Test**: `packages/agent/src/fleet/files/__tests__/fleet-files.service.spec.ts` — every
      code with hint; audience matrix; Agent download of `.env` refused; list audited once.
- [ ] **T-09**. `apps/api/src/fleet/files/fleet-files-transfer.service.ts`: opens `files.pack` /
      `files.unpack` channels through the FL-02 relay bus; download → raw body for one file, zip
      (`archiver`, `store`) for several/folders, `Content-Disposition: attachment`,
      `X-Content-Type-Options: nosniff`, `X-Fleet-Operation-Id`; ACKs as the HTTP response drains
      (never more than 8 MiB held); upload → multipart (`webkitRelativePath`) tarred into
      `files.unpack`; cancel/kill switch → `CLOSE` within 5 s.
      **Test**: `fleet-files-transfer.service.spec.ts` — raw vs zip; platform buffer ≤ 8 MiB with a
      stalled client; cancel closes the channel; kill switch cancels; zip entries equal the tar.
- [ ] **T-10**. `apps/api/src/fleet/files/fleet-files.controller.ts` (`/api/fleet/nodes/:id/files/*`:
      roots, list, stat, download, conflicts, upload, copy stub returning `unsupported_on_node` until
      P2, delete) with `dto/fleet-files.dto.ts`; module imported in `apps/api/src/api.module.ts`;
      `FleetEnabledGuard` + `FLEET_MACHINE_FACTS_ENABLED`; throttles per plan §5.
      **Test**: `fleet-files.controller.spec.ts` — codes + hints; cross-user node 404s like unknown;
      `confirmation_required` without `confirm` / `confirmName`; throttles present.

## P1.D — Web

- [ ] **T-11**. Register the tab in `apps/web/src/components/fleet/registry.ts` _(FL-01)_; create
      `apps/web/src/components/fleet/files/FilesTab.tsx`, `FilesRootPicker.tsx`, `FilesBreadcrumb.tsx`,
      `FilesGrid.tsx` (`role="grid"`, `Space`/`Enter`/`Backspace`, multi-select), `FilesActionBar.tsx`,
      `FilesUnavailableCard.tsx` (spec §5.7 variants), `files.shared.ts` (pure: sort, size format,
      conflict merge, limits, `ew:fleet:files:hidden`), `use-files-api.ts`.
      **Test**: `files.shared.unit.spec.ts`, `FilesGrid.unit.spec.tsx` (keyboard model, selection
      cap), `FilesUnavailableCard.unit.spec.tsx` (one card per reason; commands present).
- [ ] **T-12**. Dialogs: `FilesConflictDialog.tsx` (per-entry Replace/Skip, Skip default, Replace
      all), `FilesDeleteDialog.tsx` (exact-name match enables; parent-folder name for several),
      `FilesCredentialConfirm.tsx`; `FilesOperationsStrip.tsx` reading FL-02 operations (percent,
      speed, Cancel, end notices with bytes).
      **Test**: `FilesConflictDialog.unit.spec.tsx`, `FilesDeleteDialog.unit.spec.tsx`,
      `FilesOperationsStrip.unit.spec.tsx` (three end notices verbatim).
- [ ] **T-13**. BFF streaming proxies `apps/web/src/app/api/fleet/nodes/[id]/files/{roots,list,stat,download,conflicts,upload,delete}/route.ts`
      (download pipes the body; upload forwards multipart; ids checked; codes pass through).
      **Test**: route unit specs — no buffering of the body; codes preserved.
- [ ] **T-14**. i18n: `fleet.computer.tabs.files` and the `fleet.files.*` groups from plan §8 in
      `apps/web/messages/en.json`; footer strings (roots line, _"Transfers spend no credits…"_).
      **Test**: no literal user-visible string in `apps/web/src/components/fleet/files/`; no leaf
      key with a literal `.`; hydration spec green.

## P1.E — Tools, e2e, close P1

- [ ] **T-15**. Read-only tools `fleet_files_list`, `fleet_files_stat` in
      `packages/agent/src/fleet/agent-fleet-files-tools.ts`; MCP whitelist entries in
      `apps/mcp/src/openapi-tools/whitelist.ts` with `readOnly: true`; results enter the Run receipt
      with size and tokens.
      **Test**: `__tests__/agent-fleet-files-tools.spec.ts` — annotations; credential flags present;
      refusal hints equal the UI sentences.
- [ ] **T-16**. E2E with a fake files host `apps/web/e2e/fixtures/fake-files-host.ts` (speaks the
      `files` channel over the FL-02 test link): `apps/web/e2e/flow-fleet-files-browse.spec.ts`
      (roots, grid, hidden toggle, flags, each unavailable variant),
      `flow-fleet-files-transfer.spec.ts` (raw download checksum, zip download, upload with
      conflicts, cancel leaves nothing, credential confirm, delete by name),
      `flow-fleet-files-contract.spec.ts`.
      **Test**: the specs; `flow-fleet-*.spec.ts` existing specs unchanged.

## P2.A — Copy between machines

- [ ] **T-17**. Copy bridge in `fleet-files-transfer.service.ts`: `files.pack` on the source and
      `files.unpack` on the destination, `DATA` piped inside the platform, destination `ACK`s
      forwarded to the source, one `operation.progress` stream, `CLOSE` on either side closes the
      other; audience + consent checked on **both** Nodes; audit `node.files.copy` on both with
      `peerNodeId`.
      **Test**: extend `fleet-files-transfer.service.spec.ts` — credits forwarded (source never more
      than one window ahead); failure on B removes B's partial dir and closes A; two audit rows.
- [ ] **T-18**. `POST /copy` in `fleet-files.controller.ts` (replaces the P1 stub), conflicts via
      the destination, same-folder refusal; `FilesCopyDialog.tsx` (destination computer/root/folder,
      greyed reasons for offline/unmanaged, _"build-01 and build-02 never talk to each other"_);
      BFF route `copy/route.ts`.
      **Test**: `FilesCopyDialog.unit.spec.tsx`; `apps/web/e2e/flow-fleet-files-copy.spec.ts`
      including a network assertion that no request leaves the platform toward a node.

## P2.B — Paste into a desktop

- [ ] **T-19**. Node: `apps/node/src/core/link/modules/clip.ts` — the `clip` `NodeModule` (one entry
      in `link/modules/index.ts`, CONTRACTS R-40); opens with `{ viewId }` (R-27), `--attend` and
      FL-07 source required, one `CLIP` ≤ 256 KiB, calls `apps/node/src/core/screen/desktop-host.ts`
      `pasteText` _(FL-07)_, replies `clip.pasted`.
      **Test**: `apps/node/src/core/link/modules/clip.spec.ts` — over-cap refused before paste;
      consent refusal; never reads the clipboard (the host mock has no read method).
- [ ] **T-20**. Platform: `packages/agent/src/fleet/files/fleet-clip.service.ts` (holder check via
      `packages/agent/src/computer/control-arbiter.service.ts`; per-view `pasteAllowed` relay state,
      reset on view end; cap; audit `node.clip.paste` bytes only) and
      `apps/api/src/fleet/desktop/fleet-clip.controller.ts` (`POST …/views/:viewId/clip`, `PATCH`
      `pasteAllowed` on the FL-07 view route).
      **Test**: `fleet-clip.service.spec.ts` — not holder / opt-in off → `permission_denied` with
      the two distinct hints; reset on end; `fleet-clip.controller.spec.ts`.
- [ ] **T-21**. Web: `apps/web/src/components/fleet/desktop/DesktopPasteDialog.tsx` _(FL-07 dir)_
      (clipboard read on gesture, size meter against 256 KB, non-blocking secret warning using
      `redactSecrets`'s matcher, _"Nothing is read back"_ line), **Allow paste into this desktop**
      in the Desktop tab's `⋯` menu, `Ctrl/⌘+Shift+V` while controlling; BFF `clip/route.ts`;
      i18n `fleet.desktop.paste.*`.
      **Test**: `DesktopPasteDialog.unit.spec.tsx` (cap; warning; disabled reasons verbatim);
      `apps/web/e2e/flow-fleet-desktop-paste.spec.ts`.
- [ ] **T-22**. Tools: `fleet_files_copy` (`destructive`, `confirm`, conflicts in result, `replace`
      flag), `fleet_files_delete` (`destructive`, `confirm-destructive` → held as an
      `agent_action_proposals` row carrying the entries, CONTRACTS R-33; executes on the owner's
      approval), `fleet_desktop_paste` (`destructive`, denied unless granted, FL-07 grant required);
      MCP entries with the same names; CLI `apps/cli/src/commands/fleet/files.ts` and `fleet desktop
      paste` _(with FL-19)_.
      **Test**: extend `agent-fleet-files-tools.spec.ts` — delete creates a held proposal and writes
      nothing; paste default denied; copy without `replace` skips conflicts.
- [ ] **T-23**. Accessibility: `apps/web/e2e/flow-fleet-files-a11y.spec.ts` — keyboard-only grid
      and dialogs, live-region announcements for operation states, axe pass on the tab and the
      paste dialog.
      **Test**: the spec; fix findings.

## Docs & rollout

- [ ] **T-24**. User doc `docs/features/fleet-files.md` (allowed roots and the flag, what is never
      visible, transfers and their limits, conflicts, credential-shaped names, delete, copy between
      computers, paste and its guards, what it costs); add to `apps/docs/sidebarsPlatform.ts`;
      cross-link from `docs/features/fleet.md`.
      **Test**: `pnpm --filter ever-works-docs build` — no broken links.
- [ ] **T-25**. Update `docs/specs/features/fleet/TRACKER.md` (FL-11 per phase) and the spec/plan
      status fields; amend CONTRACTS in the same PR with the change spec §8b still lists (files and
      paste rates, transfer concurrency, operation states), owner-approved before merge
      (`node.clip.paste`, operation cancel and `{ viewId }` are already in CONTRACTS rev 2).
      **Test**: banned-terms grep over `docs/specs/features/fleet/FL-11-files/` and
      `docs/features/fleet-files.md` prints nothing.
- [ ] **T-26**. Flip `FLEET_MACHINE_FACTS_ENABLED` per D12 together with FL-08/09/10 P1 once their
      acceptance tests are green; run `pnpm format && pnpm lint && pnpm test && pnpm build`.
      **Test**: CI green on the flag-on configuration.

## Definition of done

- Every checkbox ticked; every FR in `spec.md` §4 has a named passing test (ACC-FL11-17).
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green locally and in CI.
- No schema change in the diff (`git diff --stat -- apps/api/src/migrations` is empty for this epic).
- A 1 GiB synthetic download arrives byte-identical; a cancelled upload and copy leave no partial
  file on any node; a copy produces no node-to-node network request.
- No file content or pasted text appears in any log, audit row or error message.
- The existing `flow-fleet-*.spec.ts` and `flow-agent-computer-*.spec.ts` pass unchanged.
- The banned-terms grep over every file this epic touched prints nothing.
- Constitution gates in `spec.md` §10 confirmed.
