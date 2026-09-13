# Task Breakdown: Costs, caps and credits

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one pull
> request and ships with tests per **Constitution VI**. Every schema task ships its migration in
> the **same** pull request per **Constitution V**.

**Epic ID**: `AW-17-costs-caps`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to guess
  a path.
- "Done when" is stated explicitly for every task and is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each
  phase.
- Prerequisite: **AW-09 P2 is merged.** T31 and T32 write into the receipt cost block it creates.

---

# Phase P1 — Separate the meters

*Delivers spec FR-1…FR-34, FR-65…FR-74, FR-79…FR-88. Ships no new cap; after P1 the product tells
the truth about money without stopping anything new.*

## P1.1 — Contracts and types

- [ ] **T1. Meter contracts.**
  **Create** `packages/contracts/src/billing/meter.types.ts` with `UsageMeterId`, `UsagePayerId`,
  `UsageOutcomeId`, `SpendCapScope`, `SpendCapState`, `AddonCode`, `AddonStatus` and every
  constant listed in [plan §3.3](./plan.md#33-contracts) (`SPEND_CAP_MIN_CENTS = 100`,
  `SPEND_CAP_THRESHOLDS = [75, 90, 100]`, `SPEND_CAP_PROPAGATION_MS = 30_000`,
  `AUTO_RECHARGE_MONTHLY_CAP_DEFAULT_CENTS = 10_000`, `AUTO_RECHARGE_MONTHLY_CAP_MIN_CENTS = 1_000`,
  `AUTO_RECHARGE_MONTHLY_CAP_MAX_CENTS = 200_000`, `AUTO_RECHARGE_MAX_CONSECUTIVE_FAILURES = 3`,
  `ADDON_MAX_UNITS_PER_KIND = 25`, `USAGE_CACHE_FRESHNESS_HOURS = 24`,
  `USAGE_EXPORT_MAX_ROWS = 50_000`, `USAGE_EXPORT_MAX_DAYS = 92`, `BREAKDOWN_TOP_N = 10`,
  `UNCONFIRMED_PAYER_ALERT_RATIO = 0.001`).
  **Create** `packages/contracts/src/billing/index.ts`; **modify**
  `packages/contracts/src/index.ts` to re-export it.
  **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations and
  `import { UsageMeterId } from '@ever-works/contracts'` resolves from `apps/api`.

