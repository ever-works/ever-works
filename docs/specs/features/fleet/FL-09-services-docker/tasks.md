# FL-09 — Services, Docker, Compose & processes · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> _(parallel)_ may run alongside the task immediately above them.

**Feature ID**: `FL-09-services-docker`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; `pnpm` from the root.
- Runners: `packages/agent`, `apps/api` → **Jest**; `apps/node`, `packages/contracts`, `apps/mcp`,
  `apps/web` unit → **Vitest**; `apps/web` e2e → **Playwright**.
- Prerequisites: FL-02 (link client, module contract, operation runner, `NodeLinkService`,
  gateway), FL-01 (`registerComputerTab`, `registerOverviewBlock`, `assertFamily`), FL-08
  (`apps/node/src/core/link/allowed-roots.ts`, `FleetMachineFactsEnabledGuard`, log deep links), FL-04 for
  P3 exec Sessions. Adapt their merged names in one place each.
- No migration in this epic (no FL-09 slot in CONTRACTS §13).
- Never pass a user-supplied name through a shell string; every child gets an argv array. The
  lint rule in T-05 enforces it.
- Add new tasks at the bottom; never renumber. Commits: `feat(fleet-machine): …`,
  `feat(fleet-docker): …`, `test(fleet-machine): …`, `chore(i18n): …`.

---

# PHASE 1 — Services and processes

## P1.A — Contracts

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-machine-actions.types.ts` (confirmation
      classes, `FleetBlastRadius`, `FleetActionConfirmFields` — the CONTRACTS §2.2 fields `confirm`,
      `confirmName`, `acknowledgeBlastRadius` — `FleetRootRequirement`, `FleetOperationRef`)
      and export from `packages/contracts/src/fleet/index.ts`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-machine-actions.spec.ts`.
- [ ] **T-02**. Add `fleet-services.types.ts` and `fleet-processes.types.ts` under
      `packages/contracts/src/fleet/` (types, `FLEET_SERVICE_ACTIONS`, strict name patterns,
      `FLEET_PROCESS_LIST_MAX = 300`, signals).
    - **Test**: `fleet-services.spec.ts`, `fleet-processes.spec.ts` — patterns reject `;`, `|`, `$(`,
      backticks, newlines, leading `-`.
- [ ] **T-03**. Add the 19 §7 audit members to `FleetAuditAction` / `FLEET_AUDIT_ACTIONS` in
      `packages/contracts/src/fleet/fleet-panic.types.ts` and `FLEET_SERVICES_CAPABILITY`,
      `FLEET_PROCESSES_CAPABILITY` to `fleet-jobs.types.ts`.
    - **Test**: extend `fleet-panic.spec.ts` and the jobs spec.

## P1.B — Shared node pieces

- [ ] **T-04**. Write `apps/node/src/core/link/modules/shared/root-runner.ts`
      (`runPossiblyAsRoot`, `sudo -n` refusal detection, Windows admin probe, exact-command rendering
      for both OS families, 60 s per-argv probe cache).
    - **Test**: `root-runner.spec.ts` — refusal text variants → `{ refused: 'root-required', command }`;
      never passes `-S`/a password.
- [ ] **T-05**. Write `apps/node/src/core/link/modules/shared/argv-safety.ts` and
      `blast-radius.ts` (per-OS pattern table incl. the node's own unit/label/service name from
      install info; sentences per kind); add an eslint `no-restricted-syntax` rule for `docker.sock`
      strings and `child_process.exec` under `apps/node/src/core/link/modules/**` in `apps/node/eslint.config.*`.
    - **Test**: `argv-safety.spec.ts`, `blast-radius.spec.ts` (NetworkManager, sshd, tailscaled,
      wg-quick@wg0, ever-works-node@ops, Windows `Dnscache`, launchd `com.openssh.sshd`).

## P1.C — Services module

- [ ] **T-06**. Write `apps/node/src/core/link/modules/services/systemd-manager.ts` (JSON list with
      text fallback, `--user`, enablement, `MainPID`, actions via root-runner).
    - **Test**: `systemd-manager.spec.ts` with fixtures under `modules/services/__fixtures__/`.
- [ ] **T-07** _(parallel)_. Write `launchd-manager.ts` (`launchctl print` parser, Homebrew JSON,
      at-boot semantics) and `windows-services.ts` (CIM JSON, actions, StartupType).
    - **Test**: `launchd-manager.spec.ts`, `windows-services.spec.ts`.
