# FL-14 — Checkouts on computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-14-checkouts`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run with `pnpm` from the root.
- Runners: `packages/agent` and `apps/api` → **Jest**; `apps/node`, `packages/contracts`, `apps/web`
  unit → **Vitest**; `apps/web` e2e → **Playwright**.
- Migrations are **authored** from `apps/api/`; the API self-applies on boot. Re-stamp the slot
  if `develop` moved.
- Each task is one PR. Add new tasks at the bottom; never renumber.
- Commit style: `feat(fleet-checkouts): …`, `feat(node): …`, `test(fleet): …`, `chore(i18n): …`.
- Blocked by FL-02 (machine channel host, module registry `apps/node/src/core/link/modules/index.ts`,
  `--manage`, operations endpoint) and FL-01 (tab registry, role derivation, the hub route and
  `ROUTES` constant). Confirmations use CONTRACTS §2.2's request fields — there is no token helper.
  Node code lives under `apps/node/src/core/link/modules/` (R-40) and file roots go through the
  shared resolver `apps/node/src/core/link/allowed-roots.ts` (R-39). FL-06 extends this epic's
  module and delete (`remoteHeads`, `checkouts.changes`, `cleanUp=1`). Tasks that need them say so.

---

## P1.A — Contracts and schema

- [ ] **T-01**. Add checkout contracts at `packages/contracts/src/fleet/fleet-checkout.types.ts`:
      kind/state/isolation/createdBy unions with `readonly` arrays and `isX` guards, `FleetGitLine`
      (CONTRACTS §4.7), `FleetCheckoutView`, `FleetCheckoutCreateRequest`, `FleetCheckoutSyncOp`,
      the `checkouts.*` link request/reply shapes, and the constants (cap 300, refresh 60 s, manual
      refresh 10 s, reconcile 10 min). Export from `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-checkout.types.spec.ts` — guards,
      token-free URL rule reused from `fleet-task-workspace.types.ts`, constants.
