# FL-08 — Logs · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> _(parallel)_ may run alongside the task immediately above them.

**Feature ID**: `FL-08-logs`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root. Run everything with `pnpm` from the root.
- Runners: `packages/agent` and `apps/api` use **Jest**; `apps/node`, `packages/contracts`,
  `apps/mcp`, `apps/web` unit use **Vitest**; `apps/web` e2e uses **Playwright**.
- Prerequisites from sibling epics: FL-02's node link client, module contract, `NodeLinkService`
  and `/ws/fleet/<family>/<id>` gateway; FL-01's `registerComputerTab` / role derivation. Where a
  name below belongs to them, adapt it to the merged name in one place.
- No migration in this epic (CONTRACTS §13 has no FL-08 slot). A task that seems to need one is
  wrong — stop and re-read plan §4.
- Add new tasks at the bottom; never renumber. Commit style: `feat(fleet-logs): …`,
  `test(fleet-logs): …`, `chore(i18n): …`.

---

## P1.A — Contracts

- [ ] **T-01**. Add the logs contract at `packages/contracts/src/fleet/fleet-logs.types.ts` (kinds,
      `FleetLogSource`, `FleetLogLine`, `FleetLogsOpenParams`, the four constants, `classifyLogLevel`)
      and export it from `packages/contracts/src/fleet/index.ts`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-logs.types.spec.ts` — guards for every
      union, constants equal CONTRACTS §10 (500, 1 MiB/s), `classifyLogLevel` truth table incl.
      "errors: 0" → `info`.
- [ ] **T-02**. Add `node.logs.read` and `node.logs.follow` to `FleetAuditAction` /
      `FLEET_AUDIT_ACTIONS` at `packages/contracts/src/fleet/fleet-panic.types.ts` (after the
      `computer.*` block, in CONTRACTS §7 order); add `FLEET_LOGS_CAPABILITY = 'logs'` beside
      `FLEET_ATTENDED_CAPABILITY` in `packages/contracts/src/fleet/fleet-jobs.types.ts`.
    - **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts` (both members
      round-trip the guard) and the jobs spec (tag constant exported).

## P1.B — Node module

- [ ] **T-03**. Write the roots resolver at `apps/node/src/core/link/allowed-roots.ts`:
      `resolveAllowedRoots({ checkouts, workspaceRoot, extraRoots })`, `isUnderAllowedRoot(path)`
      with `realpath` canonicalisation and win32 case folding, following the lookup rule in
      `apps/node/src/core/executors/command-roots.ts`. Export a `standardLogDirs(platform, env)`.
    - **Test**: `apps/node/src/core/link/allowed-roots.spec.ts` — symlink escape refused,
      `..` refused, sibling-root cousin refused, win32 case, standard dirs per OS.
- [ ] **T-04**. Write the four readers under `apps/node/src/core/link/modules/logs/`:
      `journal-source.ts` (JSON, `__CURSOR` resume, kernel, user units, group-membership hint
      detection), `unified-log-source.ts` (ndjson show/stream), `event-log-source.ts` (encoded
      command, `RecordId` polling, Security → `needs-admin`), `file-source.ts` (backward scan ≤ 8 MiB
      for 500 lines, follow with rotation/truncation detection, `earlier`). All children through the
      injected `CommandRunner`/spawn seam with `buildNodeCheckEnv`.
    - **Test**: one spec per reader in the same folder with fixture output under
      `apps/node/src/core/link/modules/logs/__fixtures__/`; rotation, truncation, CRLF, hint detection,
      Security refusal.
- [ ] **T-05** _(parallel)_. Write `container-source.ts` (`docker logs --tail --timestamps -f`,
      `gone` on exit) and `service-source.ts` (service → reader mapping per OS; Homebrew log path,
      launchd Standard\*Path, Windows ProviderName) in `apps/node/src/core/link/modules/logs/`.
    - **Test**: `container-source.spec.ts`, `service-source.spec.ts` — argv never passes through a
      shell string; names validated by pattern.
- [ ] **T-06**. Write `apps/node/src/core/link/modules/logs/log-sources.ts` (`listSources()` → four
      groups, newest-first files, 200 per root, unreadable markers with hints) and
      `line-classifier.ts`.
    - **Test**: `log-sources.spec.ts` — per-OS fixtures; `root-only` marked; home never listed.
- [ ] **T-07**. Write `apps/node/src/core/link/modules/logs/log-channel.ts`: initial batch, per-line
      `redactSecrets`, NDJSON `DATA` ≤ 64 KiB, `ACK` window 1 MiB, 1 MiB/s token bucket,
      oldest-drop with counter, `logs.pause|resume|follow|earlier`, notices, kill within 3 s on close.
    - **Test**: `log-channel.spec.ts` — bucket at ±1 ms, window never exceeded, drop count, redaction
      count, pause buffer bound.
