# FL-16 — Virtual computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Feature ID**: `FL-16-virtual-computers`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run everything with `pnpm` from the root.
- Runners: `packages/agent`, `apps/api`, `packages/tasks` use **Jest**; `apps/node`,
  `packages/contracts`, `apps/web` unit use **Vitest**; `apps/web` e2e uses **Playwright**.
- Migrations are authored from `apps/api/`; the API applies them on boot. Re-stamp slot
  `1796160000000` only if `develop` moved past it (README rule 10).
- Prerequisites assumed landed: FL-01 (registry, roles, nesting), FL-02 (link, operations, `managed`,
  `--manage`, the link module registry `apps/node/src/core/link/modules/index.ts`), FL-09
  (`apps/node/src/core/link/modules/docker/docker-cli.ts`, the Runs here block); FL-10 for P2. Where a
  prerequisite is not yet merged, build against its contract and mark the task blocked in the PR.
- Node modules live under `apps/node/src/core/link/modules/<family>/` (CONTRACTS R-40); job
  executors stay in `apps/node/src/core/executors/`.
- Confirmation is the request fields `confirm` / `confirmName` with a 409 `confirmation_required`
  preview (CONTRACTS §2.2) — never a token.
- Commit style: `feat(fleet-virtual): …`, `test(fleet-virtual): …`, `chore(i18n): …`.
- Never name a third-party product that informed this program (README rule 16).

---

# PHASE 1 — Containers

## P1.A — Contracts

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-virtual.types.ts` (kinds, origin, systems with
      arch, options/host reasons, create request/response, job payloads, constants per plan §4.3);
      export from `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-virtual.spec.ts` — every system has a
      kind and ≥ 1 arch; Arch is x64-only; name pattern accepts `ubuntu-nina`, rejects `Ubuntu_1`.
- [ ] **T-02**. Extend `packages/contracts/src/fleet/fleet-jobs.types.ts`: `'vm-create' | 'vm-control'`
      in `FleetJobKind` (L117) and `FLEET_JOB_KINDS` (L120); entries in
      `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` (L239: `vm-create` 3600, `vm-control` 600);
      `FLEET_KVM_CAPABILITY = 'kvm'`.
      **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-jobs.spec.ts` — the record has
      an entry for every kind; `isFleetJobKind('vm-create')` is true.