- [ ] **T-08**. Write `apps/node/src/core/link/modules/services/index.ts` (`createServicesModule`:
      detect manager, `services.list` with ordering/CPU/mem via the processes module, `services.action`,
      `failedCount()`); register with one entry in FL-02's compile-time module array
      `apps/node/src/core/link/modules/index.ts`; advertise
      `services` under `manage` when a manager exists; feed `failedServices` into the heartbeat
      health sample (FL-03 hook).
    - **Test**: `index.spec.ts` — no tag without a manager; failed first; action result shapes;
      root refusal envelope.

## P1.D — Processes module

- [ ] **T-09**. Write `apps/node/src/core/link/modules/processes/process-list.ts` (per-OS parsers, top
      300, CPU% of one core, run time, command truncated 200 + `redactSecrets`) and
      `self-protection.ts` (own pid chain, daemon pid, pid 1).
    - **Test**: `process-list.spec.ts` (Linux/macOS/Windows fixtures; redaction), `self-protection.spec.ts`.
- [ ] **T-10** _(parallel)_. Write `gpu-stats.ts` extending `apps/node/src/core/gpu-probe.ts`
      vendors with utilisation/memory readers (nvidia-smi query, AMD sysfs, Apple
      `system_profiler` with `utilizationPercent: null`).
    - **Test**: `gpu-stats.spec.ts` — Apple yields null utilisation, never 0.
- [ ] **T-11**. Write `apps/node/src/core/link/modules/processes/index.ts` (`processes.list`,
      `processes.signal` with protection + root rule); register; advertise `processes` under `manage`.
    - **Test**: `index.spec.ts` — protected pid → `invalid`; other user → root rule; TERM/KILL argv.

## P1.E — Platform guard and API

- [ ] **T-12**. Write `packages/agent/src/fleet/machine-actions/machine-action.guard.ts`
      (consent → family via FL-01 `assertFamily` → kill switch → CONTRACTS §2.2 field check:
      `confirm: true`, `confirmName` for `confirm-destructive`, `acknowledgeBlastRadius: true` for
      `blast-radius` → typed refusal values) and `machine-action.audit.ts` (row builder: name, target,
      requestedBy, class, outcome, blastRadius.kind, rootRequired). Export from `packages/agent/src/fleet/index.ts`.
    - **Test**: `machine-actions/__tests__/machine-action.guard.spec.ts` — every CONTRACTS §8 code;
      a missing field → `confirmation_required` with the class (and the sentence for
      `blast-radius`); audit details pass `REDACTED_KEY_RE`.