- [ ] **T-08**. Write `apps/node/src/core/link/modules/logs/index.ts` (`createLogsModule`) and register
      it in FL-02's compile-time module array `apps/node/src/core/link/modules/index.ts` (one
      entry); advertise `logs` only when `consents.manage` and a readable source kind exists.
      Answer `logs.sources` on the `machine` channel (the §3.3 addition raised in spec §8b (a)).
    - **Test**: `apps/node/src/core/link/modules/logs/index.spec.ts` — no tag without `manage`; refusal
      codes for a bad source id, outside-roots path, kill switch.

## P1.C — Platform service and API

- [ ] **T-09**. Write `packages/agent/src/fleet/logs/fleet-logs.service.ts`: `listSources`,
      `openChannel` (consent → family `logs` (CONTRACTS §2.1, default `owner`) → kill switch →
      per-viewer channel cap 8 → `NodeLinkService.openChannel` → audit `node.logs.read` [+ `follow`]),
      `readOnce`. Refusals are typed values with `code`/`hint`; export from
      `packages/agent/src/fleet/index.ts`.
    - **Test**: `packages/agent/src/fleet/logs/__tests__/fleet-logs.service.spec.ts` — every §8 code
      reachable; audit `details` contains no line text and no key matching `REDACTED_KEY_RE`.
- [ ] **T-10**. Write `apps/api/src/fleet/logs/fleet-logs.controller.ts`, DTOs at
      `apps/api/src/fleet/logs/dto/fleet-logs.dto.ts`, guard
      `apps/api/src/fleet/guards/fleet-machine-facts-enabled.guard.ts` (404 like
      `fleet-enabled.guard.ts`); register in `apps/api/src/fleet/fleet.module.ts`. Routes per plan §5
      with `@Throttle` tiers and Swagger decorators.
    - **Test**: `apps/api/src/fleet/logs/fleet-logs.controller.spec.ts`; e2e
      `apps/api/test/fleet-logs.e2e-spec.ts` with FL-02's fake link peer.
- [ ] **T-11**. Register the `logs` family with FL-02's gateway (allowed inbound JSON types,
      `ACK` forwarding, `viewer` role only) in `apps/api/src/fleet/logs/fleet-logs.gateway-family.ts`.
    - **Test**: `fleet-logs.gateway-family.spec.ts` — a `session.input` frame on a logs channel is
      refused; `ACK` reaches the node side.

## P1.D — Web

- [ ] **T-12**. Write `apps/web/src/components/fleet/logs/logs.shared.ts` (pure: filter, follow
      state machine, footer strings, formatting) and `use-log-follow.ts` (attach token → socket →
      auth frame → `ACK` on consume → resume on reconnect), mirroring
      `apps/web/src/components/computer/use-computer-attach.ts`.
    - **Test**: `logs.shared.unit.spec.ts`, `use-log-follow.unit.spec.tsx`.
- [ ] **T-13**. Write the components `LogsTab.tsx`, `LogSourceTree.tsx`, `LogViewer.tsx`
      (windowed list ≤ 5 000, scroll-up stops follow, selection), `LogViewerToolbar.tsx`,
      `LogViewerFooter.tsx`, `LogOpenPathField.tsx` under `apps/web/src/components/fleet/logs/`,
      with every state in spec §5 (loading, empty, offline, consent, permission, desktop node,
      kill switch, error).
    - **Test**: `LogsTab.unit.spec.tsx`, `LogViewer.unit.spec.tsx`.
- [ ] **T-14**. Add BFF routes `apps/web/src/app/api/fleet/nodes/[id]/logs/sources/route.ts` and
      `.../logs/attach-token/route.ts` (thin proxies per `apps/web/src/lib/api/computer-bff.ts`).
    - **Test**: covered by `flow-fleet-logs-contract.spec.ts` (T-17).
- [ ] **T-15**. Register the tab in `apps/web/src/components/fleet/logs/logs-tab.registry.ts`
      through FL-01's registry (`apps/web/src/components/fleet/registry.ts`, entry shape `{ id, labelKey, order, epic, flag, consent, load }`), gated by `FLEET_MACHINE_FACTS_ENABLED` read in
      `apps/web/src/lib/fleet-flags.ts` (add `isFleetMachineFactsEnabled()`); add the "Logs on
      <computer>" entries to FL-01's per-computer dynamic palette section in
      `apps/web/src/components/command-palette/registry/sections.ts`.
    - **Test**: `logs-tab.registry.unit.spec.ts` — absent with the flag off; palette entry per node.

## P1.E — Tools, i18n, e2e

