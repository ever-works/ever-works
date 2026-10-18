# FL-18 — Actions runners on computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Feature ID**: `FL-18-actions-runners`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative; run with `pnpm` from the root. Runners: `packages/agent`, `apps/api`,
  `packages/tasks` **Jest**; `packages/plugin`, `packages/plugins/*`, `packages/contracts`,
  `apps/node`, `apps/web` unit **Vitest**; `apps/web` e2e **Playwright**.
- Migration slot `1796180000000`; authored from `apps/api/`; re-stamp only if `develop` moved.
- Prerequisites: FL-09 (`apps/node/src/core/services/` module), FL-02 (link, operations, `machine`
  channel), FL-08 (log source registry), FL-01 (registry, roles), FL-03 (producer registry).
- The spec's open questions on the `FleetActionsRunner` table (CONTRACTS §4) and the two extra audit
  names (§7) must be answered before T-05 and T-11 merge.
- Commit style: `feat(fleet-runners): …`, `feat(plugin-github-actions-runners): …`, `chore(i18n): …`.

---

# PHASE 1 — Install, status, control

## P1.A — Contracts

- [ ] **T-01**. Add `packages/plugin/src/contracts/capabilities/actions-runners.interface.ts` (types +
      `IActionsRunnersPlugin` + guard per plan §4.3); export from `capabilities/index.ts` (after
      L137); append `ACTIONS_RUNNERS: 'actions-runners'` **last** in
      `packages/plugin/src/contracts/facade-capabilities.ts` (after L150). No category change.
      **Test**: `packages/plugin/src/contracts/__tests__/actions-runners.interface.spec.ts`; extend
      the append-only pin specs; `isValidPluginCapability('actions-runners')`.
- [ ] **T-02**. Add `packages/contracts/src/fleet/fleet-runners.types.ts` (plan §4.3) and export from
      `packages/contracts/src/fleet/index.ts`; extend `fleet-jobs.types.ts` with `'runner-install' |
      'runner-control'` (L117, L120) and max-age entries (L239: 3600 / 600) and
      `FLEET_ACTIONS_RUNNER_CAPABILITY`; extend `fleet-panic.types.ts` with
      `node.runner.install|start|stop|remove`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-runners.spec.ts` (count clamp 1–16;
      diagnosis union closed); extend `fleet-jobs.spec.ts`, `fleet-panic.spec.ts`.

## P1.B — Schema

- [ ] **T-03**. Add `packages/agent/src/entities/fleet-actions-runner.entity.ts` (columns per plan
      §4.1; raw uuid columns, `PortableDateColumn`, varchar unions); register in
      `packages/agent/src/entities/index.ts` and the fleet TypeORM feature array.
      **Test**: `pnpm --filter @ever-works/agent build`; entities inventory spec updated.
- [ ] **T-04**. Author `apps/api/src/migrations/1796180000000-CreateFleetActionsRunners.ts` from
      `apps/api/`: one table, three indexes, one unique `(nodeId, name)`; `down` drops the table.
      **Test**: applies twice cleanly; re-generate yields an empty diff.

## P1.C — Plugin and facade

- [ ] **T-05**. Scaffold `packages/plugins/github-actions-runners/` (`package.json` manifest per plan
      §7, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`, `README.md`).
      **Test**: build + empty test green; manifest validator accepts the block.
- [ ] **T-06**. Implement `src/github-actions-runners.plugin.ts`, `src/github-runners-api.ts`
      (downloads list with sha256; registration/remove tokens per scope; list/delete runners;
      conditional requests; rate-limit headers; 403 → permission check), `src/diagnose.ts` (pure),
      `src/testing/fake-github-runners-api.ts`.
      **Test**: `src/__tests__/github-actions-runners.plugin.spec.ts`, `diagnose.spec.ts` per plan §14;
      every method takes the token as a parameter and never logs it.
- [ ] **T-07**. Add `packages/agent/src/facades/actions-runners.facade.ts` (`mintToken` with the
      narrowest permission per operation via `requestGitHubAppInstallationAccessTokenDetails`
      (`packages/agent/src/utils/github-app.utils.ts:91`), `listTargets` from
      `GitHubAppInstallationRepository` + `GitHubAppInstallationRepoRepository` with the ownership
      filter, wrappers for every plugin method); register in `facades.module.ts`, `facades/index.ts`.
      **Test**: `packages/agent/src/facades/__tests__/actions-runners.facade.spec.ts` — permission
      per operation; `repositoryIds` only from the snapshot; suspended/deleted installations
      excluded; `grep -rn "github-actions-runners" packages/agent apps --include=*.ts` returns only
      the listed user-copy exceptions.
- [ ] **T-08**. Add the plugin to `docs/plugin-system/built-in-plugins.md` (count 105 → 106 at L9;
      `integration` row; a short section) — canonical doc only.
      **Test**: docs build clean; no other doc's count edited.

## P1.D — Domain and API

