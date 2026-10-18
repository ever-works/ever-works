# FL-17 — Cloud computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Feature ID**: `FL-17-cloud-computers`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative; run with `pnpm` from the root. Runners: `packages/agent`, `apps/api`,
  `packages/tasks` **Jest**; `packages/plugin`, `packages/plugins/*`, `packages/contracts`,
  `apps/node`, `apps/web` unit **Vitest**; `apps/web` e2e **Playwright**.
- Migrations are authored from `apps/api/`; slot `1796170000000`; re-stamp only if `develop` moved.
- Prerequisites: FL-01 (registry, roles), FL-03 (health samples, needs-a-look producer registry),
  FL-02 (operations). FL-16's `enroll --token-file` is reused when landed; T-13 below ships it
  otherwise (identical text to FL-16 T-13 — land once).
- The provider's name appears only inside `packages/plugins/digitalocean-machines/`, its doc
  section and user copy; no core file names it (tested in T-09).
- Confirmation is the request fields `confirm` / `confirmName` with a 409 `confirmation_required`
  preview (CONTRACTS §2.2) — never a token. The Remove guard is CONTRACTS R-36.
- Commit style: `feat(fleet-cloud): …`, `feat(plugin-digitalocean-machines): …`, `chore(i18n): …`.

---

# PHASE 1 — Provider, create, power, destroy

## P1.A — Plugin contracts

- [ ] **T-01**. Add `packages/plugin/src/contracts/capabilities/machine-provider.interface.ts` (types
      and `IMachineProviderPlugin` per plan §4.3, `isMachineProviderPlugin`); export from
      `packages/plugin/src/contracts/capabilities/index.ts` (after L137).
      **Test**: `packages/plugin/src/contracts/__tests__/machine-provider.interface.spec.ts` — guard
      true only with the capability; types compile against a fake plugin.
- [ ] **T-02**. Append `MACHINE_PROVIDER: 'machine-provider'` **last** in
      `packages/plugin/src/contracts/facade-capabilities.ts` (after `DOMAIN_EVENT_SUBSCRIBER`, L150).
      **Test**: extend the capabilities spec — `isValidPluginCapability('machine-provider')`; the
      existing constants keep their positions.
- [ ] **T-03**. Append `'machine-provider'` **last** to `PLUGIN_CATEGORIES` in
      `packages/plugin/src/contracts/plugin-manifest.types.ts` (after `'identity'`, L127) **and in
      the same change** add `machine-provider: Cloud` to `CATEGORY_ICONS` and `'Machine Providers'`
      to `CATEGORY_LABELS` in `apps/web/src/lib/utils/plugin-category-icons.ts` (L39, L102).
      **Test**: extend `packages/plugin/src/contracts/__tests__/identity-provider.interface.spec.ts`
      (append-only pin) and `app-dependency-capability.spec.ts`; `pnpm --filter ever-works-web
      type-check` green (the `Record<PluginCategory,…>` assertions at L138-139).

## P1.B — Fleet contracts and schema