- [ ] **T-03** _(parallel)_. Extend `packages/contracts/src/fleet/fleet-node.types.ts`: optional
      `origin`, `hostNodeId`, `virtualKind`, `virtual` (with `FleetVirtualState`, plan §4.3) on
      `FleetNodeView` (L329); extend `fleet-panic.types.ts` with
      `node.vm.create|start|stop|destroy|resize|rebuild` and `node.vm.password.reveal` (CONTRACTS §7;
      L60, L116).
      **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts`; the node
      contract conformance fixture `packages/contracts/fixtures/fleet-node-contract.v1.json` still
      validates (fields are optional).

## P1.B — Schema

- [ ] **T-04**. Add `origin`, `hostNodeId`, `virtualKind` to
      `packages/agent/src/entities/fleet-node.entity.ts` (after `kind`, L115) with doc comments
      naming the writer of each; class index `idx_fleet_nodes_host`.
      **Test**: `pnpm --filter @ever-works/agent build` clean; entity inventory spec
      `packages/agent/src/database/_entities-inventory.spec.ts` unchanged.
- [ ] **T-05**. Author `apps/api/src/migrations/1796160000000-AddFleetNodeVirtualFields.ts` from
      `apps/api/` (`pnpm typeorm migration:generate …`), hand-edit every `ADD COLUMN` to be guarded
      with `findColumnByName` (CONTRACTS R-35 — FL-17's slot may have added `origin` first), `down`
      per plan §4.2.
      **Test**: applies on an empty DB and on one with FL-17's migration already applied; a second
      `migration:generate` yields an empty diff.

## P1.C — Domain

- [ ] **T-06**. Add `packages/agent/src/fleet/virtual/fleet-virtual.policy.ts` — pure:
      `hostEligibility(node, systemId, childCount)`, `autoPickHost(hosts)`, `canHost(kind)`,
      `stopGraceSec(kind)`, limit 4, nesting and Windows-host refusals.
      **Test**: `packages/agent/src/fleet/virtual/__tests__/fleet-virtual.policy.spec.ts` — truth
      table over every `FleetVirtualHostReason`; auto-pick is by free memory, ties by name.
- [ ] **T-07**. Add `packages/agent/src/fleet/virtual/fleet-virtual.service.ts`: `options`, `create`
      (row first via `FleetService.createEnrollmentToken` extended with
      `{ origin, hostNodeId, virtualKind, organizationId: host.organizationId }`, then enqueue
      `vm-create` pinned to the host with `requiredCapabilities ['managed','docker'(+'kvm')]`
      through the node job-runtime plugin as `fleet-agent-task.dispatcher.ts` does), `power`,
      `destroy` (refuse `busy` on live Run/Session), `reissueEnrollmentToken`, `listChildren`.
      Kill switch via `FleetKillSwitchService`; audit via `FleetAuditService` with
      `family: 'machines'`.
      **Test**: `packages/agent/src/fleet/virtual/__tests__/fleet-virtual.service.spec.ts` — row
      exists before the job; token never in the payload; limit; kill switch; busy guards; audit
      rows carry no token.
- [ ] **T-08**. Add the delete guards to `FleetService.deleteForUser`
      (`packages/agent/src/fleet/fleet.service.ts`): host with children → `busy`; virtual child whose
      machine exists → `unsupported_on_node` with hint "destroy it instead" (the R-36 shape, spec
      FR-29); allowed again once the reconcile marks the child gone.
      **Test**: extend `packages/agent/src/fleet/__tests__/fleet.service.spec.ts`.
- [ ] **T-09**. Add `packages/agent/src/fleet/virtual/fleet-virtual.module.ts` and export the subpath
      from `packages/agent/src/fleet/index.ts`; register in `apps/api/src/fleet/fleet.module.ts`.
      **Test**: extend `apps/api/src/fleet/fleet.module.spec.ts` — the module constructs with a
      reduced graph (`@Optional()` audit).

## P1.D — API

- [ ] **T-10**. Add `apps/api/src/fleet/dto/fleet-virtual.dto.ts` (class-validator) and
      `apps/api/src/fleet/fleet-virtual.controller.ts` with every route in plan §5 (owner-facing),
      `FleetEnabledGuard` + `FLEET_VIRTUAL_ENABLED`, `@Throttle` tiers per route, CONTRACTS §8 error
      envelope with hints.
      **Test**: `apps/api/src/fleet/fleet-virtual.controller.spec.ts` — one case per status code in
      plan §5; `:id = auto` picks a host; reveal is 403 for an org admin.
- [ ] **T-11**. Add `apps/api/src/fleet/fleet-virtual-internal.controller.ts` —
      `POST /api/internal/fleet/virtual/:childId/enroll-token`, `@Public()` + `FleetNodeAuthGuard`,
      authorised through `FleetJobService.authorizeRunSecretRequest` (as
      `fleet-push-credential.service.ts:156-161`).
      **Test**: `apps/api/src/fleet/fleet-virtual-internal.controller.spec.ts` — host A cannot mint
      for host B's child (same 401); stale lease → 409; token never logged.
- [ ] **T-12**. Add `FLEET_VIRTUAL_ENABLED` to the API config (`apps/api/src/config/constants.ts`,
      beside the fleet flags) and to `apps/web/src/lib/fleet-flags.ts`.
      **Test**: extend the flags unit spec; route 404s when off.

## P1.E — Node

- [ ] **T-13**. Add `--token-file <path>` to `enroll` in `apps/node/src/cli/program.ts` (L1500):
      mutually exclusive with `--token`; reads, trims, deletes the file; refuses a file not owned by
      the current user or wider than 0600 on POSIX.
      **Test**: extend `apps/node/src/cli/program.spec.ts` — token read, file deleted, both flags →
      usage error (exit 2).
- [ ] **T-14**. Add `apps/node/src/core/link/modules/virtual/catalogue.ts`, `host-facts.ts`,
      `state.ts`, `docker-args.ts`, `password.ts` per plan §6.1 (all IO injected).
      **Test**: `catalogue.spec.ts` (digest present for every system; override honoured),
      `docker-args.spec.ts` (exact argv for a Container; no shell metacharacters pass; name
      validated), `password.spec.ts` (24 chars; keychain roundtrip via a fake `SecretStore`).
- [ ] **T-15**. Add `apps/node/src/core/link/modules/virtual/container-bootstrap.ts` — generates the
      bootstrap script (install Node 26, `npm i -g ever-works-node@<version>`, write the readiness
      marker, wait for the token file, `enroll --token-file`, `exec start --work --manage`).
      **Test**: `container-bootstrap.spec.ts` — the script never contains the token; it pins the
      host's runtime version; it writes the readiness marker before waiting.
- [ ] **T-16**. Add `apps/node/src/core/executors/vm-create.ts` (Container path): phases, `docker
      pull`/`run` via `apps/node/src/core/link/modules/docker/docker-cli.ts`, request the token through
      the internal endpoint only when the guest's readiness marker appears (R-35), write
      `<datadir>/run/enroll-token` 0600 and delete it host-side once `enroll` exits or the first
      heartbeat arrives, progress via FL-02 operations, cleanup on failure (`docker rm -f`, data dir).
      **Test**: `apps/node/src/core/executors/vm-create.spec.ts` — phase order; failure leaves no
      container; token requested once, after readiness; token file gone after enrolment; progress
      events ≤ 5 s apart with a fake clock.
- [ ] **T-17**. Add `apps/node/src/core/executors/vm-control.ts`: start / stop (`-t 10` Containers) /
      destroy (rm, data dir, keychain).
      **Test**: `vm-control.spec.ts` — stop grace per kind; destroy removes exactly the child's dir.
- [ ] **T-18**. Extend FL-02's `createManagementLane` (FL-02 T-27) in
      `apps/node/src/core/runtime.ts` (model: `createAttendedLane`, L1026-1070) per CONTRACTS R-34:
      add `vm-create`/`vm-control` to its kinds when `--manage` is on; register the executors only when
      `docker` is advertised; `excludeKinds` on the work lane; export from `apps/node/src/core/index.ts`.
      **Test**: extend `apps/node/src/core/runtime.spec.ts` — no `vm-*` kinds without `--manage`; lane
      runs without `--work`; the work lane never leases a management kind; one lane only.
- [ ] **T-19**. Add `apps/node/src/core/link/modules/virtual/index.ts` with the `vm.list` /
      `vm.status` handlers (C §3.3 `machine` family) and register it once in
      `apps/node/src/core/link/modules/index.ts` (CONTRACTS R-40).
      **Test**: `apps/node/src/core/link/modules/virtual/index.spec.ts` — replies carry container state
      and data-dir size, never a password; refused while `link.pause` holds.

## P1.F — Web

- [ ] **T-20**. Add `apps/web/src/components/fleet/virtual/virtual.shared.ts` (pure eligibility,
      auto-pick label, phase labels, size options per system); add **New virtual computer…** to FL-01's
      Add computer menu (`apps/web/src/components/fleet/FleetHubHeader.tsx`) and the child actions to
      FL-01's `computer/ComputerActionsMenu.tsx`, both behind `FLEET_VIRTUAL_ENABLED` (FL-01's registry
      has no entry point for menus — plan §8); nesting stays FL-01's `groupNodesByHost`.
      **Test**: `virtual.shared.unit.spec.ts` — every reason has a string key; Windows shows disk; the
      menu item is absent with the flag off.
- [ ] **T-21**. Add `NewVirtualComputerDialog.tsx`, `VirtualHostPicker.tsx`, `VirtualProgressLine.tsx`,
      `VirtualChildRow.tsx`, `VirtualRunsHereRows.tsx` (mounted inside FL-09's
      `apps/web/src/components/fleet/docker/RunsHereBlock.tsx`, no second block),
      `VirtualActionsMenu.tsx`, `DestroyVirtualDialog.tsx` under
      `apps/web/src/components/fleet/virtual/`; BFF routes under
      `apps/web/src/app/api/fleet/nodes/[id]/virtual/**` (plan §8). Confirmations render the 409
      `confirmation_required` preview and repeat the call with `confirm` / `confirmName`.
      **Test**: `NewVirtualComputerDialog.unit.spec.tsx` (Create disabled until valid; cost sentence
      present; preview → repeat with `confirm: true`), `VirtualRunsHereRows.unit.spec.tsx`.
- [ ] **T-22**. Palette entries in `apps/web/src/components/command-palette/registry/screens.ts`
      (beside L212) and `fleet.virtual.*` keys in `apps/web/messages/en.json` (spec §5.9; camelCase,
      no literal dots).
      **Test**: `grep -c '"[a-zA-Z]*\.[a-zA-Z]*":' apps/web/messages/en.json` unchanged; no literal
      user string under `components/fleet/virtual/`.

## P1.G — Tools, jobs, e2e

- [ ] **T-23**. Add `packages/agent/src/fleet/agent-fleet-virtual-tools.ts` (descriptor factory like
      `agent-fleet-tools.ts:32-80`) with the five tools and annotations of plan §9; append the
      routes to `apps/mcp/src/openapi-tools/whitelist.ts` (after L530) with the same names.
      **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-virtual-tools.spec.ts` — read-only
      tools carry `readOnly: true`; create's confirmation text names host, CPUs, memory, disk and "No
      credits are spent"; MCP whitelist spec lists the new names.
- [ ] **T-24**. Add `packages/tasks/src/tasks/trigger/fleet-virtual-reconcile.task.ts` (cron
      `4/5 * * * *`) and `FLEET_VIRTUAL_RECONCILE_DISPATCHER` in `packages/agent/src/fleet/virtual/`;
      register in `packages/tasks/src/tasks/trigger/index.ts` (beside L25).
      **Test**: `packages/tasks/src/__tests__/fleet-virtual-reconcile.task.spec.ts` — gone
      detection; 20-min enrol timeout; two overlapping ticks do one write.
- [ ] **T-25**. Add `apps/web/e2e/flow-fleet-virtual-computers.spec.ts` (fake host via the node
      contract fixture): menu enabled/disabled reasons; create → nested row → phases → online;
      destroy requires the typed name; host removal refused while it hosts children.
      **Test**: green locally and in CI on a cold DB.
- [ ] **T-26**. Docs for P1: `docs/features/fleet-virtual-computers.md` (Containers section), add to
      `apps/docs/sidebarsPlatform.ts` after `features/fleet` (L183); tracker row in
      `docs/specs/features/fleet/TRACKER.md`.
      **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.

---

# PHASE 2 — Windows VMs

- [ ] **T-27**. Add `apps/node/src/core/link/modules/virtual/kvm-probe.ts` and advertise `kvm` in
      `apps/node/src/core/capabilities.ts` (beside `docker`, L294): Linux x64 + R/W `/dev/kvm`.
      **Test**: extend `capabilities.spec.ts` — never on macOS/Windows/arm64; never without R/W access.
- [ ] **T-28**. Add `apps/node/src/core/link/modules/virtual/windows-oem.ts` — first-boot step (install Node 26 +
      the published runtime, set the generated account password, wait for the token file in the OEM
      share, `enroll --token-file`, start-at-boot via the `install-service.ps1` logic as the generated
      account); write `ready.txt` when the step begins so the host requests the token (late mint).
      **Test**: `windows-oem.spec.ts` — no token or password literal in the generated files; the
      runtime is never registered as a built-in account.
- [ ] **T-29**. Extend `vm-create.ts` with the Windows path: prechecks (`kvm`, ≥ 30 GB, x64 Linux),
      `--env-file` for the password (0600, removed after start), loopback viewer port registration
      with FL-10's port module (`apps/node/src/core/link/modules/ports/`), phases `downloading Windows · installing
      · first boot`, token request on `ready.txt`.
      **Test**: extend `vm-create.spec.ts` — each precheck message; viewer bound to `127.0.0.1`
      only; password never in argv (`--env-file` path only).
- [ ] **T-30**. Extend `vm-control.ts`: `docker stop -t 120` for VMs; destroy deletes the keychain
      entry; add the `vm.password.reveal` handler to `apps/node/src/core/link/modules/virtual/index.ts`
      reading the keychain once.
      **Test**: extend `vm-control.spec.ts` and `link/modules/virtual/index.spec.ts` — reveal returns
      the value once and logs nothing.
- [ ] **T-31**. API: `password/reveal` (owner-only by default — spec §8b; requires `confirm: true`,
      else 409 `confirmation_required`; 5/min; never cached — `Cache-Control: no-store`) and
      `retry-enrollment` routes in `fleet-virtual.controller.ts`; audit `node.vm.password.reveal`
      (CONTRACTS §7) with `extra.revealed: true`, never the value.
      **Test**: extend the controller spec — 403 for non-owners; 409 without `confirm`; audit row
      written; response body never appears in logs.
- [ ] **T-32**. Web: Windows systems in the dialog (disk field, download/install note, activation
      note), `RevealPasswordDialog.tsx` (60 s auto-hide), `Watch the install` button (opens the
      viewer port through FL-10's "open on the machine"), `not activated` chip.
      **Test**: `RevealPasswordDialog.unit.spec.tsx` — hides at 60 s; copy button present.
- [ ] **T-33**. Extend `flow-fleet-virtual-computers.spec.ts` with the Windows path against the fake
      host (prechecks, progress phases, reveal once, 120 s stop message); docs section "Windows VMs".
      **Test**: spec green; docs build clean.

---

# PHASE 3 — Resize, rebuild, CLI

- [ ] **T-34**. `PATCH …/virtual/:childId` (resize, stopped only) and `POST …/rebuild` in the
      controller/service; `vm-control` actions `resize` (`docker update --cpus --memory`) and `rebuild`
      (recreate the container keeping `home/`); both `confirm`-class (`confirm: true`); menu items;
      audit `node.vm.resize` / `node.vm.rebuild` (CONTRACTS §7).
      **Test**: controller + executor specs — resize refused `busy` while running; rebuild keeps
      `home/` and the registration.
- [ ] **T-35**. CLI `apps/cli/src/commands/fleet/virtual.ts` (`list|options|create|start|stop|destroy
      [--json]`, exit codes 0/1/2) under FL-19's `fleet` root.
      **Test**: `apps/cli/src/commands/fleet/__tests__/virtual.spec.ts` — `--json` shapes equal the
      API DTOs; a refused create exits 1 with the hint printed.
- [ ] **T-36**. Catalogue refresh: a node `doctor` line reporting catalogue digests vs the operator
      override; docs section "Updating images".
      **Test**: extend `apps/node/src/cli/program.spec.ts` (`doctor --json` carries `virtual.catalogue`).

---

# Docs & rollout

- [ ] **T-37**. Finish `docs/features/fleet-virtual-computers.md` (what a VM vs a Container is, what
      is needed on the host, passwords and activation, destroy semantics, limits); cross-link from
      `docs/features/fleet.md`; no plugin-count doc change (no plugin).
      **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-38**. Update `docs/specs/features/fleet/TRACKER.md` (spec `Reviewed` → impl states) and
      mark this folder's status lines.
      **Test**: the FL-16 TRACKER row shows `FLEET_VIRTUAL_ENABLED` and slot `1796160000000`.
- [ ] **T-39**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; run the banned-terms
      grep from the program brief over this folder and the code — it must print nothing.
      **Test**: every command exits 0 and the grep prints nothing.

## Definition of done

- All checkboxes ticked; every FR in spec §4 has a passing test named above.
- `FLEET_VIRTUAL_ENABLED=false` hides every route and menu item; `=true` passes the acceptance list
  in spec §9 on `develop`.
- No password, enrolment token or image credential appears in any job payload, log line, audit row
  or API response other than the one-time reveal.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Constitution gates in spec §10 confirmed.