- [ ] **T-09**. Add `packages/agent/src/fleet/runners/fleet-runners.service.ts`: `options` (targets,
      canHost + reason, modes per OS), `install` (limit 16; rows first `installing`; fetch downloads
      via facade; enqueue `runner-install` pinned to the node with `requiredCapabilities
      ['actions-runner']` through the node job-runtime plugin as `fleet-agent-task.dispatcher.ts`
      does; audit per runner), `control` (`runner-control`; `stoppedByOwner`; remove busy guard),
      `onAwaitingToken(runnerId)` (mint register/remove token → `runner.token` over the link via
      FL-02's link service), `mergeState`; `fleet-runners.module.ts`; register in
      `apps/api/src/fleet/fleet.module.ts`.
      **Test**: `packages/agent/src/fleet/runners/__tests__/fleet-runners.service.spec.ts` — token
      never in the job payload; limit; busy guard; kill switch; audit `extra` has no token.
- [ ] **T-10**. Add `apps/api/src/fleet/dto/fleet-runners.dto.ts` and
      `apps/api/src/fleet/fleet-runners.controller.ts` (P1 routes: list, options, install, control),
      `FleetEnabledGuard` + `FLEET_ACTIONS_RUNNERS_ENABLED` (add to `apps/api/src/config/constants.ts`
      and `apps/web/src/lib/fleet-flags.ts`), `@Throttle` tiers, CONTRACTS §8 envelope.
      **Test**: `apps/api/src/fleet/fleet-runners.controller.spec.ts` — one case per status in
      plan §5; 404 when the flag is off.
- [ ] **T-11**. Register the `runner.token` / `runner.list` / `runner.status` vocabulary on the
      `machine` channel (platform side `apps/api/src/fleet/link/machine-channel.handlers.ts`, node side
      `apps/node/src/core/link/machine-channel.ts`) and the `awaiting-token` progress handler that
      calls `onAwaitingToken`.
      **Test**: extend both channel specs — token sent once per request; never logged; resend on
      reconnect when the node re-reports `awaiting-token`.

## P1.E — Node

- [ ] **T-12**. Add `apps/node/src/core/runners/runner-download.ts`, `runner-state.ts`,
      `runner-logs.ts` (FL-08 source `runner:<name>`).
      **Test**: `runner-download.spec.ts` — mismatch deletes and extracts nothing; foreign host
      refused; `runner-logs.spec.ts` — newest `_diag` file chosen.
- [ ] **T-13**. Add `runner-config.ts` (env-input token, `--unattended`, `--replace` only when GitHub
      lists the name for this node, `--runasservice` on win32; refuse if the build rejects env input)
      and `runner-service.ts` (FL-09 adapters per OS; `sudo -n true` probe; elevation probe; exact
      refusal commands).
      **Test**: `runner-config.spec.ts` — argv never contains the token under any input;
      `runner-service.spec.ts` — refusal text per OS.
- [ ] **T-14**. Add `apps/node/src/core/executors/runner-install.ts` and `runner-control.ts`; register
      on the work lane in `apps/node/src/core/runtime.ts` (beside L739) only when `actions-runner` is
      advertised; advertise `actions-runner` in `apps/node/src/core/capabilities.ts` (`--work` + FL-09
      service manager detected).
      **Test**: `executors/runner-install.spec.ts` (phases; waits at `awaiting-token`; resumes after
      a link drop), `runner-control.spec.ts` (remove = stop → config remove → uninstall → delete
      folder); extend `capabilities.spec.ts`, `runtime.spec.ts`.

## P1.F — Web, tools, poll, e2e

- [ ] **T-15**. Add `apps/web/src/components/fleet/runners/runners.shared.ts` and register
      `computer.overview.runnersBlock`, `computer.actions.installRunners` in
      `apps/web/src/components/fleet/registry.ts`.
      **Test**: `runners.shared.unit.spec.ts` — Windows offers Service only; default names
      `<computer>-<n>`.
- [ ] **T-16**. Add `InstallRunnersDialog.tsx`, `RunnersBlock.tsx`, `RunnerRow.tsx`,
      `RunnerActionsMenu.tsx`, `RemoveRunnerDialog.tsx` under `apps/web/src/components/fleet/runners/`;
      BFF routes under `apps/web/src/app/api/fleet/nodes/[id]/runners/**`; **Logs** opens FL-08's tab
      with source `runner:<name>`.
      **Test**: `InstallRunnersDialog.unit.spec.tsx` (count clamp; sudo/elevation state renders the
      command; cost sentence), `RunnersBlock.unit.spec.tsx` (every state glyph).
- [ ] **T-17**. Palette entries (`screens.ts:212` area) and `fleet.runners.*` keys in
      `apps/web/messages/en.json` (spec §5.7).
      **Test**: dotted-key grep unchanged; no literal user strings under `components/fleet/runners/`.
- [ ] **T-18**. Add `packages/tasks/src/tasks/trigger/fleet-runners-poll.task.ts` (every 5 min; P1
      scope: runner states + `runner-stopped` producer with `stoppedByOwner` suppression) and
      `FLEET_RUNNERS_POLL_DISPATCHER`; register in `packages/tasks/src/tasks/trigger/index.ts` (beside
      L25); register the producer with FL-03's registry.
      **Test**: `packages/tasks/src/__tests__/fleet-runners-poll.task.spec.ts` — GitHub wins when
      fresh; item after 5 min; cleared on recovery; owner stop raises nothing.
- [ ] **T-19**. Add `packages/agent/src/fleet/agent-fleet-runners-tools.ts` (P1 tools: list, install,
      action, remove; annotations per plan §9) and MCP whitelist entries
      (`apps/mcp/src/openapi-tools/whitelist.ts` after L530).
      **Test**: `agent-fleet-runners-tools.spec.ts` — install's confirmation text names target,
      count, mode, computer, "No credits are spent".
- [ ] **T-20**. Add `apps/web/e2e/flow-fleet-actions-runners.spec.ts` (fake GitHub API + node contract
      fixture): install 2 → rows → idle; stop → `stopped (by you)`; remove with typed name; sudo
      refusal shows the command.
      **Test**: green locally and in CI.
- [ ] **T-21**. Docs `docs/features/fleet-actions-runners.md` (P1), sidebar entry in
      `apps/docs/sidebarsPlatform.ts` after `features/fleet` (L183); tracker row.
      **Test**: docs build clean.

---

# PHASE 2 — Actions jobs

- [ ] **T-22**. Service: `jobs(userId, targets)` (facade `listJobs` per watched target with ETags;
      `diagnoseJob` from the plugin; busy count), `setWatched`, `cancelRun` (permission `actions:
      write`; audit `node.runner.job.cancel` per CONTRACTS decision), `checkPermission` (org).
      **Test**: extend `fleet-runners.service.spec.ts` — diagnosis per job; cancel refused outside
      `machines`; watched targets must be App-covered.
- [ ] **T-23**. API: `GET /runners/jobs` (30 s cache), `PUT /runners/jobs/watched`,
      `POST /runners/jobs/cancel`, `GET /runners/jobs/permission`.
      **Test**: extend the controller spec; rate-limited response carries `rateLimitedUntil`.
- [ ] **T-24**. Poll task P2: jobs + `job-unassignable` producer (5 min; cleared on start/cancel);
      rate-limit back-off.
      **Test**: extend `fleet-runners-poll.task.spec.ts`.
- [ ] **T-25**. Web: `ActionsJobsPanel.tsx`, `ActionsJobRow.tsx`, `WatchedTargetsEditor.tsx`,
      `GrantAccessCard.tsx`; register `hub.overview.actionsJobs`; org scope in the install dialog with
      the permission check and **Grant access**; BFF under `apps/web/src/app/api/fleet/runners/jobs/**`.
      **Test**: `ActionsJobsPanel.unit.spec.tsx` (diagnosis strings; Cancel hidden outside
      `machines`; rate-limited copy), `GrantAccessCard.unit.spec.tsx`.
- [ ] **T-26**. Tools: `fleet_runners_jobs` (readOnly), `fleet_runners_cancel_run`; MCP whitelist;
      extend the e2e spec (unassignable job → Cancel workflow run; Grant access card).
      **Test**: tools spec; e2e green.

---

# PHASE 3 — Docker-isolated runners, versions, CLI

- [ ] **T-27**. Node: `runner-docker.ts` (container per runner from the official runner image pinned by
      digest, runner folder mounted, `--restart unless-stopped`; the Docker socket shared only with the
      explicit labelled option); dialog mode offered when `docker` on Linux.
      **Test**: `runner-docker.spec.ts` — no socket mount by default; argv assertions.
- [ ] **T-28**. Version visibility: poll task compares installed version with GitHub's latest download;
      **Update available** note; reinstall action (`runner-control` `reinstall`).
      **Test**: poll spec; row renders the note.
- [ ] **T-29**. CLI `apps/cli/src/commands/fleet/runners.ts` under FL-19's `fleet` root.
      **Test**: `apps/cli/src/commands/fleet/__tests__/runners.spec.ts` — `--json` shapes equal DTOs.

---

# Docs & rollout

- [ ] **T-30**. Finish `docs/features/fleet-actions-runners.md` (what is installed where, token
      handling, permissions needed, diagnosis meanings, Windows service-only, Docker mode caveats).
- [ ] **T-31**. Update `docs/specs/features/fleet/TRACKER.md`; plugin count only in the canonical doc.
- [ ] **T-32**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; banned-terms grep over
      this folder, the plugin and the docs prints nothing.

## Definition of done

- All checkboxes ticked; every FR in spec §4 has a passing test named above.
- `FLEET_ACTIONS_RUNNERS_ENABLED=false` hides every route and surface; `=true` passes spec §9.
- No registration or remove token appears in any job payload, argv, log line, audit row or API
  response; installation tokens are minted with the narrowest permission per operation.
- The plugin is counted once in the canonical plugin document; no core file names its id.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings; spec §10 gates confirmed.