- [ ] **T-04**. Add `packages/contracts/src/fleet/fleet-cloud.types.ts` (plan §4.3) and export it from
      `packages/contracts/src/fleet/index.ts`; extend `fleet-node.types.ts` `FleetNodeView` with
      optional `origin`, `providerPluginId`, `cloud`; extend `fleet-panic.types.ts` with
      `node.cloud.create|power|destroy`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-cloud.spec.ts` (idle policy clamp
      1–72; name pattern); extend `fleet-panic.spec.ts`; the node contract fixture still validates.
- [ ] **T-05**. Add `origin` (owned by FL-16's slot; declared here too so either lands first — R-35), `providerPluginId`,
      `providerMachineRef`, `providerMeta` to `packages/agent/src/entities/fleet-node.entity.ts`
      (after `kind`, L115) with doc comments; partial unique index on `(providerPluginId,
      providerMachineRef)`.
      **Test**: `pnpm --filter @ever-works/agent build` clean; entities inventory spec unchanged.
- [ ] **T-06**. Author `apps/api/src/migrations/1796170000000-AddFleetNodeProviderFields.ts` from
      `apps/api/`; hand-edit every `ADD COLUMN` (incl. `origin`) to be guarded with `findColumnByName`
      (CONTRACTS R-35); `down` per plan §4.2.
      **Test**: applies on an empty DB and on one where FL-16's migration ran first; re-generate
      yields an empty diff.

## P1.C — Facade and plugin

- [ ] **T-07**. Add `packages/agent/src/facades/machine-provider.facade.ts`
      (`MachineProviderFacadeService extends BaseFacadeService`, methods per plan §7) and register it
      in `packages/agent/src/facades/facades.module.ts` + `facades/index.ts`.
      **Test**: `packages/agent/src/facades/__tests__/machine-provider.facade.spec.ts` — resolution
      against a fake plugin; `listProviders` reports `configured` from settings; usage recorded.
- [ ] **T-08**. Scaffold `packages/plugins/digitalocean-machines/` (`package.json` manifest per plan §7,
      `tsup.config.ts`, `vitest.config.ts`, `tsconfig.json`, `src/index.ts`, `README.md`); add to
      `pnpm-workspace.yaml` if globbing does not already include it.
      **Test**: `pnpm --filter @ever-works/digitalocean-machines-plugin build && test` green with an
      empty spec; the manifest validator spec in `packages/agent` accepts the block.
- [ ] **T-09**. Implement `src/digitalocean-machines.plugin.ts` and `src/digitalocean-api.ts`
      (options, create with tags + user-data + throwaway key, power, destroy idempotent, getMachine,
      listTagged, usage, `validateConnection`; `oauth` capability by getter when env set); add
      `src/testing/fake-digitalocean-api.ts`.
      **Test**: `src/__tests__/digitalocean-machines.plugin.spec.ts` and `digitalocean-api.spec.ts`
      per plan §14; plus a repo-level guard spec in
      `packages/agent/src/facades/__tests__/machine-provider.facade.spec.ts`:
      `grep -rn "digitalocean-machines" packages/agent apps --include=*.ts` returns only the
      MCP/CLI user-copy exceptions listed in the test.
- [ ] **T-10**. Add the plugin and the new category to `docs/plugin-system/built-in-plugins.md`
      (count 105 → 106 at L9; category table row; `## Machine Providers` section) — the only doc
      that carries counts (Constitution VIII).
      **Test**: `pnpm --filter ever-works-docs build` clean; no other doc's count edited (grep).

## P1.D — Domain and API

- [ ] **T-11**. Add `packages/agent/src/fleet/cloud/bootstrap-script.ts` (pure generator per plan §6;
      `--token-file`, drop-in `--work --manage`, pinned runtime, software presets, optional VPN
      join) and `throwaway-key.ts` (ed25519 in memory).
      **Test**: `packages/agent/src/fleet/cloud/__tests__/bootstrap-script.spec.ts` — token only in
      the 0600 `write_files` entry; no `--token` on argv; VPN key absent unless given; runtime pinned.
- [ ] **T-12**. Add `packages/agent/src/fleet/cloud/fleet-cloud.service.ts`: `listProviders`,
      `options` (10-min cache), `create` (row first via `FleetService.createEnrollmentToken` extended
      with `{ origin: 'cloud', providerPluginId, providerMeta }`; price verification; limit 10; kill
      switch; facade.create; tag; audit), `power`, `destroy` (busy guard; provider confirm; remove
      registration; final cost audit), `setIdlePolicy`, `usageSummary`, `markGone`; export
      `fleet-cloud.module.ts`; register in `apps/api/src/fleet/fleet.module.ts`.
      **Test**: `packages/agent/src/fleet/cloud/__tests__/fleet-cloud.service.spec.ts` — row exists
      before the provider call; a provider failure marks the row `failed`; price mismatch →
      `invalid`; kill switch matrix (create/on refused, off/destroy allowed); busy guard; audit rows
      carry prices, never tokens.
- [ ] **T-13**. Add `--token-file <path>` to `enroll` in `apps/node/src/cli/program.ts` (L1500) if FL-16
      has not landed it (same semantics: exclusive with `--token`, 0600 check, delete after read).
      **Test**: extend `apps/node/src/cli/program.spec.ts`.
- [ ] **T-14**. Add the Remove guard to `FleetService.deleteForUser`
      (`packages/agent/src/fleet/fleet.service.ts`): cloud origin with a live machine ref and
      `powerState !== 'gone'` → `unsupported_on_node` with the destroy hint.
      **Test**: extend `packages/agent/src/fleet/__tests__/fleet.service.spec.ts` and
      `apps/api/src/fleet/fleet.controller.spec.ts` (422 with hint; allowed for `gone` and for
      failed-before-create rows).
- [ ] **T-15**. Add `apps/api/src/fleet/dto/fleet-cloud.dto.ts` and
      `apps/api/src/fleet/fleet-cloud.controller.ts` with every route in plan §5 (P1 subset: providers,
      options, cloud list, create, get, power, destroy, retry-enrollment), `FleetEnabledGuard` +
      `FLEET_CLOUD_ENABLED`, `@Throttle` tiers, CONTRACTS §8 envelope; add the flag to
      `apps/api/src/config/constants.ts` and `apps/web/src/lib/fleet-flags.ts`.
      **Test**: `apps/api/src/fleet/fleet-cloud.controller.spec.ts` — one case per status in plan §5;
      `vpnAuthKey` never echoed; routes 404 when the flag is off.

