# FL-10 — Servers & ports · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> _(parallel)_ may run alongside the task immediately above them.

**Feature ID**: `FL-10-ports`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative; `pnpm` from the root. Runners: `packages/agent`, `apps/api`,
  `packages/tasks` → **Jest**; `apps/node`, `packages/contracts`, `apps/mcp`, `apps/web` unit →
  **Vitest**; `apps/web` e2e → **Playwright**.
- Prerequisites: FL-02 (link, modules, `NodeLinkService`, gateway, `consents`,
  `previewProfileEnabled` column), FL-07 (desktop hook `openUrl`, `screen:desktop`), FL-01 (tab /
  block registry, roles, computer Settings tab), FL-08 (`FleetMachineFactsEnabledGuard`), FL-09
  (container/process joins — optional).
- **P1 has no migration.** P2's migration is the reserved slot `1796100000000-CreateFleetPortTunnels`
  (CONTRACTS §13); re-stamp before merge if `develop` moved.
- Every URL the node touches is `http(s)://127.0.0.1:<port>/…` — a test in T-06 and T-13 pins it.
- Add new tasks at the bottom; never renumber. Commits: `feat(fleet-ports): …`, `test(fleet-ports): …`,
  `chore(i18n): …`.

---

# PHASE 1 — Discovery and open on the machine

## P1.A — Contracts

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-ports.types.ts` (kinds, `FleetListeningPort`,
      `FleetPortsList`, `FleetPortOpenTarget`, `FleetPortOpenResult`, `FleetPortTunnelView`,
      constants = CONTRACTS §10) and export from `packages/contracts/src/fleet/index.ts`; add
      `node.port.open`, `node.port.preview.open`, `node.port.preview.close` to
      `packages/contracts/src/fleet/fleet-panic.types.ts` and `FLEET_PORTS_CAPABILITY` to `fleet-jobs.types.ts`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-ports.types.spec.ts`; extend `fleet-panic.spec.ts`.
- [ ] **T-02**. Make sure FL-02's link contract file (`packages/contracts/src/fleet/fleet-link.types.ts`)
      carries CONTRACTS §3.3's `profile?: 'agent' | 'preview'` on the `desktop` channel-open params
      (default `agent`); add it there, additively, if FL-02 has not.
    - **Test**: FL-02's link contract spec gains a case: `profile: 'preview'` accepted, unknown refused.

## P1.B — Node module

- [ ] **T-03**. Write `apps/node/src/core/link/modules/ports/discover.ts` (`ss -tlnpH` with `-p`-less
      fallback, `lsof -nP -iTCP -sTCP:LISTEN -F pcnL`, PowerShell encoded `Get-NetTCPConnection` +
      `Get-Process` → JSON) and `classify.ts` (well-known table, Windows + Unix noise tables,
      `localOnly`, Microsoft-HTTPAPI detection). Tables are exported data.
    - **Test**: `discover.spec.ts` (fixtures per OS under `modules/ports/__fixtures__/`),
      `classify.spec.ts` (5357 noise; 127.0.0.1 local; HTTPAPI page is not web).
- [ ] **T-04**. Write `http-probe.ts` (loopback only; `GET /` `Accept: text/html`; 2 s; 64 KiB cap;
      https fallback with `rejectUnauthorized: false`; `<title>` ≤ 120 chars through `redactSecrets`;
      ≤ 32 concurrent) and `join.ts` (PID → program/cwd per OS; published port → container via FL-09's
      docker module when present).
    - **Test**: `http-probe.spec.ts` (timeout, cap, title, redaction, refuses non-loopback host),
      `join.spec.ts`.
- [ ] **T-05**. Write `watch-list.ts` (waiting ports probed each list) and `open-desktop.ts`
      (`target: 'desktop'` → FL-07 `desktopHooks.openUrl`; absent hook → `consent_missing` with
      `--attend` hint or `unsupported_on_node`).
    - **Test**: `watch-list.spec.ts`, `open-desktop.spec.ts`.
- [ ] **T-06**. Add `PreviewPageSource` (exported; `navigate(url)` restricted to `127.0.0.1`) to
      `apps/node/src/core/screen/headless-browser-backend.ts` without changing `BrowserPageSource`;
      write `apps/node/src/core/link/modules/ports/preview-browser.ts` (profile root
      `~/.ever-works/preview-profile` beside `agent-profiles`, lazy with the owner-only ACL from
      `apps/node/src/core/screen/agent-profile.ts`; one `PreviewBrowserSession` per node; capture pump
      + input injector reuse; 15 s leave grace; 60 min cap).
    - **Test**: `apps/node/src/core/screen/headless-browser-backend.spec.ts` (navigate refuses
      `http://example.com`), `modules/ports/preview-browser.spec.ts` (dir is a sibling of
      agent-profiles, never inside; busy; caps).
