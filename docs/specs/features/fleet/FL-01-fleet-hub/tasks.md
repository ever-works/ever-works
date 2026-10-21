# FL-01 — Fleet hub & navigation · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-01-fleet-hub`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `In progress` — P1a merged (#2734), P1b merged (#2741); PR 3 roles in use (T-20, T-21, T-23, T-24, T-26)
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run everything with `pnpm` from the root.
- Runners: `packages/contracts`, `apps/node`, `apps/web` unit → **Vitest**; `packages/agent`,
  `apps/api` → **Jest**; `apps/web` e2e → **Playwright**.
- Migrations are authored from `apps/api/`; the API self-applies on boot. Re-stamp the slot if
  `develop` moved past it (README rule 10).
- Never remove or rename: moved components keep a re-export at their old path.
- Commit style: `feat(fleet): …`, `test(fleet): …`, `chore(i18n): …`.

---

## P1.A — Contracts, flags, routes

- [x] **T-01**. Add `fleet-access.types.ts` at `packages/contracts/src/fleet/fleet-access.types.ts`:
      `FLEET_ACTION_FAMILIES`, `FLEET_AUDIENCES`, `FleetControlPolicyFamilies`,
      `FLEET_CONTROL_POLICY_DEFAULTS`, `effectiveControlPolicy(node)`, `audienceIncludes(audience, role)`;
      export from `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-access.spec.ts` — null map, legacy value
      as `desktop`, partial map, 3×4 audience/role truth table.
- [x] **T-02** (parallel). Add `fleet-needs-a-look.types.ts` at
      `packages/contracts/src/fleet/fleet-needs-a-look.types.ts`: the kinds of CONTRACTS §4.6 (thirteen at revision 4),
      severity, the item shape exactly as §4.6 (no extra fields), `sortNeedsALook`. **Test**: `packages/contracts/src/fleet/__tests__/fleet-needs-a-look.spec.ts`.