## P1.E — Web

- [ ] **T-16**. Add `apps/web/src/components/fleet/cloud/cloud.shared.ts` (pure: price formatting,
      Create label, remove availability by origin/state, idle labels) and register the
      Cloud block with `registerOverviewBlock` in `apps/web/src/components/fleet/registry.ts`; add **New
      cloud computer…** to FL-01's `apps/web/src/components/fleet/FleetHubHeader.tsx` menu and the cloud
      actions (Remove disabled with the reason) to FL-01's `computer/ComputerActionsMenu.tsx`, behind
      `FLEET_CLOUD_ENABLED` (plan §8).
      **Test**: `cloud.shared.unit.spec.ts` — Remove disabled with the reason for cloud+running, enabled for
      gone and failed-before-create.
- [ ] **T-17**. Add `NewCloudComputerDialog.tsx`, `CloudProviderPicker.tsx`, `CloudSizeRadioGroup.tsx`,
      `CloudPriceSentence.tsx`, `CloudBlock.tsx`, `CloudPowerDialog.tsx`, `DestroyCloudDialog.tsx`
      under `apps/web/src/components/fleet/cloud/`; BFF routes under
      `apps/web/src/app/api/fleet/{providers,cloud}/**` (plan §8); disable Remove in
      FL-01's moved `FleetComputersTable.tsx` and `FleetNodeDrawer.tsx` (`apps/web/src/components/fleet/computers/`)
      for cloud rows with the explanatory line. Dialogs render the 409 `confirmation_required` preview
      and repeat with `confirm` / `confirmName`.
      **Test**: `NewCloudComputerDialog.unit.spec.tsx` (price sentence present; Create carries the
      price; stale-price state), `CloudBlock.unit.spec.tsx`, `DestroyCloudDialog.unit.spec.tsx`
      (cost so far rendered).
- [ ] **T-18**. Palette entries (`apps/web/src/components/command-palette/registry/screens.ts`,
      beside L212) and `fleet.cloud.*` keys in `apps/web/messages/en.json` (spec §5.8; camelCase, no
      literal dots).
      **Test**: dotted-key grep count unchanged; no literal user string under `components/fleet/cloud/`.

## P1.F — Jobs, tools, e2e, docs

- [ ] **T-19**. Add `packages/tasks/src/tasks/trigger/fleet-cloud-bootstrap-watch.task.ts` (every
      minute; `enrolling` cloud rows > 10 min → needs-a-look item with hourly cost) and
      `fleet-cloud-reconcile.task.ts` (hourly; `getMachine` → `gone`); dispatchers in
      `packages/agent/src/fleet/cloud/`; register in `packages/tasks/src/tasks/trigger/index.ts`
      (beside L25). Register the `cloud-idle` producer (title/detail carry the never-online variant —
      CONTRACTS §4.6 has one cloud kind) with FL-01's needs-a-look producer registry.
      **Test**: `packages/tasks/src/__tests__/fleet-cloud-bootstrap-watch.task.spec.ts`,
      `fleet-cloud-reconcile.task.spec.ts` — gone stops accrual; items deduped.