- [ ] **T-07**. Write `apps/node/src/core/link/modules/ports/index.ts` (`createPortsModule`; `ports.list`,
      `ports.open`; 2 s list cache; `ports` tag under `manage` when a discovery tool exists) and register
      it with one entry in FL-02's compile-time module array `apps/node/src/core/link/modules/index.ts`.
    - **Test**: `index.spec.ts` — refusal codes; no tag without a tool; preview open returns the
      channel id the platform opens `desktop` on.

## P1.C — Platform service and API

- [ ] **T-08**. Write `packages/agent/src/fleet/ports/fleet-ports.service.ts` (`list` with `view`;
      `open` with `ports` (+ `desktop` for the desktop target) → consent (`manage`; `attend` for
      desktop) → kill switch → `previewProfileEnabled` → link `ports.open` → for preview, open the
      `desktop` channel with `profile: 'preview'` and mint a `driver` attach token bound to the
      opener → audit `node.port.open`). Export from `packages/agent/src/fleet/index.ts`.
    - **Test**: `fleet/ports/__tests__/fleet-ports.service.spec.ts` — every §8 code; desktop target
      without `attend` names `attend`; preview disabled sentence; audit details hold port, target,
      program, no URL query.
- [ ] **T-09**. Write `apps/api/src/fleet/ports/fleet-ports.controller.ts` + `dto/fleet-ports.dto.ts`
      (GET list with `watch=`, POST open); register in `apps/api/src/fleet/fleet.module.ts`; guards
      `FleetEnabledGuard`, `FleetMachineFactsEnabledGuard`; throttles; Swagger.
    - **Test**: `fleet-ports.controller.spec.ts`; `apps/api/test/fleet-ports.e2e-spec.ts` (fake peer:
      two web ports first, others folded; open preview returns attach token).

## P1.D — Web

- [ ] **T-10**. Write `apps/web/src/components/fleet/ports/ports.shared.ts` (ordering, folding text,
      well-known names, time-left) and `use-ports-live.ts` (5 s polling only while visible; `watch`
      list in URL state).
    - **Test**: `ports.shared.unit.spec.ts`, `use-ports-live.unit.spec.tsx`.
- [ ] **T-11**. Write `PortsTab.tsx`, `PortRow.tsx`, `OtherPortsFold.tsx`, `SystemPortsFold.tsx`,
      `OpenPortField.tsx`, `OpenMenu.tsx` (disabled reasons for desktop / preview), `PreviewPane.tsx`
      (wraps `apps/web/src/components/computer/ComputerStage.tsx` via FL-07's attach hook; watermark;
      ends-in line), `ServersBlock.tsx`, `ports-tab.registry.ts` (tab through FL-01's
      `registerComputerTab` entry shape, Servers through `registerOverviewBlock`, palette in FL-01's
      `apps/web/src/components/command-palette/registry/sections.ts`) under
      `apps/web/src/components/fleet/ports/`; BFF routes `apps/web/src/app/api/fleet/nodes/[id]/ports/route.ts`
      and `.../ports/[port]/open/route.ts`. Every state in spec §5.5.
    - **Test**: `PortsTab.unit.spec.tsx`, `PreviewPane.unit.spec.tsx`, `ServersBlock.unit.spec.tsx`.
- [ ] **T-12**. Add the **Preview browser** switch (`previewProfileEnabled`) to the computer
      Settings tab (FL-01's `apps/web/src/components/fleet/settings/ComputerSettingsTab.tsx` or its
      merged name) with the sentence from plan §8, saving through `PATCH /api/fleet/nodes/:id`
      (`apps/api/src/fleet/fleet.controller.ts:501`, DTO extended additively).
    - **Test**: `fleet.controller.spec.ts` PATCH accepts the field; settings unit spec.

## P1.E — Tools, i18n, e2e

- [ ] **T-13**. Write `packages/agent/src/fleet/ports/agent-fleet-ports-tools.ts` (`fleet_ports_list`
      readOnly, `fleet_ports_open` destructive false audited as `agent:<id>`); concatenate beside
      `buildFleetTools`; MCP whitelist entries in `apps/mcp/src/openapi-tools/whitelist.ts`.
    - **Test**: `agent-fleet-ports-tools.spec.ts` (list writes no audit; open does; a non-loopback
      `url` argument is impossible by schema); whitelist spec.
- [ ] **T-14**. Add `fleet.ports.*`, `fleet.computer.tabs.ports` i18n keys to
      `apps/web/messages/en.json`; write `apps/web/e2e/flow-fleet-ports.spec.ts` and
      `flow-fleet-ports-contract.spec.ts` (fresh account, node enrolled via public protocol, FL-02 fake
      peer serving `ports.list` and a preview picture).
    - **Test**: the two specs; dotted-key grep unchanged.