- [ ] **T-02** _(parallel)_. Add `node.checkout.create|delete|sync|archive` (CONTRACTS §7) to
      `FleetAuditAction` and `FLEET_AUDIT_ACTIONS` in `packages/contracts/src/fleet/fleet-panic.types.ts`.
      The heartbeat gains no field (code folders travel in the `checkouts.list` reply).
      **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts`; conformance
      fixture `packages/contracts/fixtures/fleet-node-contract.v1.json` unchanged.
- [ ] **T-03**. Add the entity `packages/agent/src/entities/fleet-checkout.entity.ts` (plan §4.1 — CONTRACTS §4.3 columns only, `simple-json` text, `varchar` enums),
      register it in `packages/agent/src/entities/index.ts` and `packages/agent/src/database/_entities-inventory.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/fleet-checkout.repository.integration.spec.ts` —
      unique `(nodeId, path)`, state filter, archived excluded by default.
- [ ] **T-04**. Author migration `apps/api/src/migrations/1796140000000-CreateFleetCheckouts.ts` from
      `apps/api/` (`pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateFleetCheckouts`).
      Hand-check: one `CREATE TABLE`, four indexes, three FKs (`nodeId` ON DELETE CASCADE,
      `parentCheckoutId` and `workId` ON DELETE SET NULL), no drops; `down` reverses exactly.
      **Test**: applies on fresh and populated databases; re-generation yields an empty diff;
      deleting a Node or a Work that has checkouts still succeeds.

## P1.B — Node: registry, discovery, git line, Task import

- [ ] **T-05**. Add `--code-folder <dir>` (repeatable, absolute, never `~` alone or a filesystem root)
      to `start` in `apps/node/src/cli/program.ts`, persisted beside `--workspace-root` (`:439`).
      **Test**: extend `apps/node/src/cli/program.spec.ts` — parse, persist, refuse home/root.
- [ ] **T-06**. Create `apps/node/src/core/link/modules/checkouts/checkout-registry.ts` (`checkouts.json`
      in the config dir; `readyPaths()` feeds `resolveAllowedRoots({ checkouts, … })` of the shared
      resolver `apps/node/src/core/link/allowed-roots.ts` — import it, or create it with FL-08's API
      only if neither FL-08 nor FL-11 landed it, CONTRACTS R-39).
      **Test**: `apps/node/src/core/link/modules/checkouts/checkout-registry.spec.ts` — load/save,
      ready paths exclude archived/missing, corrupted file → empty registry with a warning; extend
      `apps/node/src/core/link/allowed-roots.spec.ts` with checkout roots.
- [ ] **T-07**. Create `apps/node/src/core/link/modules/checkouts/checkout-discovery.ts` (depth 3, prune at `.git`,
      skip list, 300 cap, `truncated`, `git remote get-url origin` with userinfo stripped and flagged).
      **Test**: `checkout-discovery.spec.ts` — fixture tree with nested repos, `node_modules`, a
      symlink escaping the folder (not followed), a tokenised remote, 301 clones → 300 + truncated.
- [ ] **T-08** _(parallel)_. Create `apps/node/src/core/link/modules/checkouts/checkout-git-line.ts` (porcelain v2,
      numstat, left-right count, worktree flag, base ref; **no network**).
      **Test**: `checkout-git-line.spec.ts` — real temp repos: clean, dirty, ahead, behind, detached,
      worktree; asserts no `fetch` argv ever appears.
- [ ] **T-09**. Extract rules 5–6 of `apps/node/src/core/workspaces/workspace-reaper.ts` into
      `apps/node/src/core/link/modules/checkouts/checkout-evidence.ts` and make the reaper call it (behaviour
      unchanged).
      **Test**: `checkout-evidence.spec.ts` + the existing `workspace-reaper.spec.ts` still green.
- [ ] **T-10**. Create `apps/node/src/core/link/modules/checkouts/checkout-task-import.ts` mapping
      `workspace-inventory.ts` records to `worktree`/`task` rows.
      **Test**: `checkout-task-import.spec.ts` — pool fixture → rows with branch, remote, size.
- [ ] **T-11**. Create `apps/node/src/core/link/modules/checkouts.ts` — the `NodeModule` (CONTRACTS
      R-40, one entry in `apps/node/src/core/link/modules/index.ts`) registering `checkouts.list` on
      FL-02's `machine` verb router (rescan, refresh, code folders in the reply, consent matrix,
      `kill_switch` refusal, `link.pause` aborts operations).
      **Test**: `apps/node/src/core/link/modules/checkouts.spec.ts` — `--manage` required for a
      person's rescan, Task rows visible with `--work` only, `kill_switch` refusal, 10-minute
      reconcile marks `missing`, a request without `remoteHeads` never calls the remote.

## P1.C — Platform: service, API, jobs

- [ ] **T-12**. Create `packages/agent/src/fleet/fleet-checkout.repository.ts` and
      `packages/agent/src/fleet/fleet-checkout.service.ts` (upsert from node lists, state machine,
      archive/restore, refresh throttle 1/10 s, R-19 org scope, audience check via FL-01 roles, audit).
      **Test**: `packages/agent/src/fleet/__tests__/fleet-checkout.service.spec.ts` — every state
      transition, throttle, audience refusal, audit row per action with no credential field.
- [ ] **T-13** _(parallel)_. Create pure `packages/agent/src/fleet/checkout-remote-match.ts`
      (`parseRemote`, host-aware `owner/repo`, match to Work `sourceRepository` and installation
      repositories).
      **Test**: `checkout-remote-match.spec.ts` — https/ssh/scp forms, trailing `.git`, other hosts
      never match, tokenised URL rejected.
- [ ] **T-14**. Create `apps/api/src/fleet/fleet-checkouts.controller.ts` (`GET /checkouts`,
      `GET /nodes/:id/checkouts`, `GET /checkouts/:id`, `POST /checkouts/:id/refresh`,
      `POST /checkouts/:id/archive|restore`) with DTOs in `apps/api/src/fleet/dto/fleet-checkout.dto.ts`,
      guarded by `FleetEnabledGuard` + a `FLEET_CHECKOUTS_ENABLED` guard; mount in `apps/api/src/fleet/fleet.module.ts`.
      **Test**: `apps/api/src/fleet/fleet-checkouts.controller.spec.ts` — codes/hints for every
      refusal, cross-user 404, flag off → 404.
- [ ] **T-15**. Create `packages/tasks/src/tasks/trigger/fleet-checkout-reconcile.task.ts` (cron
      `7/10 * * * *`) with a `FLEET_CHECKOUT_RECONCILE_DISPATCHER` symbol bound in `fleet.module.ts`.
      **Test**: `packages/tasks/src/__tests__/fleet-checkout-reconcile.task.spec.ts` — stale
      `creating` → `missing`, idempotent on overlap.

## P1.D — Web

- [ ] **T-16**. Register the hub tab (`registerHubTab`) and the computer tab (`registerComputerTab`,
      `consent: 'manage'`) for `checkouts` in `apps/web/src/components/fleet/registry.ts` (FL-01).
      The `/fleet/checkouts` route file and `DASHBOARD_FLEET_CHECKOUTS` are FL-01's (CONTRACTS §11.1);
      do not create them.
      **Test**: `apps/web/src/components/fleet/registry.unit.spec.ts` extended — tab present with
      flag + `manage`, state card otherwise.
- [ ] **T-17**. Create `apps/web/src/components/fleet/checkouts/checkouts.shared.ts` (grouping,
      ordering, action availability matrix, size and reaper-note formatting).
      **Test**: `checkouts.shared.unit.spec.ts` — matrix over state × consent × audience × busy × online.
- [ ] **T-18**. Create `CheckoutsHubTab.tsx`, `ComputerCheckoutsTab.tsx`, `CheckoutRow.tsx`,
      `GitLine.tsx`, `CodeFoldersCard.tsx`, `CheckoutsBin.tsx`, `CheckoutStateCard.tsx` under
      `apps/web/src/components/fleet/checkouts/`; BFF routes under `apps/web/src/app/api/fleet/checkouts/**`
      and `apps/web/src/app/api/fleet/nodes/[id]/checkouts/route.ts`.
      **Test**: `GitLine.unit.spec.tsx`, `CheckoutRow.unit.spec.tsx` (offline dimming, consent banner).
- [ ] **T-19**. Add i18n groups `fleet.checkouts.*` and the shared `fleet.errors.*` hints to
      `apps/web/messages/en.json`; palette entry in `apps/web/src/components/command-palette/registry/screens.ts`.
      **Test**: `grep -c '"[a-zA-Z]*\.[a-zA-Z]*":' apps/web/messages/en.json` unchanged; no literal
      user-visible string in `components/fleet/checkouts/`.
- [ ] **T-20**. Write `apps/web/e2e/flow-fleet-checkouts.spec.ts` (P1 flows: hub, computer tab, scan,
      fetch, archive/restore, offline, consent-missing) and `apps/web/e2e/flow-fleet-checkouts-contract.spec.ts`.
      **Test**: both green locally and in CI on a cold database.

## P2 — Create, sync, delete, roots, tools

- [ ] **T-21**. Add `packages/contracts/src/fleet/fleet-git-credential.types.ts`; create
      `apps/api/src/fleet/fleet-git-credential.service.ts` generalising `fleet-push-credential.service.ts`
      (operation-keyed, `read`/`write` access, host check) and the node-authenticated
      `POST /api/internal/fleet/checkouts/credential` on `apps/api/src/fleet/fleet-jobs.controller.ts`'s
      sibling `fleet-checkouts-internal.controller.ts`.
      **Test**: `apps/api/src/fleet/__tests__/fleet-git-credential.service.spec.ts` — scope,
      narrowing, revoke on done, host mismatch refused, undifferentiated 401.
- [ ] **T-22**. Create `apps/node/src/core/link/modules/checkouts/checkout-credential.ts` (header in child env for
      one command only) and `checkout-operations.ts` (`clone`, `worktreeAdd`, `fetch`, `pull`, `push`,
      `remove`, `forget`; cancellable; progress; partial cleanup; `core.longpaths` on win32).
      **Test**: `checkout-credential.spec.ts` (never argv/config), `checkout-operations.spec.ts`
      (argv per op, dirty-tree pull refused, cancellation removes partial clone).
- [ ] **T-23**. Extend `apps/node/src/core/link/modules/checkouts.ts` with `checkouts.create`,
      `checkouts.sync`, `checkouts.delete` (evidence re-computed; `busy` on live session cwd / lease /
      reaper intent). FL-06 (its T-04/T-23) later adds `remoteHeads` → `remoteBranches` and the
      `cleanUp=1` gate to this module and to T-24's delete — leave both seams open.
      **Test**: extend `checkouts.spec.ts` — consent per origin, `expected` counts exceeded →
      refused, discovered checkouts never request a platform credential.
- [ ] **T-24**. Extend `fleet-checkout.service.ts` and `fleet-checkouts.controller.ts` with
      `POST /checkouts`, `POST /checkouts/:id/sync`, `DELETE /checkouts/:id` (CONTRACTS §2.2: without
      a field it answers `409 confirmation_required` with `{ class, uncommitted, unpushedCommits }` —
      the delete preview — then accepts `confirm: true` or `confirmName`; branch-name uniqueness per
      remote incl. archived rows → `-2` suffix).
      **Test**: extend both specs — 202 + operationId, `confirmation_required` with counts, suffix
      rule, `confirm` vs `confirm-destructive` from counts, wrong `confirmName` refused.
- [ ] **T-25**. Create `NewCheckoutDialog.tsx` and `DeleteCheckoutDialog.tsx`; add Pull/Push to the
      row menu; cost footer.
      **Test**: `DeleteCheckoutDialog.unit.spec.tsx` (typed name only when dirty), `NewCheckoutDialog.unit.spec.tsx`.
- [ ] **T-26**. Wire the registry's `readyPaths()` into the shared resolver
      `apps/node/src/core/link/allowed-roots.ts` (R-39) so FL-08's logs and FL-11's files see `ready`
      checkouts + the workspace root; no second resolver.
      **Test**: extend `checkout-registry.spec.ts` and `apps/node/src/core/link/allowed-roots.spec.ts`
      — an archived or missing checkout is not a root.
- [ ] **T-27**. Add `fleet_checkouts_list|get|create|sync|archive|delete` to
      `packages/agent/src/fleet/agent-fleet-tools.ts` with CONTRACTS §11.3 annotations; add the routes
      to `apps/mcp/src/openapi-tools/whitelist.ts` with the same names; add
      `apps/cli/src/commands/fleet/checkout.ts` (FL-19 §9.3's file; `ever-works fleet checkouts list|get|create|sync|archive|delete [--json]`).
      **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-tools.spec.ts` extended (annotations,
      audience refusal → `permission_denied`), `apps/mcp` whitelist spec, `apps/cli/src/commands/fleet/__tests__/checkout.spec.ts`.
- [ ] **T-28**. Extend `apps/web/e2e/flow-fleet-checkouts.spec.ts` with create worktree, pull/push
      confirmations, delete dialog classes, bin "folder removed".
      **Test**: green in CI.

## P3 — Isolation, sharing, purge

- [ ] **T-29**. Create `apps/node/src/core/link/modules/checkouts/checkout-container.ts` (`docker run` wrapper;
      refuse on `os:win32` or no `docker`) and let FL-04's daemon spawn sessions through it when
      `isolation = 'container'`.
      **Test**: `checkout-container.spec.ts` — argv, mount, refusal matrix.
- [ ] **T-30**. Shared folders per repository Work: `sharedFolders: string[]` in the Work's
      fleet settings (additive JSON on the existing Work settings column), linked (junction on
      win32) into new worktrees by `checkout-operations.ts`.
      **Test**: extend `checkout-operations.spec.ts` — link created, never copied, gitignored check.
- [ ] **T-31**. Create `packages/tasks/src/tasks/trigger/fleet-checkout-bin-purge.task.ts` (daily,
      30 d, deleted rows only).
      **Test**: `packages/tasks/src/__tests__/fleet-checkout-bin-purge.task.spec.ts`.

## P4 — Docs and rollout

- [ ] **T-32**. Write `docs/features/fleet-checkouts.md` (discovery, code folders, create, sync,
      delete safety, bin, credentials model); add to `apps/docs/sidebarsPlatform.ts` next to
      `'features/fleet'` (`:183`); cross-link from `docs/features/fleet.md`.
      **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-33**. Update `docs/specs/features/fleet/TRACKER.md` (FL-14 spec/impl columns); no plugin
      doc change (no plugin); amend CONTRACTS in the same PR with whatever spec §8b still lists.
      Run the banned-terms grep over this folder, the code and the docs.
      **Test**: grep prints nothing.
- [ ] **T-34**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`; boot the API with the flag
      on and confirm `GET /api/fleet/checkouts` answers on a cold database.
      **Test**: all green; a smoke request returns `{ data: [] }`.

## Definition of done

- Every checkbox ticked; every test in §P1–P3 green locally and in CI.
- ACC-FL14-01 … ACC-FL14-29 verified on `develop` with `FLEET_CHECKOUTS_ENABLED=true`.
- No credential, token or tokenised remote appears in any row, log, audit entry or test fixture.
- `pnpm format:check`, `pnpm lint`, docs build clean; Constitution gates in spec §10 confirmed.