- [ ] **T-20**. Add `packages/agent/src/fleet/agent-fleet-cloud-tools.ts` (P1 tools: list, options,
      create, power, destroy with annotations per plan §9) and MCP whitelist entries in
      `apps/mcp/src/openapi-tools/whitelist.ts` (after L530).
      **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-cloud-tools.spec.ts` — create
      requires `acknowledgedPriceCents`, confirmation text states size and price; read-only flags.
- [ ] **T-21**. Add `apps/web/e2e/flow-fleet-cloud-computers.spec.ts` (fake provider API + node
      contract fixture): empty state without a provider; create → row → online; power off copy;
      destroy shows cost and requires the name; Remove disabled with the reason.
      **Test**: green locally and in CI on a cold DB.
- [ ] **T-22**. Docs: `docs/features/fleet-cloud-computers.md` (P1 sections), sidebar entry in
      `apps/docs/sidebarsPlatform.ts` after `features/fleet` (L183); tracker row.
      **Test**: docs build clean.

---

# PHASE 2 — Cost and idle

- [ ] **T-23**. Add `packages/agent/src/fleet/cloud/cost-model.ts` (pure: per-second accrual from
      `powerTimeline`, monthly cap, MTD incl. destroyed, projection) and
      `packages/tasks/src/tasks/trigger/fleet-cloud-usage.task.ts` (every 10 min).
      **Test**: `cost-model.spec.ts` (table of lifetimes × rates; cap; month boundary; destroyed
      counted); task spec (CAS on `computedAt`).
- [ ] **T-24**. Add `idle-policy.ts` (pure: idle over window from samples, sessions, jobs; off/enrolling
      never idle) and `fleet-cloud-idle.task.ts` (every 10 min, offset 5): `tell-me` → one `cloud-idle`
      item + Inbox item per window; `power-off` → `facade.power(off)` + audit `node.cloud.power`
      (`requestedBy: system:idle-policy`, CONTRACTS §2.3) + item; the policy change itself audits
      `node.policy.change`.
      **Test**: `idle-policy.spec.ts` truth table; `fleet-cloud-idle.task.spec.ts` — exactly one item
      per window; never destroys.
- [ ] **T-25**. API: `GET /cloud/:id/usage`, `PUT /cloud/:id/idle-policy`; `FleetCloudService.usageSummary`
      wired into FL-20's `GET /api/fleet/usage` composer.
      **Test**: extend the controller spec; usage summary excludes Budgets (FR-24).
- [ ] **T-26**. Web: `IdlePolicyEditor.tsx` (computer Settings tab contribution), `CloudUsageBlock.tsx`
      (Usage tab contribution), needs-a-look item actions (Power off / Keep running / Power on /
      Destroy…).
      **Test**: `IdlePolicyEditor.unit.spec.tsx` (clamp; default tell-me 3 h), `CloudUsageBlock.unit.spec.tsx`.
- [ ] **T-27**. Tools: `fleet_cloud_usage` (readOnly), `fleet_cloud_idle_policy`; extend MCP whitelist
      and the tools spec. Extend the e2e spec with the policy save and the Usage block.
      **Test**: tool annotations; e2e green.

---

# PHASE 3 — Sign-in, presets, reconciliation, CLI

- [ ] **T-28**. OAuth: implement `IOAuthPlugin` members in the plugin (env-gated capability getter as
      `vercel.plugin.ts:72-74`), admin-scope `oauthClientId/Secret` settings with `x-envVar`; the
      dialog shows **Sign in with the provider** via the existing `connectOAuthProvider` action
      (`apps/web/src/app/actions/dashboard/oauth.ts`) when `oauthAvailable`.
      **Test**: plugin spec — capability absent without env; facade spec — account label from the
      OAuth user.
- [ ] **T-29**. VPN preset: `vpnAuthKey` accepted at create, passed into the bootstrap only, excluded
      from responses/logs; dialog field shown only when the preset is ticked.
      **Test**: bootstrap spec; controller spec (`vpnAuthKey` never echoed, never audited).
- [ ] **T-30**. Reconcile P3: `listTagged('ever-works')` → unclaimed machines → needs-a-look item with
      Destroy; repair rows missing `providerMachineRef`.
      **Test**: extend `fleet-cloud-reconcile.task.spec.ts`.
- [ ] **T-31**. CLI `apps/cli/src/commands/fleet/cloud.ts` under FL-19's `fleet` root
      (`providers|options|list|create|power|destroy|usage|idle-policy [--json]`; exit 0/1/2).
      **Test**: `apps/cli/src/commands/fleet/__tests__/cloud.spec.ts` — `create` without
      `--acknowledge-price` exits 2; `--json` shapes equal the DTOs.
- [ ] **T-32**. Write `docs/plugin-system/creating-machine-provider-plugin.md` (contract review for a
      second provider; what `billsWhileOff` and `usage` mean) and link it from the Machine Providers
      section.
      **Test**: docs build clean.

---

# Docs & rollout

- [ ] **T-33**. Finish `docs/features/fleet-cloud-computers.md` (price statement, what is installed,
      power/destroy semantics, why Remove is refused while the machine exists (R-36), idle policy,
      estimates disclaimer).
      **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-34**. Update `docs/specs/features/fleet/TRACKER.md`; plugin count stays in
      `docs/plugin-system/built-in-plugins.md` only.
      **Test**: the FL-17 TRACKER row shows `FLEET_CLOUD_ENABLED` and slot `1796170000000`; no other doc's plugin count changed (grep).
- [ ] **T-35**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; banned-terms grep over
      this folder, the plugin and the docs prints nothing.
      **Test**: every command exits 0 and the grep prints nothing.

## Definition of done

- All checkboxes ticked; every FR in spec §4 has a passing test named above.
- `FLEET_CLOUD_ENABLED=false` hides every route and menu item; `=true` passes spec §9 on `develop`.
- No provider token, enrolment token, VPN key or machine credential appears in any API response
  after save, log line or audit row; the platform holds no key for any machine it created.
- The plugin is counted once, in the canonical plugin document; no core file names its id.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings; spec §10 gates confirmed.