# PHASE 2 — Preview tunnel (`FLEET_PORT_TUNNEL_ENABLED`)

## P2.A — Entity and migration

- [ ] **T-15**. Add `packages/agent/src/entities/fleet-port-tunnel.entity.ts` with exactly the
      CONTRACTS §4.9 columns (plan §4.1: `ownerUserId`, `nodeId`, `port`, `previewHost`, `state`,
      `openedAt`, `lastRequestAt`, `closedAt`, `closedReason`, `bytesIn`, `bytesOut`, `auditOpenId`,
      `auditCloseId`; plain varchar unions, `PortableDateColumn`, raw uuids, three indexes); register in
      `packages/agent/src/entities/index.ts` (fleet block `:166-179`) and
      `packages/agent/src/database/_entities-inventory.ts`; add `FleetPortTunnelRepository` at
      `packages/agent/src/fleet/ports/fleet-port-tunnel.repository.ts` with a CAS `close(id, reason)`.
    - **Test**: `packages/agent/src/entities/__tests__/fleet-port-tunnel.entity.spec.ts`;
      repository spec (CAS close returns false on a closed row).
- [ ] **T-16**. Author `apps/api/src/migrations/1796100000000-CreateFleetPortTunnels.ts` from
      `apps/api/` (`pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateFleetPortTunnels`),
      shaped like `1795161700000-AddFleetModelUsageLimits.ts` (portable `TableColumn`, per-step
      guards, `down` drops only what `up` added; runs on SQLite and Postgres — CONTRACTS §4 storage
      note). FKs `nodeId` (cascade), `ownerUserId`.
    - **Test**: applies on an empty and a populated DB; a second `migration:generate` yields an empty diff.

## P2.B — Node tunnel channel

- [ ] **T-17**. Write `apps/node/src/core/link/modules/ports/tunnel.ts` (`tunnel` channel handler:
      `tunnel.request` envelope + `DATA` + `END` → `http.request` to `127.0.0.1:<port>` → `tunnel.response`
      + streamed `DATA` + `END`; `ACK` credits both ways; 60 s per request; byte counters; refuses
      a port not listening with `channel.refused { code: 'not_found' }`); wire `ports.preview` accept in
      `modules/ports/index.ts`.
    - **Test**: `tunnel.spec.ts` — round trip against a local test server; large body streams under
      the credit window; timeout; non-loopback impossible; counters.

## P2.C — Platform tunnel service, preview host, sweeper

- [ ] **T-18**. Write `packages/agent/src/fleet/ports/fleet-port-tunnel.service.ts` (`open`: family
      `ports` → consent → kill switch → per-owner limit 4 → row → link `channel.open tunnel` → audit
      `node.port.preview.open` → stamp `auditOpenId`; `close(reason)` with `reason` ∈ §4.9's
      `idle · hard · user · node-offline · kill-switch`: CAS → link `CLOSE` → audit
      `node.port.preview.close` with the request count and the precise trigger (e.g. `drain`, link
      lost) → stamp `auditCloseId`; `authorizeRequest(tunnelId, userId)` against `ownerUserId`;
      `touch(tunnelId, bytes)`).
    - **Test**: `fleet-port-tunnel.service.spec.ts` — limit, owner mismatch, exactly two audit rows per
      tunnel, every §4.9 close reason reachable, drain and link loss stored as `node-offline`.