- [ ] **T-16**. Add `packages/agent/src/fleet/logs/agent-fleet-logs-tools.ts`
      (`fleet_logs_sources`, `fleet_logs_read`, `readOnly: true`, ≤ 500, follow refused) and
      concatenate it where `buildFleetTools` is assembled; add the two MCP whitelist entries in
      `apps/mcp/src/openapi-tools/whitelist.ts` (fleet block) with `readOnlyHint` and
      `omitArgs: ['follow']`.
    - **Test**: `packages/agent/src/fleet/logs/__tests__/agent-fleet-logs-tools.spec.ts`;
      `apps/mcp` whitelist spec.
- [ ] **T-17**. Add the `fleet.logs.*`, `fleet.computer.tabs.logs` and shared `fleet.errors.*` keys
      to `apps/web/messages/en.json` (camelCase leaves, no literal `.`); write
      `apps/web/e2e/flow-fleet-logs.spec.ts` and `apps/web/e2e/flow-fleet-logs-contract.spec.ts`
      following `flow-fleet-runner-pill.spec.ts` (fresh account, node enrolled via the public
      protocol, FL-02 fake link peer for sources/lines).
    - **Test**: the two specs; `grep -c '"[a-zA-Z]*\.[a-zA-Z]*":' apps/web/messages/en.json` unchanged.

## P2 — Merged view, earlier, hand-offs

- [ ] **T-18**. Extend `log-channel.ts` and `fleet-logs.types.ts` for `sources[]` (≤ 12): per-source
      reader, timestamp merge, `src` index on each line; add `LogSourceChip.tsx` and the merged header
      to `LogViewer.tsx`.
    - **Test**: `log-channel.merge.spec.ts` (order by `ts`, late source joins, one gone),
      `LogViewer.unit.spec.tsx` chips.
- [ ] **T-19**. Implement `logs.earlier` end to end (journal cursor, event `RecordId`, file backward
      scan; containers answer `hasMore: false`) and **Load 500 earlier** in `LogViewerToolbar.tsx`.
    - **Test**: reader specs for `earlier`; `LogViewer.unit.spec.tsx` prepend keeps scroll position.
- [ ] **T-20**. Export `openLogsForSource(nodeId, sourceId)` and `openMergedLogs(nodeId, sourceIds)`
      from `apps/web/src/components/fleet/logs/logs-tab.registry.ts` for FL-09's **Open log** rows and
      Compose **Logs** entry (deep link `?tab=logs&source=…`).
    - **Test**: `logs-tab.registry.unit.spec.ts` deep-link parsing; FL-09's spec exercises the call.

## P3 — Deep links and snapshots

- [ ] **T-21**. **Open the log** at the failure time from the Services tab's failed rows (deep link
      `/fleet/computers/:id?tab=logs&source=service:<unit>&at=<iso>`), and honour `at=` in
      `LogsTab.tsx` (position the viewer, highlight the first line at/after `at`). No "needs a look"
      producer is added: CONTRACTS §4.6 has no kind for a failed service (spec §8b (c)); when one is
      added, the same route becomes that item's `action`.
    - **Test**: `LogsTab.unit.spec.tsx` `at=` positioning; deep-link parsing in
      `logs-tab.registry.unit.spec.ts`.
- [ ] **T-22**. Add **Download shown lines** to `LogViewerToolbar.tsx` (browser-side Blob of the
      filtered held lines, `<computer>-<source>-<time>.log`).
    - **Test**: `LogViewerToolbar.unit.spec.tsx` — file content equals the filtered lines only.

## Docs and rollout

- [ ] **T-23**. Write `docs/features/fleet-logs.md` (sources per OS, the viewer, the group-membership
      and root-only rules, Agent tool, what is never stored); add it to `apps/docs/sidebarsPlatform.ts`
      directly after `'features/fleet'` (`:183`) and a row to `docs/features/index.md` beside Fleet
      (`:84`).
    - **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
- [ ] **T-24**. Update [`../TRACKER.md`](../TRACKER.md) FL-08 row (spec → Reviewed/Approved, impl →
      PR open/Merged) and set this epic's `Status` fields; add the CONTRACTS §3.3 and §10 entries
      raised in spec §8b in the same PR.
    - **Test**: docs build clean; the banned-terms grep over this folder prints nothing.
- [ ] **T-25**. Run `pnpm format && pnpm lint && pnpm test && pnpm build` and confirm green; run the
      banned-terms grep from the program brief over this folder — it must print nothing.
    - **Test**: the four commands exit 0; the grep prints nothing.

## Definition of done

- All checkboxes ticked; ACC-FL08-01…20 green on `develop` behind `FLEET_MACHINE_FACTS_ENABLED`.
- No log line is stored on the platform (verified by the service spec and the e2e contract spec).
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green; docs build without broken links.
- Constitution gates in `spec.md` §10 confirmed; TRACKER row updated.