- [ ] **T-13**. Write `packages/agent/src/fleet/services/fleet-services.service.ts` and
      `packages/agent/src/fleet/processes/fleet-processes.service.ts` (list via link, action via guard,
      audit, the node's root refusal surfaced as `root_required` (409) with the command as `hint`).
    - **Test**: `services/__tests__/fleet-services.service.spec.ts`, `processes/__tests__/fleet-processes.service.spec.ts`.
- [ ] **T-14**. Write `apps/api/src/fleet/services/fleet-services.controller.ts` + `dto/`,
      `apps/api/src/fleet/processes/fleet-processes.controller.ts` + `dto/`; register in
      `apps/api/src/fleet/fleet.module.ts`; guards `FleetEnabledGuard`, `FleetMachineFactsEnabledGuard`;
      throttles per plan §5; Swagger.
    - **Test**: `fleet-services.controller.spec.ts`, `fleet-processes.controller.spec.ts`;
      `apps/api/test/fleet-machine-actions.e2e-spec.ts` (fake link peer; list, action, root refusal).

## P1.F — Web

- [ ] **T-15**. Write shared components under `apps/web/src/components/fleet/shared/`:
      `ConfirmActionDialog.tsx` (four classes; red "anyway" button; typed-name gate),
      `RootRequiredDialog.tsx`, `machine-actions.shared.ts`; add `OperationCard.tsx` + `use-operation.ts`
      only if FL-02 did not ship them.
    - **Test**: `ConfirmActionDialog.unit.spec.tsx`, `machine-actions.shared.unit.spec.ts`.
- [ ] **T-16**. Write `apps/web/src/components/fleet/services/` — `ServicesTab.tsx`, `ServiceRow.tsx`,
      `services.shared.ts`, `services-tab.registry.ts` (FL-01 entry `{ id: 'services', labelKey,
      order, epic, flag, consent: 'manage', load }`; palette "Services on <computer>" in FL-01's
      `apps/web/src/components/command-palette/registry/sections.ts`); BFF routes
      `apps/web/src/app/api/fleet/nodes/[id]/services/route.ts` and `.../services/[name]/[action]/route.ts`.
      Every state of spec §5.9; **Log** row action deep-links through FL-08's `openLogsForSource`.
    - **Test**: `services.shared.unit.spec.ts` (ordering), `ServicesTab.unit.spec.tsx` (states, risk markers).
- [ ] **T-17** _(parallel)_. Write `apps/web/src/components/fleet/processes/` — `ProcessesTab.tsx`,
      `GpuStrip.tsx`, `ProcessTable.tsx`, `SignalDialog.tsx`, `processes.shared.ts`,
      `processes-tab.registry.ts`; BFF `.../processes/route.ts`, `.../processes/[pid]/signal/route.ts`.
    - **Test**: `processes.shared.unit.spec.ts`, `ProcessesTab.unit.spec.tsx` (protected rows have
      no buttons; "still running — Kill?" after 5 s).

## P1.G — Tools, i18n, e2e

- [ ] **T-18**. Write `packages/agent/src/fleet/services/agent-fleet-services-tools.ts` and
      `packages/agent/src/fleet/processes/agent-fleet-processes-tools.ts` (annotations per plan §9;
      blast-radius / KILL below trust level → `agent_action_proposals` row `fleet_machine_action`
      (CONTRACTS R-33); approval re-runs with the §2.2 confirmation fields); concatenate beside
      `buildFleetTools`; add MCP whitelist
      entries in `apps/mcp/src/openapi-tools/whitelist.ts`.
    - **Test**: both tool specs; whitelist spec.
- [ ] **T-19**. Add i18n groups `fleet.services.*`, `fleet.processes.*`, `fleet.actions.*`,
      `fleet.operations.*`, `fleet.computer.tabs.{services,processes}` to `apps/web/messages/en.json`;
      write `apps/web/e2e/flow-fleet-services.spec.ts`, `flow-fleet-processes.spec.ts`,
      `flow-fleet-machine-actions-contract.spec.ts`.
    - **Test**: the specs; dotted-key grep unchanged.

# PHASE 2 — Docker containers and images

## P2.A — Docker module

- [ ] **T-20**. Add `packages/contracts/src/fleet/fleet-docker.types.ts` (containers, images, run
      request, compose shapes, name/ref patterns); export.
    - **Test**: `fleet-docker.spec.ts`.
- [ ] **T-21**. Write `apps/node/src/core/link/modules/docker/docker-cli.ts` (argv builders, JSON-line
      parsers, PATH lookup only), `containers.ts`, `images.ts`.
    - **Test**: `docker-cli.spec.ts`, `containers.spec.ts`, `images.spec.ts` (Engine + Desktop fixtures).
- [ ] **T-22**. Write `run-request.ts` (allow-listed flags; mounts under FL-08's allowed roots or
      named volumes; refuse privileged / host namespaces / cap-add / socket; env names on argv,
      values through the child's environment) and `operations.ts` (FL-02 runner adapter, pull
      percent parser, last-20 records ≤ 1 MiB).
    - **Test**: `run-request.spec.ts` (every refusal; argv never contains a value), `operations.spec.ts`.
- [ ] **T-23**. Write `apps/node/src/core/link/modules/docker/index.ts` (`docker.containers|images`,
      `docker.container.action` start/stop/restart/remove, `docker.run`, `docker.image.pull|remove|prune`);
      register when `docker` is detected.
    - **Test**: `index.spec.ts` — daemon down → `operation_failed` hint; remove in-use image → `busy`.

## P2.B — Docker API and service

- [ ] **T-24**. Write `packages/agent/src/fleet/docker/fleet-docker.service.ts` and
      `apps/api/src/fleet/docker/fleet-docker.controller.ts` + `dto/` (routes per plan §5 — pull is
      `POST /nodes/:id/docker/images`, remove `POST …/images/:iid/remove`, prune
      `DELETE …/images?unused=true`, all §11.2 paths; container `remove` requires `confirmName`;
      operations return `202 { operationId }`); register in `fleet.module.ts`.
    - **Test**: `fleet-docker.service.spec.ts` (audit carries `envVarNames` only),
      `fleet-docker.controller.spec.ts`; extend the e2e spec with run/pull/prune lifecycle.

## P2.C — Docker web and Runs here

- [ ] **T-25**. Write `apps/web/src/components/fleet/docker/` — `DockerTab.tsx`, `ContainersList.tsx`,
      `ImagesList.tsx`, `RunContainerDialog.tsx` (masked values, root-limited volume picker, command
      preview, disk-free line, cloud billing line via FL-17 `providerMeta`), `docker.shared.ts`,
      `docker-tab.registry.ts` (tab through `registerComputerTab`, palette through FL-01's
      `sections.ts`, Overview block through `registerOverviewBlock`); `RunsHereBlock.tsx`; BFF routes
      under `apps/web/src/app/api/fleet/nodes/[id]/docker/**`.
    - **Test**: `RunContainerDialog.unit.spec.tsx` (refused options, preview line, no value in
      preview), `docker.shared.unit.spec.ts`, `RunsHereBlock.unit.spec.tsx`.

## P2.D — Docker tools, i18n, e2e

- [ ] **T-26**. Write `packages/agent/src/fleet/docker/agent-fleet-docker-tools.ts`
      (`fleet_docker_containers_list`, `fleet_docker_container_action`, `fleet_docker_run`,
      `fleet_docker_images_list`, `fleet_docker_image_action`; annotations per plan §9; Approvals for
      `remove`/`prune` below trust); MCP whitelist entries; `fleet.docker.*` i18n;
      `apps/web/e2e/flow-fleet-docker.spec.ts` (P2 part).
    - **Test**: tool spec; whitelist spec; e2e.

# PHASE 3 — Compose and shell inside

## P3.A — Compose module and API

- [ ] **T-27**. Write `apps/node/src/core/link/modules/docker/compose.ts` (`compose ls`, `config`, `ps`
      merge into `FleetComposeDescription`; `filesMissing`; actions up/down/restart/pull as
      operations, optional `service`; `down` never passes `-v`) and wire `compose.list|describe|action`
      in `docker/index.ts`.
    - **Test**: `compose.spec.ts` — depends_on conditions, missing files → Down only, argv never has `-v`.
- [ ] **T-28**. Extend `fleet-docker.service.ts` / `fleet-docker.controller.ts` with the compose
      routes (plan §5: `GET /nodes/:id/docker/compose[?project=]`, `POST …/compose/:project/:action`)
      and `exec` (`{ sessionId }` via FL-04 `FleetSessionService.startOwner`).
    - **Test**: service/controller specs; e2e compose lifecycle with the fake peer.

## P3.B — Compose web

- [ ] **T-29**. Write `ComposeList.tsx`, `ComposeProject.tsx`, `ComposePicture.tsx` (SVG),
      `compose-layout.ts` (layered DAG, deterministic), `ComposeServiceTable.tsx` under
      `apps/web/src/components/fleet/docker/`; **Logs** view calls FL-08's `openMergedLogs`.
    - **Test**: `compose-layout.unit.spec.ts` (layering, cycle tolerance, stable order),
      `ComposePicture.unit.spec.tsx` (amber arrow while `service_healthy` unmet; red when down).

## P3.C — Shell inside

- [ ] **T-30**. Write `apps/node/src/core/link/modules/docker/exec-session.ts` (shell detection inside the
      image; daemon start request `['docker','exec','-it',id,shell]`, kind owner, title
      `Shell · inside <name>`); add **Shell inside ▾** to `ContainersList.tsx`, the picture and the
      service table, opening the Session via FL-04's terminal route; audit `node.docker.container.exec`
      + `node.session.start`.
    - **Test**: `exec-session.spec.ts`; e2e: shell appears on the Sessions tab and ends with the Session.
- [ ] **T-31**. Add `fleet_docker_compose_list`, `fleet_docker_compose_describe`,
      `fleet_docker_compose_action`, `fleet_docker_exec` to `agent-fleet-docker-tools.ts` and the MCP whitelist; `fleet.docker.compose.*`
      i18n; finish `flow-fleet-docker.spec.ts` (P3 part).
    - **Test**: tool spec; whitelist spec; e2e.

## Docs and rollout

- [ ] **T-32**. Write `docs/features/fleet-services-docker.md` (the three tabs, the root rule and how
      to pre-authorise `sudo -n` for the node's user, blast-radius sentences, Docker CLI-only policy
      and refused run options, Compose views, shell inside, Agent tools); add after `'features/fleet'`
      in `apps/docs/sidebarsPlatform.ts` (`:183`, after FL-08's entry) and a row in `docs/features/index.md`.
    - **Test**: `pnpm --filter ever-works-docs build` — no broken links.
- [ ] **T-33**. Update [`../TRACKER.md`](../TRACKER.md) FL-09 row and the `Status` fields of the three
      documents; add the CONTRACTS §10 rows raised in spec §8b in the same PR.
    - **Test**: docs build clean; the banned-terms grep over this folder prints nothing.
- [ ] **T-34**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`; run the banned-terms grep over
      this folder — it must print nothing.
    - **Test**: the four commands exit 0; the grep prints nothing.

## Definition of done

- All checkboxes ticked; ACC-FL09-01…23 green on `develop` behind `FLEET_MACHINE_FACTS_ENABLED`.
- Static rule proves no code under `apps/node/src/core/link/modules/` names the Docker socket or shells out
  with a string; the e2e proves env values never appear in audit, operation output or tool results.
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green; docs build clean.
- Constitution gates in `spec.md` §10 confirmed; TRACKER row updated.