- [ ] **T-19**. Write `apps/api/src/fleet/ports/preview-host.middleware.ts` (mounted in
      `apps/api/src/main.ts` when `FLEET_PREVIEW_HOST` is set; exact `Host` match; `/p/:tunnelId/*` and
      sticky-cookie root-absolute routing; session cookie auth via the existing auth session store;
      `?t=` one-time hand-off fallback; strips `ew_*`/session cookies and `authorization`; forwards
      `Set-Cookie`; rewrites `Location` for the tunnelled origin; 401/403/404/502/504 pages from
      `apps/api/src/fleet/ports/pages/`), plus `fleet-port-tunnel-bridge.service.ts` (request ↔ link
      channel through FL-02's relay bus, replica-independent).
    - **Test**: `preview-host.middleware.spec.ts` (every branch), bridge spec; e2e
      `apps/api/test/fleet-ports.e2e-spec.ts` extended: a body served end to end through the fake peer.
- [ ] **T-20**. Add tunnel routes to `fleet-ports.controller.ts` (POST/GET/DELETE `/nodes/:id/ports/:port/preview`)
      behind `apps/api/src/fleet/guards/fleet-port-tunnel-enabled.guard.ts` (404 posture). FL-20's
      `GET /api/fleet/usage` is not changed by this epic; FL-20 adds a `tunnels` block from
      `FleetPortTunnelView` when it chooses (spec §8b).
    - **Test**: controller spec (404 with the flag off; `limit_exceeded` envelope).
- [ ] **T-21**. Write `packages/tasks/src/tasks/trigger/fleet-port-tunnel-sweeper.task.ts` (cron
      `1/1 * * * *`; `idle` / `hard` (`openedAt` + 60 min) / `node-offline` / `kill-switch` closes through the service's CAS);
      register where `fleet-job-lease-sweeper.task.ts` is registered (same `TriggerInternalModule`
      caveat); dispatch port `FLEET_PORT_TUNNEL_SWEEPER_DISPATCHER` in `packages/agent/src/fleet/ports/`.
    - **Test**: `packages/tasks/src/__tests__/fleet-port-tunnel-sweeper.task.spec.ts` — each reason;
      two overlapping ticks close once.

## P2.D — Web, tools, e2e

- [ ] **T-22**. Add **Preview in my browser** to `PortRow.tsx` (opens the returned `url` in a new tab),
      `TunnelRowState.tsx` (time left, requests, bytes, **Close preview**, **Copy link**, cloud egress
      line), limit dialog; BFF `.../ports/[port]/preview/route.ts`; `fleet.ports.tunnel.*` i18n;
      `isFleetPortTunnelEnabled()` in `apps/web/src/lib/fleet-flags.ts`.
    - **Test**: `TunnelRowState.unit.spec.tsx`; `PortsTab.unit.spec.tsx` button absent with flag off.
- [ ] **T-23**. Add `fleet_ports_preview_open` / `fleet_ports_preview_close` to
      `agent-fleet-ports-tools.ts` (mint for the Agent's **owner**; return `url` for a person) and the
      MCP whitelist; write `apps/web/e2e/flow-fleet-ports-tunnel.spec.ts` (tunnel serves a page; 403 for
      another signed-in user; signed-out redirect; close).
    - **Test**: tool spec; whitelist spec; e2e.

# PHASE 3 — WebSocket passthrough and watch

- [ ] **T-24**. Extend `tunnel.ts` and the bridge with `tunnel.ws-open` (node WS client to loopback;
      opcode-prefixed `DATA`; `END` closes; counts WebSocket upgrades into the close audit row (no
      column — CONTRACTS §4.9); an open socket counts as activity for
      the idle clock); preview host upgrade handling.
    - **Test**: `tunnel.spec.ts` ws round trip; middleware upgrade spec; e2e: a dev server's reload
      socket connects through the tunnel.
- [ ] **T-25**. Add **Watch** to `PortRow.tsx` / `OpenPortField.tsx`; when a watched listener
      disappears, show the inline notice and create an Inbox item through the existing Inbox service
      (`packages/agent/src/inbox/…`) with the sentence from spec FR-33.
    - **Test**: `PortsTab.unit.spec.tsx` notice; inbox service spec case.

## Docs and rollout

- [ ] **T-26**. Write `docs/features/fleet-ports.md` (what is listed and how it is ranked, the two
      ways **Open** works and why, the preview profile, the tunnel's limits and the preview hostname
      setup incl. the cookie-domain requirement and the hand-off fallback, Agent tools, what is never
      stored); add after FL-09's entry following `'features/fleet'` in `apps/docs/sidebarsPlatform.ts`
      (`:183`) and a row in `docs/features/index.md`.
    - **Test**: `pnpm --filter ever-works-docs build` — no broken links.
- [ ] **T-27**. Update [`../TRACKER.md`](../TRACKER.md) FL-10 row and the `Status` fields of the three
      documents; add the CONTRACTS §10 rows raised in spec §8b in the same PR (the §4.9 table, the
      `ports` family, R-17's fallback and §3.3's `profile` param already landed in CONTRACTS rev 2).
    - **Test**: docs build clean; the banned-terms grep over this folder prints nothing.
- [ ] **T-28**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`; run the banned-terms grep over
      this folder — it must print nothing.
    - **Test**: the four commands exit 0; the grep prints nothing.

## Definition of done

- All checkboxes ticked; ACC-FL10-01…15 green behind `FLEET_MACHINE_FACTS_ENABLED`, 16–22 behind
  `FLEET_PORT_TUNNEL_ENABLED`, on `develop`.
- Tests prove: the node never contacts a non-loopback address for probes, opens or tunnels; platform
  cookies never reach a tunnelled server; exactly two audit rows per tunnel.
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green; docs build clean.
- Constitution gates in `spec.md` §10 confirmed; TRACKER row updated; the entity matches CONTRACTS
  §4.9 column for column; the §10 rows from spec §8b filed.