- [x] **T-03**. Extend `FleetNodeView` in `packages/contracts/src/fleet/fleet-node.types.ts` (after
      `controlPolicy`, `:471`) with optional `isFavorite`, `hostNodeId`, `virtualKind`,
      `controlPolicyFamilies`, `viewerRole`. Add `'node.policy.change'` to `FleetAuditAction` and
      `FLEET_AUDIT_ACTIONS` in `packages/contracts/src/fleet/fleet-panic.types.ts`.
      **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts`; run
      `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` unchanged.
- [x] **T-04**. Add `isFleetHubEnabled()` to `apps/web/src/lib/fleet-flags.ts` (reads
      `FLEET_HUB_ENABLED === 'true'`; default off) and `config.fleet.isHubEnabled()` beside
      `getMinNodeVersion` in `packages/agent/src/config/`. Add the seven `DASHBOARD_FLEET*` constants
      to `apps/web/src/lib/constants.ts` beside `DASHBOARD_SETTINGS_FLEET` (`:339`).
      **Test**: `apps/web/src/lib/fleet-flags.unit.spec.ts` (new) — hub flag default off, on only with
      the literal `'true'`; extend `packages/agent/src/config/config.spec.ts`.

## P1.B — API: needs-a-look registry and widened reads

- [x] **T-05**. Create `packages/agent/src/fleet/needs-a-look/needs-a-look.producer.ts`
      (`NeedsALookProducer { id, produce(nodes): Promise<NeedsALookItem[]> }`, DI token
      `NEEDS_A_LOOK_PRODUCERS`) and `needs-a-look.service.ts` (`forNodes(nodes)`: fan-out, skip and
      log a throwing producer, sort). Register in `packages/agent/src/fleet/fleet.module.ts`; export
      from `packages/agent/src/fleet/index.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/needs-a-look.service.spec.ts`.
- [x] **T-06**. Add `GET /api/fleet/needs-a-look` and `GET /api/fleet/nodes/:id/needs-a-look` to
      `apps/api/src/fleet/fleet.controller.ts` (beside `GET nodes` `:267`), owner-scoped in P1.
      **Test**: extend `apps/api/src/fleet/fleet.controller.spec.ts` — empty registry → `[]`; one
      failing producer → partial result and a logged warning; foreign node id → 404.
- [x] **T-07**. Add `fleetAPI.needsALook()` / `nodeNeedsALook(id)` to `apps/web/src/lib/api/fleet.ts`
      and `fetchFleetNeedsALookAction` to `apps/web/src/app/actions/settings/fleet.ts` (where the fleet
      server actions live).
      **Test**: `apps/web/src/lib/api/fleet.unit.spec.ts` (new) — endpoint shapes.

## P1.C — Web: hub, overview, moved Computers tab

- [x] **T-08**. Create `apps/web/src/components/fleet/registry.ts` with `registerHubTab`,
      `registerComputerTab`, `registerOverviewBlock` (CONTRACTS §11.1), `getComputerTabs`, `resolvePlaceholder(entry, node)`
      and the twelve fixed tab ids in order.
      **Test**: `apps/web/src/components/fleet/registry.unit.spec.ts` — order, flag off, consent
      missing, kind cannot, not shipped.
- [x] **T-09**. Create `apps/web/src/components/fleet/fleet-hub.shared.ts` (card ordering,
      `groupNodesByHost`, state word, staleness).
      **Test**: `apps/web/src/components/fleet/fleet-hub.shared.unit.spec.ts`.
- [x] **T-10**. Create routes under `apps/web/src/app/[locale]/(dashboard)/fleet/`: `layout.tsx`
      (gate + `FleetHubTabs`), `page.tsx` (Overview, server-fetches nodes + needs-a-look + kill switch
      with `Promise.allSettled` like `settings/fleet/page.tsx`), `computers/page.tsx`,
      `sessions/page.tsx`, `checkouts/page.tsx`, `commands/page.tsx`, `usage/page.tsx` (placeholders
      from the registry). Components `FleetHubTabs.tsx`, `FleetHubHeader.tsx`,
      `overview/NeedsALookList.tsx`, `overview/ComputerCards.tsx`, `overview/FleetOverviewClient.tsx`
      under `apps/web/src/components/fleet/`.
      **Test**: `apps/web/src/components/fleet/overview/NeedsALookList.unit.spec.tsx`,
      `ComputerCards.unit.spec.tsx` (nesting, "—" cells).
- [x] **T-11**. Move `FleetEnrollHandoff.tsx`, `FleetQrCode.tsx`, `FleetNodeDrawer.tsx`,
      `fleet-node-drawer.shared.ts`, `fleet-node-limits.shared.ts` (+ their `.unit.spec` files) from
      `apps/web/src/components/settings/` to `apps/web/src/components/fleet/computers/`; leave
      `export * from '../fleet/computers/<name>'` at each old path. Extract the table block
      (`FleetSettings.tsx:488-`) into `apps/web/src/components/fleet/computers/FleetComputersTable.tsx`
      with the star column and **Open page**; `FleetSettings.tsx` renders the table when the hub flag
      is off and `FleetSettingsLinkCard.tsx` when on.
      **Test**: moved unit specs pass from the new location; `apps/web/e2e/flow-fleet-enrollment-contract.spec.ts`
      and `flow-fleet-panic-controls.spec.ts` green with the flag off and on.
- [x] **T-12**. Sidebar entry: insert Fleet between Teams (`DashboardSidebar.tsx:186-197`) and Memory
      (`:205-210`) with `matchPrefixes: [ROUTES.DASHBOARD_FLEET]`; thread `fleetHubEnabled` from
      `apps/web/src/app/[locale]/(dashboard)/layout.tsx` → `layout-client.tsx:521` →
      `DashboardSidebarProps` (`:68`). Runner pill: `RunnerStatusPill.tsx:262` targets
      `ROUTES.DASHBOARD_FLEET` when the prop is on.
      **Test**: `apps/web/src/components/dashboard/DashboardSidebar.unit.spec.tsx` (new) — entry
      present/absent, index = Teams index + 1; extend `apps/web/e2e/flow-fleet-runner-pill.spec.ts`.
      _As built:_ `DashboardSidebar.fleet.unit.spec.tsx` (new, beside the existing sidebar spec); the
      pill's Manage → hub in `apps/web/e2e/fleet-hub.spec.ts` (the existing pill spec is untouched).
- [x] **T-13**. Palette: add `fleet`, `fleet.computers`, `fleet.sessions`, `fleet.checkouts`,
      `fleet.commands`, `fleet.usage` screens to `apps/web/src/components/command-palette/registry/screens.ts`
      (after `teams` `:96`), gated on the hub flag the way `settings.fleet` is gated on fleet.
      **Test**: extend `apps/web/src/components/command-palette/registry/registry.unit.spec.ts`.
- [x] **T-14**. i18n: add the `fleet` namespace groups of plan §8.4 to `apps/web/messages/en.json`
      (only `en.json`; leaf keys camelCase, no literal `.`).
      **Test**: `grep -rn "fleet\.[a-z]*\.[A-Za-z]*\." apps/web/messages/en.json` finds no dotted leaf;
      no literal user string in `apps/web/src/components/fleet/**`.
- [x] **T-15**. Playwright `apps/web/e2e/flow-fleet-hub.spec.ts` — sidebar, six tabs, four
      placeholders naming their epics, card ordering, kill-switch banner, flag-off 404.
      **Test**: itself; green on a cold database.
      _As built:_ `apps/web/e2e/fleet-hub.spec.ts`. The kill-switch banner and note are covered by
      `components/fleet/hub/FleetHubFrame.unit.spec.tsx`, not the browser walk: stopping the fleet
      is platform-wide, and a walk that stops it would stop every e2e spec running beside it.

## P2.A — Roles, families, favourites (API + schema)

- [x] **T-16**. Entity: add `isFavorite` and `controlPolicyFamilies` to
      `packages/agent/src/entities/fleet-node.entity.ts` (after `controlPolicy` `:502`), with doc
      comments stating the legacy mirror rule.
      **Test**: `pnpm --filter @ever-works/agent build` clean.
- [x] **T-17**. Migrations from `apps/api/`: `apps/api/src/migrations/1796010000000-AddFleetNodeControlPolicyFamilies.ts`
      (add the column only — no backfill; a missing `desktop` key reads through to `controlPolicy`,
      CONTRACTS §2.1) and `apps/api/src/migrations/1796010100000-AddFleetNodeFavorite.ts`; per-step
      guards as in `1795161700000-AddFleetModelUsageLimits.ts`.
      **Test**: applies twice on sqlite and Postgres; `migration:generate` afterwards is empty; a row
      with `controlPolicy = 'org-admins'` and a null map yields `effectiveControlPolicy(node).desktop
=== 'org-admins'`; writing `families.desktop = 'owner'` writes `controlPolicy = 'owner'` back.
- [x] **T-18**. Create `packages/agent/src/fleet/fleet-access.service.ts` (`roleFor`, `assertFamily`,
      `canAct`) over `OrganizationMemberRepository`
      (`packages/agent/src/database/repositories/organization-member.repository.ts`); register and export
      from `fleet.module.ts` / `index.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/fleet-access.service.spec.ts` — five role cases;
      `view` denial is `not_found`; other families `permission_denied` with hint.
- [x] **T-19**. Widen reads: `FleetService.listVisibleForUser(userId)` in
      `packages/agent/src/fleet/fleet.service.ts` (beside `listForUser` `:958`), stamping `viewerRole`;
      `GET /nodes`, `GET /nodes/:id`, `/needs-a-look` in `fleet.controller.ts` use it and 404 strangers.
      **Test**: extend `fleet.controller.spec.ts` — member of bound org sees the node; member of another
      org gets `[]` / 404; runner pill's `listForUser` unchanged.
- [x] **T-20**. PATCH widening: `UpdateFleetNodeDto` (`apps/api/src/fleet/dto/fleet.dto.ts:97`) gains
      `isFavorite?`, `controlPolicyFamilies?` (custom validator), `DELETE /nodes/:id` gains an
      **optional** `confirmName` (existing callers without it keep working — Constitution X);
      `PATCH` routes `name/paused/disabled` through `assertFamily('machines')`, favourite/policy
      through owner check; policy write mirrors `controlPolicy = families.desktop` when `desktop`
      changes and audits `node.policy.change`.
      **Test**: extend `fleet.controller.spec.ts` — 403 non-owner favourite; invalid family key → 400;
      audit row `node.policy.change { family, from, to }`; wrong `confirmName` → `invalid`; no
      `confirmName` → 204 as today.
- [x] **T-21**. AW-11 compatibility: `packages/agent/src/computer/control-arbiter.service.ts:166,224,657`
      use `FleetAccessService.roleFor` and `effectiveControlPolicy(node).desktop`; keep
      `viewerRoleForNode` exported (deprecated comment) for callers outside the arbiter.
      **Test**: extend `packages/agent/src/computer/__tests__/control-policy.spec.ts` and the arbiter
      spec — owner-only node behaves as before; an org-admin on an `org-admins` desktop family can take
      control.

## P2.B — Computer page shell

- [x] **T-22**. Route `apps/web/src/app/[locale]/(dashboard)/fleet/computers/[id]/page.tsx` (server
      component; `?tab=` resolved like `activity/page.tsx:49-59`; 404 on `not_found`). Components
      `computer/ComputerPageShell.tsx`, `ComputerHeader.tsx`, `ComputerTabPlaceholder.tsx`,
      `tabs/OverviewTab.tsx` (slot layout), `tabs/SettingsTab.tsx` under `apps/web/src/components/fleet/`.
      Register `overview` and `settings` tabs in `registry.ts`.
      **Test**: `ComputerTabPlaceholder.unit.spec.tsx` (four variants, copyable `--manage` command);
      `ComputerHeader.unit.spec.tsx` (state word always present).
- [x] **T-23**. `computer/ComputerActionsMenu.tsx` — rename (inline), favourite (`setFavorite`),
      pause/resume (`updateNode { paused }`), drain (`drainFleetNodeAction`, confirm with job count),
      remove (typed name, `deleteNode` with `confirmName`); disabled-with-tooltip when the family
      excludes the viewer.
      **Test**: `ComputerActionsMenu.unit.spec.tsx` — gating by role, typed remove, no dialog for
      rename/favourite.
- [x] **T-24**. `computer/PolicyFamiliesEditor.tsx` mounted in `SettingsTab.tsx` with the drawer's
      capability / limits / cost / lifecycle sections reused from `fleet/computers/FleetNodeDrawer.tsx`.
      **Test**: `PolicyFamiliesEditor.unit.spec.tsx` — thirteen selects (CONTRACTS §2.1), defaults,
      `desktop` read through from legacy.
- [x] **T-25**. Favourite ordering in `ComputerCards.tsx` and `FleetComputersTable.tsx`; star column
      writes through `setFavorite`.
      **Test**: extend `fleet-hub.shared.unit.spec.ts` — favourites first, then online by last check.
- [x] **T-26**. Playwright `apps/web/e2e/flow-fleet-computer-page.spec.ts` (header, twelve tabs,
      placeholders, menu acts, favourite survives reload) and
      `apps/web/e2e/flow-fleet-roles-contract.spec.ts` (visibility by role; policy change audited).
      _As built:_ the roles walk covers the stranger (every read and act 404s), the
      `node.policy.change` rows and the typed name over HTTP; `org-admin` / `org-member` need a
      computer bound to an Organization, which nothing can do yet (OWNER-QUESTIONS A17) — they are
      pinned by `fleet-hub.controller.spec.ts`, `fleet-hub.service.spec.ts` and the arbiter spec.
      **Test**: itself.

## P3 — Polish and docs

- [ ] **T-27**. Palette section provider "Go to computer <name>" in
      `apps/web/src/components/command-palette/registry/sections.ts` (search over visible nodes).
      **Test**: extend `sections.unit.spec.ts`.
- [ ] **T-28**. Keyboard: `F` favourite, `?` sheet (`computer/ComputerShortcutSheet.tsx`), tab strips
      as `tablist` with arrow keys; `apps/web/e2e/flow-fleet-a11y.spec.ts` with an axe pass.
      **Test**: itself.
- [ ] **T-29**. State audit: every surface in spec §5 has empty / loading / unavailable / error
      variants from i18n keys; add missing keys.
      **Test**: `apps/web/src/components/fleet/__tests__/states.unit.spec.tsx` renders each variant.
- [ ] **T-30**. Docs: `docs/features/fleet-hub.md` (hub, computer page, who can do what); add to
      `apps/docs/sidebarsPlatform.ts` beside `'features/fleet'` (`:183`); cross-link from
      `docs/features/fleet.md` §"Managing nodes"; update `docs/specs/features/fleet/TRACKER.md` row
      FL-01.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
- [ ] **T-31**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; existing fleet and AW-11
      e2e specs green with `FLEET_HUB_ENABLED` on and off.

## Definition of done

- Every checkbox ticked; every test named above exists and passes locally and in CI.
- `FLEET_HUB_ENABLED=false` reproduces today's Settings → Fleet, sidebar, pill and palette exactly.
- No file under `docs/specs/features/fleet/FL-01-fleet-hub/` or the code names a third-party
  product (program rule 16); the banned-terms grep prints nothing.
- Spec §9 acceptance criteria all checked by a non-author; constitution gates in spec §10 confirmed.
