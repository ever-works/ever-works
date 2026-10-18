# FL-15 — Tasks & GitHub on the fleet · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-15-tasks-and-github`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run with `pnpm` from the root.
- Runners: `packages/agent`, `apps/api` → **Jest**; `apps/node`, `packages/contracts`, `apps/web`
  unit → **Vitest**; `apps/web` e2e → **Playwright**.
- **No migration in this epic** (no FL-15 slot). The Trigger matcher column is `simple-json`
  (`packages/agent/src/entities/inbound-trigger.entity.ts:151-152`), so the audience key needs none;
  T-12 keeps a test that proves it.
- Blocked by FL-04 (session start — this epic adds the optional `taskId`), FL-06 (Task-branch reuse,
  git line, PR pill), FL-14 (Checkouts), FL-01 (computer Settings tab registry). Confirmations use
  CONTRACTS §2.2's request fields; node code lives under `apps/node/src/core/link/modules/` (R-40).
- One task = one PR. Add new tasks at the bottom; never renumber.
- Commit style: `feat(fleet-tasks): …`, `feat(triggers): …`, `feat(node): …`, `test(fleet): …`.

---

## P1.A — Contracts and hand-off service

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-task-handoff.types.ts` (computers, closed-set
      reasons, candidate agents, checkout choice, Computer block, `FleetGitIdentity`,
      `FleetGithubAudience`) and the optional `taskId` on FL-04's `FleetSessionStartRequest`
      (additive); export from `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-task-handoff.types.spec.ts`.
- [ ] **T-02**. Create pure `packages/agent/src/fleet/task-handoff.rules.ts` (`eligibleComputers`,
      `defaultCheckoutChoice`, `buildFirstMessage` with the 2 000-char excerpt and source link).
      **Test**: `packages/agent/src/fleet/__tests__/task-handoff.rules.spec.ts` — eligibility truth
      table, pin constrains to one, excerpt cap, Trigger source link included.
- [ ] **T-03**. Create `packages/agent/src/fleet/fleet-task-handoff.service.ts` (`options`: nodes via
      `FleetService.listForUser`, affinity via `FleetAgentNodeAffinityService.getAffinity`,
      candidates via the resolver `RunWithAgentMenu` uses, checkouts via FL-14; `validateStart`, called
      by FL-04's `FleetSessionService.start` whenever the request carries `taskId`: eligibility,
      Task branch, Run carries the Task, `busy` when an in-flight session exists for (task, agent)).
      **Test**: `packages/agent/src/fleet/__tests__/fleet-task-handoff.service.spec.ts` — every
      refusal code, affinity never written, Run carries `taskId`.
- [ ] **T-04**. Create `apps/api/src/fleet/fleet-task-handoff.controller.ts` (`GET /tasks/:id/handoff-options`,
      a proposed CONTRACTS §11.2 addition — spec §8b) with DTOs in
      `apps/api/src/fleet/dto/fleet-task-handoff.dto.ts`; mount in `apps/api/src/fleet/fleet.module.ts`.
      Extend FL-04's `POST /api/fleet/nodes/:id/sessions` DTO with optional `taskId` (routing to
      `validateStart`) and FL-04/FL-05's `GET /api/fleet/sessions` with a `taskId` filter. No
      `/tasks/:id/handoff` or `/tasks/:id/computer` route.
      **Test**: `apps/api/src/fleet/fleet-task-handoff.controller.spec.ts` — codes/hints, cross-user 404,
      flag off → 404; FL-04's sessions controller spec extended — start with `taskId` (202 shape,
      every refusal, `busy` dedup), list filtered by `taskId`.

## P1.B — Web

- [ ] **T-05**. Create `apps/web/src/components/fleet/tasks/task-handoff.shared.ts` and
      `FixOnComputerDialog.tsx` with `ComputerPicker.tsx` (reuses `runnerDotClass` from
      `apps/web/src/components/dashboard/runner-status.shared.ts`), `CheckoutChoice.tsx`,
      `FirstMessageField.tsx`, `IdentityLine.tsx` (placeholder until P2); BFF route
      `apps/web/src/app/api/fleet/tasks/[id]/handoff-options/route.ts` (the start and the block reuse
      FL-04's session BFF routes with `taskId`).
      **Test**: `task-handoff.shared.unit.spec.ts`, `FixOnComputerDialog.unit.spec.tsx` — pin note,
      reasons, Start disabled when nothing is selectable, cost sentence present.
- [ ] **T-06**. Add `apps/web/src/components/tasks/FixOnComputerButton.tsx` beside `RunWithAgentMenu`
      in `apps/web/src/components/tasks/TaskDetailClient.tsx`'s button row and a ⋯ menu item in
      `apps/web/src/components/tasks/TasksKanbanView.tsx`; keyboard `F` on Task detail.
      **Test**: `FixOnComputerButton.unit.spec.tsx` — hidden without flags or nodes; opens the dialog.
- [ ] **T-07**. Create `apps/web/src/components/tasks/TaskFleetSection.tsx` (Computer block from
      `GET /api/fleet/sessions?taskId=<id>&limit=1` and the session's checkout: session
      state glyph, elapsed, Open/End, checkout + FL-14 `GitLine`, `TaskPrPill`) mounted after
      `TaskRunControls` (`TaskDetailClient.tsx:541`); fill FL-05's `taskChip` slot in
      `apps/web/src/components/fleet/sessions/SessionCard.tsx`.
      **Test**: `TaskFleetSection.unit.spec.tsx` (empty/live/ended/offline), `SessionCard.unit.spec.tsx`
      extended (chip links to the Task).
- [ ] **T-08**. i18n `fleet.taskHandoff.*` in `apps/web/messages/en.json`; palette entry in
      `apps/web/src/components/command-palette/registry/screens.ts`; write
      `apps/web/e2e/flow-fleet-task-handoff.spec.ts`.
      **Test**: e2e green; no literal strings in `components/fleet/tasks/`.

## P2 — Git identity

- [ ] **T-09**. Create `apps/node/src/core/link/modules/git/git-identity.ts` (`read`, `set`; argv-only;
      exit 1 = unset; control characters refused) and the module `apps/node/src/core/link/modules/git.ts`
      registering `git.identity` / `git.setIdentity` (CONTRACTS §3.3) on FL-02's `machine` verb router
      (`--manage`; `kill_switch`; refused under `link.pause`); one entry in
      `apps/node/src/core/link/modules/index.ts` (R-40).
      **Test**: `apps/node/src/core/link/modules/git/git-identity.spec.ts`, `apps/node/src/core/link/modules/git.spec.ts`.
- [ ] **T-10**. Create `packages/agent/src/fleet/fleet-git-identity.service.ts` (read with 60 s
      cache; owner-only values; `canPushForAgents` from the `git-push` tag + installation
      repositories; `set` requires `confirm: true` (CONTRACTS §2.2) and the `commands` family
      (§2.1) → node → audit `node.git.identity.set` with field names only) and
      `apps/api/src/fleet/fleet-git-identity.controller.ts` (`GET/POST /nodes/:id/git/identity`,
      CONTRACTS §11.2), DTO `apps/api/src/fleet/dto/fleet-git-identity.dto.ts`; add
      `node.git.identity.set` (CONTRACTS §7) to `packages/contracts/src/fleet/fleet-panic.types.ts`.
      **Test**: `fleet-git-identity.service.spec.ts` (values masked for non-owners, no-reply email
      composition, account-email warning path, audit has no value), controller spec (codes, 5/min).
- [ ] **T-11**. Create `apps/web/src/components/fleet/git/GitIdentityCard.tsx` and mount it as a
      section of FL-01's `apps/web/src/components/fleet/computer/tabs/SettingsTab.tsx` (flag-gated; FL-01's
      registry has no settings-card hook); fill `IdentityLine.tsx` in the
      dialog; BFF `apps/web/src/app/api/fleet/nodes/[id]/git/identity/route.ts`; i18n
      `fleet.gitIdentity.*`; write `apps/web/e2e/flow-fleet-git-identity.spec.ts`.
      **Test**: `GitIdentityCard.unit.spec.tsx` (states, confirm wording names the machine), e2e green.

## P3 — Trigger source, PR checkout, tools

- [ ] **T-12**. `eventMatcher` on `packages/agent/src/entities/inbound-trigger.entity.ts` is
      `simple-json` (L151-152); add optional `audience?: { me: FleetGithubAudience[] }` to
      `InboundTriggerEventMatcher`; extend `packages/agent/src/triggers/trigger-event-matcher.ts` to
      take the owner's GitHub login and evaluate the audience; pass the login from
      `packages/agent/src/triggers/inbound-triggers.service.ts` (`github_app_user_links.githubLogin`).
      **Test**: `packages/agent/src/triggers/__tests__/trigger-event-matcher.spec.ts` extended —
      audience × login matrix, missing key = today's behaviour, case-insensitive login.
- [ ] **T-13**. Create `apps/api/src/ingest/github/github-pr-intake.service.ts` beside the issue
      intake: `pull_request` actions `review_requested · review_request_removed · assigned ·
      unassigned · opened · ready_for_review · reopened · closed` → `github.pr` envelopes with
      `requestedReviewer`, `assignees`, `author`, `headRef`, `headRepo`, `maintainerCanModify`;
      register in `github-webhook-dispatcher.service.ts`.
      **Test**: `apps/api/src/ingest/github/github-pr-intake.service.spec.ts` — each action, subject
      coalescing id, bridge-owned actions untouched.
- [ ] **T-14**. Add the preset `POST /api/inbound-triggers/presets/github-for-me` to the Triggers
      controller (refuse without a GitHub link → `invalid` with hint); Task builder in
      `packages/agent/src/triggers/trigger-prompt.ts` adds the `github` label and the source link to
      the description (`tasks` has no `metadata` column; the structured source is resolved at
      hand-off time, T-16).
      **Test**: `inbound-triggers.service.spec.ts` extended — preset shape, refusal, second event on
      the same PR updates the Task.
- [ ] **T-15**. Triggers UI: **About me** group and `GithubForMePreset.tsx` in
      `apps/web/src/components/tasks/TaskTriggersClient.tsx`; `for me` badge; i18n `fleet.githubTrigger.*`;
      `apps/web/e2e/flow-fleet-github-for-me-trigger.spec.ts`.
      **Test**: `TaskTriggersClient.unit.spec.tsx` extended; e2e green.
- [ ] **T-16**. PR-branch checkout: `task-handoff.rules.ts` resolves the PR source from the Trigger
      fire that created the Task (`inbound_trigger_fires.taskId` → its delivery `dedupeKey` → the
      ingested event's `github.pr` envelope; else the description's link via the GitHub App) → checkout
      choice on `headRef` (fork → read-only unless `maintainerCanModify`); first message
      switches to the review wording; FL-14 create request carries `branch: headRef`, `baseRef`.
      **Test**: extend `task-handoff.rules.spec.ts` and `fleet-task-handoff.service.spec.ts` — same-repo
      vs fork; read-only flag surfaces in the dialog copy; a Task without a fire falls back to the
      link.
- [ ] **T-17**. Tools `fleet_tasks_handoff_options` (read-only), `fleet_nodes_git_identity_get` /
      `fleet_nodes_git_identity_set` (CONTRACTS §11.3 names) and the `taskId` parameter on
      FL-04/FL-19's `fleet_sessions_start` in `packages/agent/src/fleet/agent-fleet-tools.ts`; MCP
      whitelist entries with the same names in `apps/mcp/src/openapi-tools/whitelist.ts`; CLI verbs
      `ever-works fleet sessions start --task …` in `apps/cli/src/commands/fleet/session.ts` and
      `ever-works fleet nodes git-identity …` in `apps/cli/src/commands/fleet/nodes.ts` (FL-19's files).
      **Test**: `agent-fleet-tools.spec.ts` extended (annotations, audience refusals), MCP whitelist
      spec, `apps/cli/src/commands/fleet/__tests__/{session,nodes}.spec.ts` extended.

## P4 — Docs and rollout

- [ ] **T-18**. Write `docs/features/fleet-tasks-and-github.md` (fix on this computer, Computer
      block, "for me" Trigger, git identity); add to `apps/docs/sidebarsPlatform.ts` beside
      `'features/fleet'` (`:183`); cross-link from `docs/features/tasks.md` (§"Run with agent") and
      `docs/features/inbound-triggers.md`.
      **Test**: docs build has no broken-link warning.
- [ ] **T-19**. Update `docs/specs/features/fleet/TRACKER.md`; amend CONTRACTS in the same PR with
      whatever spec §8b still lists (the §3.3/§7 identity names are already in CONTRACTS rev 2); run
      the banned-terms grep over this folder.
      **Test**: grep prints nothing.
- [ ] **T-20**. `pnpm format && pnpm lint && pnpm test && pnpm build`; boot the API with both flags on
      and hand one seeded Task to a stubbed node in the e2e stack.
      **Test**: all green; the Task's Computer block shows the session.

## Definition of done

- Every checkbox ticked; ACC-FL15-01 … ACC-FL15-17 verified on `develop` with the flags on.
- Affinity rows are provably unchanged by any hand-off (asserted by test); no email value appears
  in any audit row; no token is written to any machine.
- `pnpm format:check`, `pnpm lint`, docs build clean; Constitution gates in spec §10 confirmed.