- [ ] **T2** (parallel with T1). **Leaf enums in the agent package.**
  **Modify** `packages/agent/src/entities/_types.ts` to add `UsageMeter`, `UsagePayer` and
  `UsageOutcome` enums. They live here, not next to an entity, for the same decorator-evaluation
  cycle reason the file already documents for `BudgetOwnerType`.
  **Done when**: importing any of the three from a sibling entity module does not produce
  `undefined` at decorator time (assert in T4's entity spec).

## P1.2 — The usage row learns what it is

- [ ] **T3. Usage-event columns.**
  **Modify** `packages/agent/src/entities/plugin-usage-event.entity.ts` to add `meter`, `payer`,
  `outcome`, `creditsCharged`, `priceKey`, `priceVersion` and `missionId` exactly as written in
  [plan §3.1](./plan.md#31-entity-changes), plus the three new `@Index` declarations
  (`idx_plugin_usage_meter_user_occurred`, `idx_plugin_usage_pricekey_user_occurred`,
  `idx_plugin_usage_mission_occurred`).
  **Done when**: the entity compiles, `missionId` carries **no** `@ManyToOne` (audit rows must
  outlive a deleted Mission, matching the existing `agentId` / `taskId` / `runId` comments), and
  its doc comment states that the value is `tasks.missionId` for the row's Task — never
  `agents.missionId`.

- [ ] **T4. Migration `AddUsageMeterClassification` + the Mission backfill.**
  **Create** `apps/api/src/migrations/1791170000000-AddUsageMeterClassification.ts`.
  Generate with `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddUsageMeterClassification`,
  then hand-edit to: guard every `ADD COLUMN` with `hasColumn` and every index with `hasIndex`;
  **not** backfill `meter` (spec FR-8 — inferring it is exactly the guess the spec forbids);
  backfill `missionId` from `tasks.missionId` in batches of 5,000 with a `WHERE … IS NULL` guard
  so the statement is re-runnable and interruptible.
  `down()` drops the three indexes and the seven columns only.
  **Test**: `packages/agent/src/entities/__tests__/plugin-usage-event.entity.spec.ts` — the seven
  columns exist, the three index names are present, and `missionId` has no relation decorator.
  **Done when**: a fresh database and a database with a partially applied earlier attempt both
  migrate cleanly, and re-running the migration inserts nothing new.

## P1.3 — The price list

- [ ] **T5. Credit pricebook.**
  **Create** `packages/agent/src/subscriptions/billing/credit-pricebook.ts` in the same style as
  the neighbouring `credit-packs.ts`: `CreditPrice`, `CREDIT_PRICEBOOK_VERSION = 4`,
  `CREDIT_PRICEBOOK_EFFECTIVE_FROM`, `CREDIT_PRICEBOOK`, `CREDIT_PRICEBOOK_HISTORY`, a pure
  `priceFor(key, units, outcome)` that returns `0` for `cached` and `failed`, and a pure
  `modelTierFor(entry)` that maps a `ModelCatalogEntry`'s `inputCostPer1k` / `outputCostPer1k` to
  `fast` / `balanced` / `frontier`. Entries are exactly the table in
  [spec §6.4](./spec.md#64-billing--the-credit-price-list). Copy the file header rationale from
  `credit-packs.ts`: this is a code table on purpose, so a price change ships with a test rather
  than drifting through an environment variable.
  **Test**: **create** `packages/agent/src/subscriptions/billing/credit-pricebook.spec.ts` —
  every entry has a positive price and a unit; `priceFor` zero-rates `cached` and `failed`;
  `CREDIT_PRICEBOOK_HISTORY` contains every version from 1 to the current and is frozen;
  **and no price key equals any id in the registered plugin catalogue** (Constitution II,
  enforced by CI rather than by review).
  **Done when**: that last assertion fails if someone adds a key named after a plugin.

- [ ] **T6** (parallel with T5). **Expose the pricebook version on the existing pricing view.**
  **Modify** `packages/agent/src/subscriptions/billing/credits-pricing.ts` to add
  `pricebookVersion` and `pricebookEffectiveFrom` to `CreditsPricingView`. Leave
  `marginPercent` in place and untouched — it still describes the platform's own margin analysis
  and removing it is out of scope (spec §9, last open question).
  **Test**: extend `packages/agent/src/subscriptions/billing/credit-packs.spec.ts`'s sibling
  pricing assertions, or add `credits-pricing.spec.ts` if none exists.
  **Done when**: `GET /api/credits/pricing` returns the two new fields.

## P1.4 — Classification at capture

- [ ] **T7. The classifier.**
  **Create** `packages/agent/src/usage/usage-meter-classifier.ts` exporting a pure
  `classify(input): { meter, payer, priceKey, priceVersion, creditsCharged }`. Inputs are the
  capability, the operation, the units, the outcome, and the resolved settings source
  (`user` / `work` → `workspace`; `admin` / `env` → `platform`; anything unresolvable →
  `unconfirmed`). The rule is exactly [spec §5.1](./spec.md#51-the-meter-classification-as-a-total-function):
  workspace-owned → `model` and `creditsCharged = 0`; otherwise → `credits` priced from T5;
  `unconfirmed` → `credits` **and** flagged.
  **Test**: **create** `packages/agent/src/usage/usage-meter-classifier.spec.ts` — the function is
  total over the cross-product of capability × payer × outcome; no input yields two meters; no
  input yields none; an unpriced key yields `creditsCharged = 0` and sets the miss flag.
  **Done when**: a table-driven test enumerates every capability in `PluginUsageCapability` and
  asserts a meter for each.

- [ ] **T8. Stamp it on the single write path.**
  **Modify** `packages/plugin/src/facades/facade-options.interface.ts` to add one optional
  `missionId` beside the existing `agentId` / `taskId` / `runId`, documented as "the Mission of
  the run's Task (`tasks.missionId`), resolved once at dispatch — never `agents.missionId`".
  **Modify** `packages/agent/src/usage/plugin-usage.service.ts` — `record()` calls the classifier,
  writes the seven new fields (five from the classifier, `outcome` from the caller, and
  `missionId` passed straight through — `record()` never reads the `tasks` table itself), and
  increments the two counters (`usage.payer.unconfirmed_ratio`,
  `usage.pricebook.miss`). A classifier throw is caught: the row is still written with
  `payer = 'unconfirmed'`, `meter = 'credits'`, and the counter incremented. A repository throw
  still returns `null` exactly as today.
  **Modify** `packages/agent/src/usage/usage.module.ts` to provide the classifier.
  **Test**: extend `packages/agent/src/usage/plugin-usage.service.spec.ts`.
  **Done when**: no facade change is required for a row to carry a meter, and a seeded run whose
  Task belongs to a Mission produces rows carrying that Mission while a heartbeat run with no Task
  produces rows with `missionId = null`.

- [ ] **T9. Facades pass outcome and payer; the run adapters pass the Task's Mission.**
  **Modify** `packages/agent/src/agents/agent-ai-dispatch-facade.ts` and
  `packages/agent/src/agents/agent-plugin-tools-facade.ts` — the two adapters that already
  thread `taskId` / `runId` into `FacadeOptions` — to resolve the run's Task once and thread
  its `missionId` alongside them. Heartbeat and chat runs with no Task leave it undefined.
  **Modify** `packages/agent/src/facades/search.facade.ts`,
  `packages/agent/src/facades/screenshot.facade.ts`,
  `packages/agent/src/facades/content-extractor.facade.ts` and
  `packages/agent/src/facades/ai.facade.ts` to pass `operation`, `outcome` and the
  `ResolvedSetting.source` they already hold from `BaseFacadeService.getResolvedSettings`. A
  provider error path records `outcome: 'failed'`; a cache hit records `outcome: 'cached'`; a
  forced-fresh call records `outcome: 'ok'` with `forcedFresh: true` in `metadata`.
  **Test**: extend `packages/agent/src/facades/__tests__/ai.facade.spec.ts` and add
  `packages/agent/src/facades/__tests__/search.facade.spec.ts` — a failing provider call still
  writes a row, and that row costs 0 credits.
  **Done when**: a failed search and a cached page fetch both produce `creditsCharged = 0`.

- [ ] **T10** (parallel with T9). **The remaining facades.**
  **Modify** `packages/agent/src/facades/email.facade.ts`,
  `packages/agent/src/facades/notification-channel.facade.ts` and
  `packages/agent/src/facades/metrics.facade.ts` the same way. Email and notification-channel
  sends classify to `addon` with `creditsCharged = 0` (spec FR-36 — sends never draw credits);
  metrics classifies by payer like any other call.
  **Test**: extend `packages/agent/src/facades/__tests__/metrics.facade.spec.ts`; add an email
  facade spec asserting a send never produces a credit charge.
  **Done when**: no email or notification send can produce a non-zero `creditsCharged`.

## P1.5 — Settlement stops guessing

- [ ] **T11. Settle only credits-meter rows.**
  **Modify** `packages/agent/src/subscriptions/credits/run-cost-settlement.service.ts`: sum
  `creditsCharged` over the Run's rows where `meter = 'credits'`; keep stamping
  `agent_runs.costCents` from the **full** metered rollup (it remains a cost estimate surface, as
  its comment already says); keep the `run:{runId}` idempotency key; keep the best-effort posture.
  **Delete** the settlement-time provenance re-resolution, the `PluginSettingsService` dependency
  used only for it, and the `BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL` constant with its TODO — the
  flag it asked for now exists on the row.
  **Modify** `packages/agent/src/database/repositories/plugin-usage.repository.ts` to add
  `getRunCreditsByPriceKey(runId)` and `getRunMeterTotals(runId)`.
  **Test**: rewrite the affected cases in
  `packages/agent/src/subscriptions/credits/run-cost-settlement.service.spec.ts` — a Run made
  entirely on workspace-owned credentials writes no ledger row; a mixed Run debits only the
  credits-meter share; a retried settlement writes no second debit.
  **Done when**: `grep -r BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL packages apps` returns nothing.

## P1.6 — Read side

- [ ] **T12. Repository aggregations.**
  **Modify** `packages/agent/src/database/repositories/plugin-usage.repository.ts` to add
  `getSpendByPriceKeyForUser`, `getSpendByMissionForUser`, `getSpendByMeterForUser`,
  `getWeekSummaryForUser` and `getPreMeterResidualForUser` (rows with `meter IS NULL`). Every one
  takes the same `(userId, from, to, organizationId?)` shape as the existing grouped queries and
  leads with the grouping column so the planner satisfies the `GROUP BY` from the new indexes.
  **Test**: extend
  `packages/agent/src/database/repositories/costs-aggregations.integration.spec.ts`.
  **Done when**: each new method returns ranked rows and the residual query never folds
  `meter IS NULL` rows into a named meter.

- [ ] **T13. Meter and breakdown services.**
  **Create** `packages/agent/src/subscriptions/credits/meter-summary.service.ts` (the three cards
  + the residual) and `packages/agent/src/subscriptions/credits/spend-breakdown.service.ts` (top
  10 plus `Everything else`, per dimension). Both reuse the period parsing already used by
  `usage-summary.service.ts`.
  **Modify** `packages/agent/src/subscriptions/subscriptions.module.ts` to provide both.
  **Test**: `meter-summary.service.spec.ts` and `spend-breakdown.service.spec.ts` beside them —
  the residual is separate, a meter with no data renders `null` rather than `0`, and the
  `Everything else` row is the exact remainder.
  **Done when**: a period with only pre-cutover rows returns all three meters as `null`/zero and a
  non-null residual.

- [ ] **T14. Meters + price-list controllers.**
  **Create** `apps/api/src/billing/meters.controller.ts` (`@Controller('api/billing/meters')`,
  `GET /` with `?period=`) and `apps/api/src/billing/price-list.controller.ts`
  (`@Controller('api/billing/price-list')`, `GET /` and `?version=`).
  **Modify** `apps/api/src/billing/billing.module.ts` to register both.
  **Test**: **create** `apps/api/src/billing/meters.controller.spec.ts` and
  `apps/api/src/billing/price-list.controller.spec.ts` — all five periods; owner scoping; the
  price list renders with no payment provider configured; an unknown version 404s.
  **Done when**: `GET /api/billing/price-list` returns 200 on a deployment with no payment keys.

- [ ] **T15. Three new cost sections.**
  **Modify** `apps/api/src/subscriptions/costs.controller.ts` to add `GET by-tool`,
  `GET by-mission` and `GET by-meter` on the existing `api/usage/costs` prefix, mirroring
  `by-agent`.
  **Modify** `apps/web/src/app/api/usage/costs/[section]/route.ts` to add the three names to the
  closed `[section]` allowlist — nothing else about that route changes.
  **Test**: extend `apps/api/src/subscriptions/costs.controller.spec.ts`; add a case to the web
  route's own unit spec asserting an unknown section still 404s before reaching the API.
  **Done when**: `GET /api/usage/costs/by-mission?window=30d` returns ranked Mission rows, each
  totalling the spend of the Tasks that Mission raised, plus a `Not in a Mission` row for spend
  whose Run had no Task or whose Task names no Mission.

- [ ] **T16. The Home line endpoint.**
  **Modify** `apps/api/src/budgets/account-usage.controller.ts` to add
  `GET /api/me/usage/this-week` returning the three figures, the allowance context and
  `stoppedBy` (always `null` until P2). Period is the last 7 days ending now in the caller's
  profile timezone, falling back to UTC.
  **Test**: **create** `apps/api/src/budgets/account-usage.controller.spec.ts` (the controller
  ships without one today) — timezone handling, owner scoping, and a 60-second cache header.
  **Done when**: the endpoint returns in under 300 ms p95 against a seeded month of usage.

- [ ] **T17. Export columns and the refusal.**
  **Modify** `apps/api/src/subscriptions/credits.controller.ts` — `GET /api/credits/usage/export`
  gains `meter`, `priceKey`, `outcome`, `creditsCharged`, `priceVersion` and `missionId`, and
  refuses with `400` **before** streaming when the resolved set exceeds `USAGE_EXPORT_MAX_ROWS` or
  the period exceeds `USAGE_EXPORT_MAX_DAYS`. Keep piping `response.body` straight through.
  **Modify** `apps/web/src/app/api/credits/usage/export/route.ts` only if a new query param is
  needed; the allowlist must stay explicit.
  **Test**: extend `apps/api/src/subscriptions/credits.controller.spec.ts` and
  `apps/web/src/app/api/credits/usage/export/route.unit.spec.ts`.
  **Done when**: a 120-day export is refused with the limit in the message and no bytes written.

## P1.7 — Web

- [ ] **T18. Shared formatters.**
  **Create** `apps/web/src/components/settings/billing/spend-format.shared.ts` — pure
  cents/credits/percentage formatters and an `unmeasured()` helper that renders `—` with a reason,
  never `0`. Same pattern as `apps/web/src/components/settings/fleet-cost-ceiling.shared.ts`.
  **Test**: **create** `apps/web/src/components/settings/billing/spend-format.shared.unit.spec.ts`.
  **Done when**: the helpers are unit-tested with no React import.

- [ ] **T19. Meter cards.**
  **Create** `apps/web/src/components/settings/billing/MeterCards.tsx` (server component) per
  [spec §6.2](./spec.md#62-billing--three-meter-cards), including the three zero-state sentences
  and the payments-off copy.
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to mount it above the existing
  sections. Nothing existing is removed or reordered.
  **Test**: **create** `apps/web/src/components/settings/billing/MeterCards.unit.spec.tsx`.
  **Done when**: no card can render a blended total, and every empty meter renders a sentence.

- [ ] **T20. Breakdown panels.**
  **Create** `apps/web/src/components/settings/billing/SpendBreakdown.tsx` — three panels fetched
  with `Promise.allSettled` so one failing shows its own retry card and never blanks the others.
  Each row links into the Run list filtered to that dimension and period.
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to mount it.
  **Test**: **create** `SpendBreakdown.unit.spec.tsx` — one rejected fetch leaves two panels
  rendered; `Everything else` is the exact remainder; the pre-cutover note renders when residual
  is non-zero.
  **Done when**: killing the by-Mission endpoint in a test leaves by-tool and by-Agent intact.

- [ ] **T21** (parallel with T20). **The Breakdown tab on Usage.**
  **Modify** `apps/web/src/components/settings/usage/UsageTabs.tsx` and its
  `usage-tabs.shared.ts` to add a third tab `breakdown`, and
  **modify** `apps/web/src/app/[locale]/(dashboard)/settings/usage/page.tsx` to server-fetch only
  that tab's endpoints when it is active — the existing "disjoint fetch sets per tab" property
  must hold for three tabs as it does for two.
  **Test**: extend `apps/web/src/components/settings/costs/CostsSettings.unit.spec.tsx`'s sibling
  tab test, or add `UsageTabs.unit.spec.tsx`.
  **Done when**: opening `?tab=breakdown` issues none of the Overview or Costs requests.

- [ ] **T22. Price-list page.**
  **Create** `apps/web/src/app/[locale]/(dashboard)/settings/billing/price-list/page.tsx` and
  `apps/web/src/components/settings/billing/CreditPriceList.tsx` per
  [spec §6.4](./spec.md#64-billing--the-credit-price-list), with the grouped table, the version
  header, the history note and the conversion footer.
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to link to it from the credits
  card.
  **Done when**: the page renders on a deployment with no payment provider configured.

- [ ] **T23. The week card.**
  **Create** `apps/web/src/components/spend/WeekSpendCard.tsx` — self-contained client component,
  polls at 60 s, stops while `document.hidden`, renders loading / empty / error / stopped states
  per [spec §6.1](./spec.md#61-home--the-one-line-week-mounted-by-aw-19).
  **Create** `apps/web/src/app/api/billing/meters/route.ts` (proxy, explicit param allowlist).
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to mount the card at the top
  until AW-19 lands; leave a one-line comment naming AW-19 as the eventual owner.
  **Test**: **create** `apps/web/src/components/spend/WeekSpendCard.unit.spec.tsx` — polling
  interval, hidden-tab pause, error state does not blank the card.
  **Done when**: with the tab hidden, no network request is issued.

- [ ] **T24. Receipt cost block.**
  **Create** `apps/web/src/components/runs/RunCostMeters.tsx` rendering the three-meter
  itemisation of [spec §6.8](./spec.md#68-a-run-receipts-cost-block-fills-aw-09s-cost-block),
  and **modify** the AW-09 receipt component to mount it inside its existing **Cost** block.
  **Modify** `apps/api/src/subscriptions/costs.controller.ts` (or AW-09's receipt endpoint,
  whichever owns the payload) to include per-price-key lines, cached and failed counts, the
  paying account label and the price-list version.
  **Test**: **create** `apps/web/src/components/runs/RunCostMeters.unit.spec.tsx` — the
  own-account line, cached and failed counts, "so far" labelling, the reconciliation-mismatch
  copy, and the aged-out notice.
  **Done when**: a Run older than 12 months shows the retention notice and keeps its total.

## P1.8 — i18n and end-to-end for P1

- [ ] **T25. Message keys, P1 slice.**
  **Modify** `apps/web/messages/en.json` to add every key under
  `dashboard.settings.billing.meters`, `.breakdown`, `.priceList`, plus `dashboard.spendWeek`,
  `dashboard.runs.receipt.cost` and `dashboard.settings.usage.tabs.breakdown`, exactly as listed
  in [plan §8](./plan.md#8-i18n).
  **Done when**: every leaf key name is camelCase, no leaf key name contains a literal `.`, and
  the hydration spec that fails on a missing key passes.

- [ ] **T26. P1 end-to-end.**
  **Create** `apps/web/e2e/billing-three-meters.spec.ts` (S1, S3, S13, S29),
  `apps/web/e2e/billing-price-list.spec.ts` (S2, S28),
  `apps/web/e2e/run-receipt-cost-meters.spec.ts` (S4, S5, S15, S16, S17, S24) and
  `apps/web/e2e/home-week-spend.spec.ts` (S1).
  Prefer `getByTestId` over `*ByRole` on the dense tables; add the new specs to
  `apps/web/e2e/COVERAGE.md`.
  **Done when**: all four pass locally and in CI with payments disabled.

---

# Phase P2 — Caps that stop

*Delivers spec FR-42…FR-64.*

## P2.1 — Schema

- [ ] **T27. Workspace owner type + cap entity + budget meters + auto-recharge ceiling.**
  **Modify** `packages/agent/src/entities/_types.ts` — add `BudgetOwnerType.WORKSPACE`.
  **Create** `packages/agent/src/entities/workspace-spend-cap.entity.ts` exactly as in
  [plan §3.1](./plan.md#31-entity-changes) — **no `allowOverage` column**, `version` for
  optimistic concurrency, `PortableDateColumn` for every date, `tenantId` and `organizationId` as
  raw uuid columns with no `@ManyToOne` (the entity-cycle rule).
  **Modify** `packages/agent/src/entities/work-budget.entity.ts` and
  `packages/agent/src/entities/agent-budget.entity.ts` to add the nullable `meter` column
  (NULL keeps today's "all meters" meaning).
  **Modify** `packages/agent/src/entities/billing-profile.entity.ts` to add
  `autoRechargeMonthlyCapCents`, `autoRechargeMonthKey` and `autoRechargeMonthSpentCents`.
  **Modify** `packages/agent/src/entities/index.ts` and
  `packages/agent/src/database/_entities-inventory.ts` to register the new entity — this repo has
  no `autoLoadEntities`, and an unregistered entity throws on first query.
  **Test**: **create** `packages/agent/src/entities/__tests__/workspace-spend-cap.entity.spec.ts`
  asserting no `allowOverage` column, portable dates, both scope columns present so
  `apps/api/src/scope/scope-stamping.subscriber.ts` will stamp them; extend
  `packages/agent/src/entities/__tests__/agent-budget.entity.spec.ts` for the new `meter` column.
  **Done when**: all four entity specs pass.

- [ ] **T28. Migration `AddSpendCapsAndMeterScopedBudgets`.**
  **Create** `apps/api/src/migrations/1791170100000-AddSpendCapsAndMeterScopedBudgets.ts`.
  `up()`: create `workspace_spend_caps`; declare `uq_workspace_spend_caps_owner_meter` **in the
  migration** as two partial unique indexes (`WHERE "organizationId" IS NULL` and its complement)
  for the same NULL-is-distinct reason documented on `work_budgets`, and **omit** the
  decorator-level `@Index` so the SQLite test driver's `synchronize` does not generate a
  non-partial duplicate; add `meter` to `work_budgets` and `agent_budgets`; add the three
  `billing_profiles` columns; backfill `autoRechargeMonthlyCapCents = 10000` for every profile
  with `autoRechargeEnabled = true` and a NULL ceiling, so no live auto-recharge is left unbounded
  and none is silently switched off.
  `down()`: drop the table and the five columns.
  **Done when**: a database with existing enabled auto-recharge migrates to a $100 ceiling, and
  re-running the migration changes nothing.

## P2.2 — Enforcement

- [ ] **T29. Cap service.**
  **Create** `packages/agent/src/budgets/spend-cap.service.ts` — one read model over
  `workspace_spend_caps`, `work_budgets`, `agent_budgets` and the Fleet node ceilings; period
  arithmetic (calendar month for all scopes, plus `hour` / `day` / `week` for Agent caps, reusing
  `packages/agent/src/budgets/budget.service.ts`); state computation; strictest-cap resolution;
  optimistic-concurrency writes.
  **Modify** `packages/agent/src/budgets/budgets.module.ts` to provide it.
  **Test**: **create** `packages/agent/src/budgets/spend-cap.service.spec.ts` — every period unit;
  `ok → warning → stopped`; lowering below spend goes straight to `exceeded`; the strictest of
  three overlapping caps wins and is named; a stale `version` throws.
  **Done when**: the strictest-cap test covers Workspace + Mission + Agent all applying at once.

- [ ] **T30. Guard extension.**
  **Modify** `packages/agent/src/budgets/budget-guard.service.ts` — `checkBudget` gains the
  Workspace owner type and a `meter` argument, resolves all applicable caps in one query, refuses
  with `BudgetExceededException` naming the cap that refused, and keeps the existing
  `allowOverage` behaviour for the legacy Work and Agent budgets only.
  **Modify** every facade call site listed in [plan §1.1](./plan.md#11-the-metering-path--one-choke-point-no-meter)
  to pass the meter it is about to record.
  **Test**: extend `packages/agent/src/budgets/budget-guard.service.spec.ts` — a Workspace cap at
  100% refuses; a legacy budget with `allowOverage` still permits; the refusal names the cap; the
  check adds under 15 ms against a seeded month.
  **Done when**: a benchmark case in the spec asserts the p95 latency bound.

- [ ] **T31. Run stops, escalations and decisions.**
  **Modify** `packages/contracts/src/agents/escalation.types.ts` to add `credits-exhausted` to
  `AgentEscalationReasonCode` and `AGENT_ESCALATION_REASON_CODES` — an addition, never a rename,
  as the file's own comment requires.
  **Modify** `packages/agent/src/agents/run-dispatch-gate.service.ts` and
  `packages/agent/src/agents/run-credits-precheck.ts` so a cap refusal parks the Run with
  `budget-stop` and an empty balance parks it with `credits-exhausted` — two distinct reasons.
  **Create** `packages/agent/src/budgets/spend-decision.writer.ts` — writes one decision per
  (cap, period) using the escalation `dedupKey` `budget-stop:{capId}:{period}`, and one per month
  for the auto-recharge ceiling.
  **Test**: extend the dispatch-gate spec; **create** `spend-decision.writer.spec.ts` asserting
  two concurrent crossings produce exactly one decision.
  **Done when**: a Run stopped by a cap and a Run stopped by an empty balance carry different
  reason codes on the receipt.

- [ ] **T32. Auto-recharge ceiling.**
  **Modify** `packages/agent/src/subscriptions/billing/auto-recharge.service.ts` — before the
  compare-and-set claim, roll `autoRechargeMonthKey` if stale, refuse when
  `autoRechargeMonthSpentCents + packPriceCents > autoRechargeMonthlyCapCents` **without
  contacting the provider**, and raise the monthly decision. Increment the counter in
  `apps/api/src/billing/billing-webhook.controller.ts`'s purchase handler, inside the same
  transaction that credits the ledger.
  **Test**: extend `packages/agent/src/subscriptions/billing/auto-recharge.service.spec.ts` — the
  refusal places no provider call; the counter rolls on a new month; the single-flight guard still
  holds; three consecutive failures disable.
  **Done when**: a test asserts the billing provider mock received zero calls on the refusal path.

## P2.3 — API and web

- [ ] **T33. Caps API.**
  **Create** `apps/api/src/budgets/spend-caps.controller.ts` (`@Controller('api/spend-caps')`)
  with `GET /`, `POST /`, `PATCH /:id` (requires `If-Match`), `DELETE /:id`, and the DTOs under
  `apps/api/src/budgets/dto/`. `@Throttle({ long: { limit: 30, ttl: 60_000 } })` on every write.
  Node rows are `editable: false` and every write against one returns `400 NODE_CEILING_READ_ONLY`
  with the Fleet route to use.
  **Modify** `apps/api/src/budgets/budgets.module.ts` to register it.
  **Test**: **create** `apps/api/src/budgets/spend-caps.controller.spec.ts` — all five scopes;
  `409` duplicate; `409 CAP_VERSION_CONFLICT` carrying the current value; `400` on a Node write;
  a cross-user id is indistinguishable from a missing one; writes require billing permission.
  **Done when**: the cross-user case returns the identical body to the missing-id case.

- [ ] **T34. Per-Agent cap API, and the legacy read finally tells the truth.**
  **Create** `apps/api/src/agents/agent-budget.controller.ts`
  (`@Controller('api/agents/:agentId/budget')`) with `GET`, `PUT`, `DELETE`, calling the
  repository `upsert()` that has existed unused since the entity shipped.
  **Modify** `apps/api/src/agents/agents.controller.ts` so its existing
  `GET /api/agents/:id/budget` delegates to the same service instead of returning
  `capCents: null` unconditionally — the path and response shape are preserved (Constitution X).
  **Modify** `apps/api/src/agents/agents.module.ts` to register the new controller.
  **Test**: **create** `apps/api/src/agents/agent-budget.controller.spec.ts` — `PUT` then `GET`
  returns the cap **and a non-zero current spend** computed from seeded usage rows; `DELETE`
  clears it; the legacy path returns the same numbers.
  **Done when**: `apps/web/src/app/[locale]/(dashboard)/agents/[id]/budgets/page.tsx` stops
  showing "no cap configured" for an Agent that has one.

- [ ] **T35. Auto-recharge API.**
  **Modify** `apps/api/src/billing/billing.controller.ts` — `GET/PUT /api/billing/auto-recharge`
  gain `monthlyCapCents` (writable) and `monthlyUsedCents` (read-only). `PUT` with
  `enabled: true` and no ceiling → `400 AUTO_RECHARGE_CAP_REQUIRED`; a ceiling outside
  $10…$2,000 → `400`.
  **Test**: extend `apps/api/src/billing/billing.controller.spec.ts`.
  **Done when**: auto-recharge cannot be enabled without a ceiling through any request shape.

- [ ] **T36. Cap evaluator job.**
  **Create** `packages/tasks/src/tasks/trigger/spend-cap-evaluate.task.ts` as a
  `schedules.task` at `*/10 * * * *` calling the cap service over internal RPC; claim each cap row
  with an atomic `UPDATE … WHERE evaluatingAt IS NULL OR evaluatingAt < now() - interval '5 minutes'`
  (it owns a row, so no distributed lock).
  **Modify** `packages/tasks/src/tasks/trigger/index.ts` to export it,
  `packages/agent/src/tasks/_tasks-symbols.ts` to add `SPEND_CAP_EVALUATE_DISPATCHER`, and
  `packages/agent/src/tasks/job-runtime.providers.ts` to bind it. **No call site imports a third-party
  SDK directly** (Constitution IV).
  **Test**: `packages/agent/src/tasks/spend-cap-evaluate-dispatcher.spec.ts` asserting the symbol
  resolves through the binding factory.
  **Done when**: the task appears in the job-runtime registry and a stale `evaluatingAt` is
  reclaimed.

- [ ] **T37. Caps web surface.**
  **Create** `apps/web/src/app/[locale]/(dashboard)/settings/billing/caps/page.tsx`,
  `apps/web/src/components/settings/billing/SpendCapsTable.tsx` and
  `apps/web/src/components/settings/billing/SpendCapDialog.tsx` per
  [spec §6.5](./spec.md#65-billing--caps) and [§6.6](./spec.md#66-add-a-cap).
  The dialog is focus-trapped, `Esc` closes, `Enter` submits, and it sends `If-Match`.
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to link to it and to show the
  stopped banner. **Do not** add a settings-tree tab — the tree is already 18 items deep.
  **Test**: **create** `SpendCapsTable.unit.spec.tsx` and `SpendCapDialog.unit.spec.tsx`.
  **Done when**: the Node row cannot be edited and links to the Fleet control, and the legacy
  budgets are the only rows showing `overage on`.

- [ ] **T38. Auto-recharge ceiling field + the two decision cards.**
  **Modify** `apps/web/src/components/settings/BillingSettings.tsx` to add the monthly-maximum
  field, its used-this-month readout, and the disabled-after-failures notice.
  **Modify** `apps/web/src/components/approvals/ApprovalsQueue.tsx` to render the two new decision
  kinds with their action buttons, disabled with the permission explanation for a viewer without
  billing permission.
  **Test**: **create** `apps/web/src/components/approvals/ApprovalsQueue.unit.spec.tsx` (the
  component ships without one today) covering both decision kinds and the disabled-for-viewer
  state.
  **Done when**: answering a cap decision with "Raise to {amount}" writes the cap and lifts the
  stop.

- [ ] **T39. Activity-log entries.**
  **Modify** `apps/api/src/activity-log/` to record `spend_cap_created`, `spend_cap_updated`,
  `spend_cap_deleted` and `auto_recharge_cap_updated` with old and new values, attributed to the
  acting user, and never a card detail.
  **Test**: extend the activity-log spec for the four types.
  **Done when**: every cap write produces exactly one log entry.

- [ ] **T40. i18n and end-to-end for P2.**
  **Modify** `apps/web/messages/en.json` to add `dashboard.settings.billing.caps`,
  `.autoRecharge.monthlyCap*`, `dashboard.approvals.spend` and the `errors.billing.*` keys from
  [plan §8](./plan.md#8-i18n).
  **Create** `apps/web/e2e/spend-caps-crud.spec.ts` (S6, S19, S20, S21),
  `apps/web/e2e/spend-cap-stops-a-run.spec.ts` (S7, S12, S18),
  `apps/web/e2e/auto-recharge-ceiling.spec.ts` (S8) and
  `apps/web/e2e/spend-permissions.spec.ts` (S25, S26); add them to `apps/web/e2e/COVERAGE.md`.
  **Done when**: all four pass in CI and no leaf key name contains a literal `.`.

---

# Phase P3 — Add-ons

*Delivers spec FR-35…FR-41.*

- [ ] **T41. Add-on entity + migration.**
  **Create** `packages/agent/src/entities/account-addon.entity.ts` as in
  [plan §3.1](./plan.md#31-entity-changes) (`refId` is `varchar(128)`, not `uuid` — not every
  provisioned unit is keyed by a uuid, and a earlier migration in this repo had to widen a
  `refId` for exactly that reason).
  **Modify** `packages/agent/src/entities/index.ts` and
  `packages/agent/src/database/_entities-inventory.ts`.
  **Create** `apps/api/src/migrations/1791170200000-AddAccountAddons.ts` — create the table with
  both indexes, then backfill one `pending` row per existing agent inbox
  (`tenant_email_addresses`) and per enrolled `fleet_nodes` row so nothing is billed until an
  operator promotes them.
  **Test**: **create** `packages/agent/src/entities/__tests__/account-addon.entity.spec.ts`.
  **Done when**: the backfill produces only `pending` rows and is re-runnable.

- [ ] **T42. Add-on service.**
  **Create** `packages/agent/src/subscriptions/billing/addon.service.ts` — pro-ration on add and
  remove, the 25-per-kind limit, provider quantity updates through the existing
  `BillingProvider` seam in `packages/agent/src/subscriptions/billing/billing.provider.ts` (never
  a third-party SDK import), orphan detection, and a hard guarantee that no code path writes to the
  credit ledger.
  **Modify** `packages/agent/src/subscriptions/subscriptions.module.ts` to provide it.
  **Test**: **create** `packages/agent/src/subscriptions/billing/addon.service.spec.ts` —
  pro-ration for 28-, 30- and 31-day periods; the limit at 26; `seat` refused; an orphan is never
  billed; **no ledger write occurs on any path**.
  **Done when**: the "no ledger write" assertion uses a strict mock that fails the test on any
  call.

- [ ] **T43. Add-ons API.**
  **Create** `apps/api/src/billing/addons.controller.ts` (`@Controller('api/billing/addons')`)
  with `GET /`, `GET /preview`, `POST /`, `DELETE /:id` and DTOs under
  `apps/api/src/billing/dto/`.
  **Modify** `apps/api/src/billing/billing.module.ts` to register it.
  **Test**: **create** `apps/api/src/billing/addons.controller.spec.ts` — preview maths; `409` on
  the unique ref; `400 ADDON_LIMIT_REACHED`; `400 SEAT_MANAGED_ELSEWHERE`.
  **Done when**: `GET /api/billing/addons/preview?code=agent-inbox&quantity=1` returns the
  pro-rated and full amounts for today's date.

- [ ] **T44. Provisioning hooks.**
  **Modify** `apps/api/src/email/email.controller.ts`'s address create and delete paths and
  `apps/api/src/fleet/fleet.controller.ts`'s enroll and unenroll paths to add and remove the
  matching add-on line within 60 seconds, best-effort — a failed add-on write must never fail the
  provisioning call.
  **Test**: extend the two controllers' specs — provisioning succeeds even when the add-on service
  throws, and the reconciler picks the line up afterwards.
  **Done when**: deleting an inbox marks its add-on `removed` without a manual step.

- [ ] **T45. Reconciler job.**
  **Create** `packages/tasks/src/tasks/trigger/addon-reconcile.task.ts` as a `schedules.task` at
  `17 3 * * *`, taking `DistributedTaskLockService` (it owns no row).
  **Modify** `packages/tasks/src/tasks/trigger/index.ts`,
  `packages/agent/src/tasks/_tasks-symbols.ts` (`ADDON_RECONCILE_DISPATCHER`) and
  `packages/agent/src/tasks/job-runtime.providers.ts`.
  **Test**: `packages/agent/src/tasks/addon-reconcile-dispatcher.spec.ts`.
  **Done when**: a vanished unit becomes `orphan` within one run and stops being billed.

- [ ] **T46. Add-ons web surface.**
  **Create** `apps/web/src/app/[locale]/(dashboard)/settings/billing/addons/page.tsx` and
  `apps/web/src/components/settings/billing/AddonsList.tsx` per
  [spec §6.7](./spec.md#67-add-ons) — pro-ration preview before confirm, removal confirmation
  quoting the credit, the read-only seats row linking to the existing seat control, and the orphan
  row.
  **Modify** `apps/web/src/components/settings/billing/MeterCards.tsx` so the third card shows
  real numbers instead of the P1 placeholder.
  **Test**: **create** `AddonsList.unit.spec.tsx`.
  **Done when**: the "never draws credits" sentence appears on the card, the list and the removal
  confirmation.

- [ ] **T47. Mission backfill task** *(parallel with T46)*.
  **Create** `packages/tasks/src/tasks/trigger/usage-mission-backfill.task.ts` as a one-shot
  fan-out for deployments whose `plugin_usage_events` table is too large to backfill inside the
  P1 migration window; **modify** the two dispatcher files as in T36.
  **Done when**: running it twice inserts nothing the second time.

- [ ] **T48. i18n and end-to-end for P3.**
  **Modify** `apps/web/messages/en.json` to add `dashboard.settings.billing.addons.*`.
  **Create** `apps/web/e2e/addons-lifecycle.spec.ts` (S9, S10) and add it to
  `apps/web/e2e/COVERAGE.md`.
  **Done when**: the spec asserts the credits balance is byte-identical before and after adding
  and removing an add-on.

---

# Cross-cutting, do not skip

- [ ] **T49. Program vocabulary.**
  **Modify** `docs/specs/features/agent-workspace/README.md` §1 to add three rows — **Meter**,
  **Credit price list**, **Add-on** — with the "do not introduce" column filled in
  (`"bucket"`, `"rate card"`, `"extra"` respectively). Program rule 2 requires this in the same
  pull request as the epic's first merge.
  **Done when**: every noun this epic introduces appears in the program vocabulary table.

- [ ] **T50. Tracker.**
  **Modify** `docs/specs/features/agent-workspace/TRACKER.md` to move `AW-17` from spec-only to
  the phase actually merged, at the end of each phase.
  **Done when**: the tracker names the merged phase and the pull request.

- [ ] **T51. Telemetry.**
  **Modify** the PostHog call sites under `packages/monitoring/` (or the analytics dispatcher at
  `packages/agent/src/activity-log/activity-log-analytics-dispatcher.ts`, whichever owns the
  surface) to emit the eight events in [plan §9.1](./plan.md#91-analytics-posthog-through-packagesmonitoring),
  and register the six operational counters and their alert thresholds from
  [§9.2](./plan.md#92-operational-counters-and-alerts).
  **Done when**: `usage.pricebook.miss` pages on a single occurrence in a staging soak.

- [ ] **T52. Documentation.**
  **Modify** `docs/features/credits-and-billing.md` to describe the three meters, the
  classification rule and the credit price list, and **modify** `docs/features/budgets-and-usage.md`
  to describe caps as refusals, the four scopes, and the read-only Node ceiling. Both pages are
  already listed in `apps/docs/sidebarsPlatform.ts`, so no sidebar change is needed — if a **new**
  page is added instead, it must be listed there or it renders only as an orphan.
  Also **modify** `docs/features/settings-map.md` for the three new Billing sub-routes.
  **Done when**: the published docs describe the meters, the price list and the caps, and no page
  still says a credit is a blended rate.

---

## Definition of done for the epic

Every box in [spec §8](./spec.md#8-acceptance-criteria) is checkable against the merged code, all
three migrations apply cleanly forward on a database seeded from `develop`, `pnpm lint`,
`pnpm type-check` and `pnpm test` are green, and the nine Playwright specs pass in CI.
