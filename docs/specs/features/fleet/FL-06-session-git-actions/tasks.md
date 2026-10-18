# FL-06 — Session git & actions · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Feature ID:** `FL-06-session-git-actions`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run with `pnpm` from the root.
- Runners: `packages/agent`, `apps/api`, `packages/tasks` → **Jest**; `apps/node`, `packages/contracts`,
  `apps/web` unit → **Vitest**; `apps/web` e2e → **Playwright**.
- **No migration in this epic** (CONTRACTS §13 has no FL-06 slot). Any task that seems to need a
  column is wrong — stop and re-read plan §4.
- Blocked by FL-04 (session channel, daemon, start dialog, session detail page) and FL-14
  (Checkout rows, git line, `checkouts.*` handler). Tasks name what they extend.
- One task = one PR. Add new tasks at the bottom; never renumber.
- Commit style: `feat(fleet-sessions): …`, `feat(node): …`, `test(fleet): …`, `chore(i18n): …`.

---

## P1.A — Contracts and branch rule

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-session-actions.types.ts` (action ids,
      defaults, context, availability, ledger entry, send/changes/PR request shapes, rate and cap
      constants, `renderActionPrompt`); export from `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-session-actions.spec.ts` — placeholder
      matrix, unknown placeholders left verbatim, every default names the placeholders it needs.
- [ ] **T-02** _(parallel)_. Add the optional `fleet { branchPrefix?, actions? }` block to the
      `agent.yml` schema in `packages/agent/src/agents/types.ts` and its parse/serialise path in
      `packages/agent/src/agents/agent-file.service.ts` (unknown keys still rejected; block optional).
      **Test**: extend `packages/agent/src/agents/__tests__/agent-file.service.spec.ts` — parses, round-trips,
      an invalid action id is refused with the field named.
- [ ] **T-03**. Create pure `packages/agent/src/fleet/branch-proposal.ts` (`proposeBranch(ctx)`:
      Task branch reuse via `taskBranchName` from `packages/agent/src/tasks-domain/task-isolation.ts`,
      else `<prefix>/<slug>` from first message / title / generated name; suffixing against a
      supplied set of taken names).
      **Test**: `packages/agent/src/fleet/__tests__/branch-proposal.spec.ts` — Task reuse, slug
      rules (≤ 40 chars, kebab), prefix defaults, `-2`/`-3` suffixing, Unicode input.
- [ ] **T-04**. Add `GET /api/fleet/sessions/branch-proposal` to a new
      `apps/api/src/fleet/fleet-session-actions.controller.ts` (taken names = `fleet_checkouts.branch`
      for the remote incl. archived + node `git ls-remote --heads` through an optional
      `remoteHeads: true` request flag this task adds to FL-14's `checkouts.list` in
      `apps/node/src/core/link/modules/checkouts.ts`, answered in a new optional reply field
      `remoteBranches` — additive, FL-14's callers unchanged), DTO in
      `apps/api/src/fleet/dto/fleet-session-actions.dto.ts`. The path is one of the §11.2 additions
      raised in spec §8b.
      **Test**: `apps/api/src/fleet/fleet-session-actions.controller.spec.ts` — proposal shape,
      `unreachable` when the node cannot list remote heads, cross-user 404.
- [ ] **T-05**. Extend FL-04's start dialog (`apps/web/src/components/fleet/sessions/SessionStartDialog.tsx`)
      Where step: `apps/web/src/components/fleet/sessions/BranchProposalField.tsx`,
      preselect **New worktree** for Agent sessions when the folder is a checkout; record
      `checkoutId` on the session start request.
      **Test**: `BranchProposalField.unit.spec.tsx` — default selection, suffix note, Task branch read-only.

## P1.B — Git line with PR, cadence, changes

- [ ] **T-06**. Create `packages/agent/src/fleet/fleet-pr-enrichment.service.ts` (PR by head branch
      through `GitFacadeService`, state, checks roll-up, unresolved review comments, mergeable;
      writes only the CONTRACTS §4.7 fields `{ number, state, checks, url }` to
      `fleet_checkouts.gitLine.pr` and keeps `unresolvedComments`/`mergeable` in the 60 s
      per-checkout cache that the relevance rules read) and
      `packages/tasks/src/tasks/trigger/fleet-pr-enrichment.task.ts` (every minute + ingest nudge on
      `github.pr` events from `apps/api/src/ingest/github/github-pr-review-bridge.service.ts`),
      dispatcher symbol bound in `apps/api/src/fleet/fleet.module.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/fleet-pr-enrichment.service.spec.ts` (cache,
      state mapping, unknown on provider error with age), `packages/tasks/src/__tests__/fleet-pr-enrichment.task.spec.ts`.
- [ ] **T-07** _(parallel)_. Drive the git-line cadence from session `session.status` changes: in
      FL-04's `packages/agent/src/fleet/sessions/fleet-session.service.ts` call FL-14's refresh every
      60 s while `working` and once on `done`/`ended` (`checkouts.list { refresh: true, checkoutIds }`).
      **Test**: extend `packages/agent/src/fleet/sessions/__tests__/fleet-session.service.spec.ts` —
      timer starts/stops with state, stop refresh happens exactly once.
- [ ] **T-08**. Add `checkouts.changes` to `apps/node/src/core/link/modules/checkouts.ts` and
      `apps/node/src/core/checkouts/checkout-changes.ts` (porcelain v2 + `git diff HEAD`, caps,
      binary without patch, `.ever-works/` and `.mounts/` excluded). The verb is in the CONTRACTS
      §3.3 `machine` vocabulary (rev 2).
      **Test**: `apps/node/src/core/checkouts/checkout-changes.spec.ts` — caps per file and total,
      omitted counts, binary, excluded dirs, no HTML in output.
- [ ] **T-09**. Add `GET /api/fleet/checkouts/:id/changes` to `fleet-session-actions.controller.ts`
      (family `checkouts`, consent check, `maxBytes` clamp).
      **Test**: extend the controller spec — `consent_missing`, `unreachable`, clamp.
- [ ] **T-10**. Web: `apps/web/src/components/fleet/sessions/PrPill.tsx` (reuses `safePrUrl` from
      `apps/web/src/components/tasks/TaskPrPill.tsx`), add the `pr` slot to
      `apps/web/src/components/fleet/checkouts/GitLine.tsx`, wire the git line + pill into FL-05's
      `apps/web/src/components/fleet/sessions/SessionCard.tsx` footer slots and FL-04's session
      detail header; `ChangesPanel.tsx` with the text-only rules of `TaskDiffSheet.tsx`; BFF routes
      `apps/web/src/app/api/fleet/checkouts/[id]/changes/route.ts`, `apps/web/src/app/api/fleet/sessions/branch-proposal/route.ts`.
      **Test**: `PrPill.unit.spec.tsx` (tones, invalid URL not rendered), `ChangesPanel.unit.spec.tsx`
      (text node only, omission footer), `GitLine.unit.spec.tsx` extended (pr slot, staleness).
- [ ] **T-11**. i18n `fleet.sessionGit.{gitLine,prPill,changes,branch}` in `apps/web/messages/en.json`;
      write `apps/web/e2e/flow-fleet-session-git.spec.ts` P1 flows (Where default, suffix note,
      git line on card and detail, Changes panel).
      **Test**: e2e green in CI; no literal strings in `components/fleet/sessions/`.

## P2.A — Actions service and delivery

- [ ] **T-12**. Create pure `packages/agent/src/fleet/session-action-rules.ts` (`availableActions(ctx)`
      per spec FR-15, incl. merge-policy `protectedBranches` from `packages/agent/src/policy/merge-policy.service.ts`).
      **Test**: `packages/agent/src/fleet/__tests__/session-action-rules.spec.ts` — full truth table;
      shell provider → none; outside checkout → recap only.
- [ ] **T-13**. Create `packages/agent/src/fleet/fleet-session-action.service.ts` (`list`, `send`:
      render with the Agent's `agent.yml` override or default → `session.input { source:'action',
      actionId }` via FL-04's link service → for an Agent session a ledger row in `agent_run_logs`
      (`step: 'fleet.action'`, `level: 'INFO'`) → for both kinds an audit `node.session.input` with
      `details.action` and a redacted 200-char `promptPreview`; owner-session ledger read from those
      audit rows (spec §8b default); 10/min and 2 s refusals; echo → `deliveredAt`; `resend`).
      **Test**: `packages/agent/src/fleet/__tests__/fleet-session-action.service.spec.ts` — every
      refusal code, ledger + audit per Agent-session send, audit-only ledger for an owner session
      with "session total only" cost, override precedence, delivered/undelivered, resend only when
      undelivered, kill switch.
- [ ] **T-14**. Extend FL-04's daemon input path to accept `source` and `actionId` on
      `session.input` (`apps/node/src/core/sessions/daemon/daemon-protocol.ts`), logging the
      action id, writing prompt + newline to the PTY.
      **Test**: extend `apps/node/src/core/sessions/daemon/__tests__/daemon-protocol.spec.ts` —
      field optional, bytes identical to typed input.
- [ ] **T-15**. Add `GET/POST /api/fleet/sessions/:id/actions`, `GET …/actions/ledger`,
      `POST …/actions/:ledgerId/resend` to `fleet-session-actions.controller.ts`; DTOs.
      **Test**: extend the controller spec — `invalid` with the hidden rule named, `busy`,
      `limit_exceeded`, `permission_denied` (audience `sessions`), `consent_missing` per kind.
- [ ] **T-16**. Create `packages/tasks/src/tasks/trigger/fleet-action-undelivered-sweep.task.ts`
      (every 2 min; Agent-session ledger rows without echo after 5 s → `undelivered`).
      **Test**: `packages/tasks/src/__tests__/fleet-action-undelivered-sweep.task.spec.ts`.

## P2.B — Pull requests, credential in session

- [ ] **T-17**. Create `packages/agent/src/fleet/fleet-pull-request.service.ts`: Task-bound session →
      `TaskWorkspaceService.finalizeRemotePush` (`packages/agent/src/tasks-domain/task-workspace.service.ts:1842`);
      free session → new `openForBranch` beside it; update when a PR exists; refuse on default branch
      or unpushed head; `redactSecrets` on title/body; Agent `canOpenPullRequests` and the Node's
      `checkouts` audience checked; never calls merge.
      **Test**: `packages/agent/src/fleet/__tests__/fleet-pull-request.service.spec.ts` — both paths,
      update vs open, each refusal, Task → `in_review` + `prUrl`, body redacted, no merge call (spy).
- [ ] **T-18**. Add `POST/GET /api/fleet/checkouts/:id/pull-request` accepting a person session or
      the run-scoped `ew_run_…` bearer (`apps/api/src/auth/guards/auth-session.guard.ts` path) scoped
      to the token's own session checkout; whitelist the route for the node MCP bridge in
      `apps/mcp/src/openapi-tools/whitelist.ts` as `fleet_checkouts_open_pull_request`.
      **Test**: extend the controller spec — run token on a foreign checkout → `permission_denied`;
      person path 202; `apps/mcp` whitelist spec extended.
- [ ] **T-19**. Node: `apps/node/src/core/sessions/session-credential-helper.ts` — per-session
      `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n=credential.helper` pointing at a node-local helper that
      answers `git credential fill` with the run-scoped push credential (`apps/node/src/core/workspaces/push-credential.ts`)
      while the lease is alive; Agent sessions only.
      **Test**: `apps/node/src/core/sessions/session-credential-helper.spec.ts` — answers only for
      the covered host/repo and only while leased; owner sessions get no helper; nothing written to
      any git config file.
- [ ] **T-20**. Web: `SessionActionsMenu.tsx`, `SessionActionSheet.tsx`, `SessionActionsLedger.tsx`,
      `OpenPullRequestDialog.tsx`, `session-git.shared.ts` under `apps/web/src/components/fleet/sessions/`;
      wire **Actions ▾** beside **End** on the session detail; keyboard `A`/`D`/`G`/`1`–`7`; BFF
      routes under `apps/web/src/app/api/fleet/sessions/[id]/actions/**` and `.../checkouts/[id]/pull-request/route.ts`.
      **Test**: `SessionActionsMenu.unit.spec.tsx` (hidden reasons, shell → none, protected warning),
      `SessionActionSheet.unit.spec.tsx` (editable, cost note, needs-you warning), `session-git.shared.unit.spec.ts`.
- [ ] **T-21**. Cost: FL-20's scan (`packages/agent/src/fleet/fleet-usage-attribution.service.ts`)
      patches `tokens`/`costCents` onto `fleet.action` ledger rows between consecutive marks; the
      ledger shows "unknown" until then.
      **Test**: extend FL-20's attribution spec — two marks split a session's tokens; no marks → untouched.
- [ ] **T-22**. i18n `fleet.sessionGit.{actions,sheet,pullRequestDialog,ledger}`; extend
      `apps/web/e2e/flow-fleet-session-git.spec.ts` (menu relevance, send → echo → ledger, PR dialog)
      and write `apps/web/e2e/flow-fleet-session-actions-contract.spec.ts`.
      **Test**: green in CI.

## P3 — Clean up, tools, editor

- [ ] **T-23**. Clean up over FL-14's delete (no new route): add the `cleanUp=1` gate (worktree,
      PR merged/closed, no live session → else `invalid` with the rule named) to FL-14's
      `DELETE /api/fleet/checkouts/:id` in `apps/api/src/fleet/fleet-checkouts.controller.ts`, and
      `CleanUpButton.tsx` on FL-05's card and FL-14's `CheckoutRow.tsx` (FL-14's delete preview →
      confirmation → delete, `mode: 'delete'`).
      **Test**: extend `apps/api/src/fleet/fleet-checkouts.controller.spec.ts` (gating codes; no
      gate without `cleanUp=1`), `CleanUpButton.unit.spec.tsx` (visibility matrix), FL-14 handler
      spec — branch kept.
- [ ] **T-24**. Tools `fleet_sessions_actions_list|action`, `fleet_checkouts_changes` in
      `packages/agent/src/fleet/agent-fleet-tools.ts` with §11.3 annotations (Agent Clean up is
      FL-14's `fleet_checkouts_delete` with `cleanUp`); MCP whitelist entries;
      CLI `apps/cli/src/commands/fleet/sessions.ts` (`action`, `changes`, `pull-request`) and a
      `--clean-up` flag on FL-14's `apps/cli/src/commands/fleet/checkouts.ts` `delete`.
      **Test**: `agent-fleet-tools.spec.ts` extended (annotations, audience refusals), CLI command spec
      `apps/cli/src/commands/fleet/__tests__/sessions.spec.ts` (`--json`, exit codes).
- [ ] **T-25**. `apps/web/src/components/agents/AgentInstructionsEditor.tsx` — **Fleet actions**
      section over the `agent.yml` pill: seven template fields with the default beside each, branch
      prefix; writes through the existing agent-file save path.
      **Test**: `AgentInstructionsEditor.unit.spec.tsx` extended — override round-trip, default shown,
      invalid placeholder warning.

## P4 — Docs and rollout

- [ ] **T-26**. Write `docs/features/fleet-session-git.md` (git line, worktree default and naming,
      actions and templates, pull requests via the GitHub App, clean up, cost); add to
      `apps/docs/sidebarsPlatform.ts` beside `'features/fleet'` (`:183`); cross-link from
      `docs/features/sessions-and-steering.md` and `docs/features/task-isolation.md`.
      **Test**: docs build has no broken-link warning.
- [ ] **T-27**. Update `docs/specs/features/fleet/TRACKER.md`; add the §11.2 paths and the
      owner-session ledger resolution raised in spec §8b to CONTRACTS in the same PR (the §3.3 and
      §10 entries already landed in CONTRACTS rev 2); run the banned-terms grep over the folder.
      **Test**: grep prints nothing.
- [ ] **T-28**. `pnpm format && pnpm lint && pnpm test && pnpm build`; boot the API with
      `FLEET_SESSIONS_ENABLED=true` and send one action against a stubbed node in the e2e stack.
      **Test**: all green; the ledger row exists with `deliveredAt`.

## Definition of done

- Every checkbox ticked; ACC-FL06-01 … ACC-FL06-19 verified on `develop` with the flag on.
- No merge call exists in any FL-06 code path (asserted by test); no provider credential reaches a
  session; no prompt text in ledger metadata.
- `pnpm format:check`, `pnpm lint`, docs build clean; Constitution gates in spec §10 confirmed.
