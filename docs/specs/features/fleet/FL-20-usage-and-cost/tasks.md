# FL-20 — Usage & cost on the fleet · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI).

**Feature ID**: `fl-20-usage-and-cost`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative. `packages/agent`, `apps/api`, `packages/tasks` use **Jest**;
  `apps/node`, `packages/contracts`, `apps/cli`, `apps/web` unit use **Vitest**; e2e is **Playwright**.
- Everything is behind `FLEET_USAGE_SCAN_ENABLED`. FL-04 must have landed (`providerSessionId`).
- P2 is blocked on the CONTRACTS changes in spec §8b (samples table, `usage-scan` tag).
- Add tasks at the bottom; never renumber. Commit style `feat(fleet-usage): …`.

## P1.A — Contracts and schema

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-usage.types.ts` (report, row, view, constants) and `fleet-model-list-prices.types.ts`; export from `packages/contracts/src/fleet/index.ts`.
  **Test**: `packages/contracts/src/fleet/__tests__/fleet-usage.spec.ts` — guards; `FLEET_USAGE_PERIODS`; row cap.
- [ ] **T-02**. Add `'usage-scan'` to `FleetJobKind` and `FLEET_JOB_KINDS` (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-120`), an entry in `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` (`:239`, `900`), and `FLEET_USAGE_SCAN_CAPABILITY`.
  **Test**: `fleet-jobs.spec.ts` extended — the record compiles with the new kind; the node completes an unknown kind as failure (existing behaviour unchanged).
- [ ] **T-03**. Add columns to `packages/agent/src/entities/fleet-session.entity.ts` (FL-04) — `tokens`, `costCents`, `priceListVersion`, `usageUpdatedAt` — and `usageScanAt`, `usageScanBacklogPct` to `fleet-node.entity.ts`.
  **Test**: entity metadata spec.
- [ ] **T-04**. Author `apps/api/src/migrations/1796200000000-AddFleetSessionUsage.ts` (columns + `idx_fleet_sessions_provider_session`); hand-check additive only.
  **Test**: applies twice; empty re-generate diff.

## P1.B — Pricing

- [ ] **T-05**. Add `packages/agent/src/usage/model-list-pricebook.ts` — versioned, frozen `MODEL_LIST_PRICEBOOK_HISTORY` (v1: current Claude Code and Codex model families, per 1 M tokens, four classes) and `MODEL_LIST_PRICEBOOK_VERSION`.
  **Test**: `src/usage/__tests__/model-list-pricebook.spec.ts` — every entry has four positive rates; versions ascend.
- [ ] **T-06**. Add `packages/agent/src/usage/model-list-prices.ts` — `MODEL_LIST_PRICES` port modelled on `credit-price-list.ts:16-27`, `PublishedModelListPrices` with catalog fallback (`packages/agent/src/facades/model-catalog.ts:27-38`, input/output only) and `price(tokens, model) → { costCents, version } | null`; bind in `packages/agent/src/usage/usage.module.ts`.
  **Test**: `__tests__/model-list-prices.spec.ts` — four classes priced; fallback prices cache classes as unknown (tokens-only); unknown model → `null`, never 0.

## P1.C — Node

- [ ] **T-07**. Add `--usage-scan` to `start` and `usage-scan on|off` verbs in `apps/node/src/cli/program.ts`; persist `usageScan` in `apps/node/src/core/config-store.ts`; `status` prints the privacy sentence; advertise tag `usage-scan` in `apps/node/src/core/capabilities.ts` only when on.
  **Test**: `capabilities.spec.ts` — tag only with the switch; `config-store.spec.ts` round-trip.
- [ ] **T-08**. Add `apps/node/src/core/usage/usage-roots.ts` — real CLI homes, `$CLAUDE_CONFIG_DIR/projects`, every isolated home under the node data root (`apps/node/src/core/model-execution/isolated-home.ts:313-316` dir names); canonical paths; nothing outside.
  **Test**: `usage-roots.spec.ts` — isolated homes included; symlink escape refused.
- [ ] **T-09**. Add `apps/node/src/core/usage/claude-records.ts` and `codex-records.ts` — streaming parsers (pattern `apps/node/src/core/executors/model-transcript.ts`), allow-listed output fields, 64 KiB line skip.
  **Test**: `claude-records.spec.ts`, `codex-records.spec.ts` with fixtures under `apps/node/src/core/usage/__fixtures__/` containing prompts, outputs and token-shaped strings — none appear in output; counts exact.
- [ ] **T-10**. Add `usage-dedupe.ts` (provider-id set, 30-day exact + rolling bloom) and `usage-watermark.ts` (`<configDir>/usage/offsets.json`, owner-only).
  **Test**: `usage-dedupe.spec.ts` — twice equals once; deletion never subtracts; `usage-watermark.spec.ts` — offsets survive restart.
- [ ] **T-11**. Add `usage-aggregate.ts` (row key provider × session × model × day × folderBucket; bucket = checkout/root path or `other:<hash8>`) and `usage-scan-executor.ts` (kind `usage-scan`; ≤ 2 000 rows oldest first; `truncated`; refuses when the switch is off); register in `apps/node/src/core/runtime.ts` beside `:1062`.
  **Test**: `usage-aggregate.spec.ts` — bucket rules; `usage-scan-executor.spec.ts` — trim, watermark advance, refusal.

## P1.D — Platform

- [ ] **T-12**. Add `packages/agent/src/fleet/fleet-usage-reconciler.service.ts` — match by `fleet_sessions.providerSessionId`, then `agent_runs.fleetCliSession.sessionId` (`agent-run.entity.ts:269`); price via `MODEL_LIST_PRICES`; write Session `tokens`/`costCents`/`priceListVersion`; roll into `agent_runs.costCents` (scan wins over the `-p` summary for the same session id); unmatched rows are not stored in P1 — the node keeps re-reporting them until a Session claims them (T-11 watermark semantics), and P2's samples table holds them as "other"; advance `usageScanAt`.
  **Test**: `__tests__/fleet-usage-reconciler.service.spec.ts` — session match; Task-run match; late claim; idempotent re-report; Run roll-up equals Session.
- [ ] **T-13**. Hook the reconciler into job completion for kind `usage-scan` in `apps/api/src/fleet/fleet-jobs.controller.ts` (`:id/complete`) with DTO validation (`rows ≤ 2000`).
  **Test**: `fleet-jobs.controller.spec.ts` extended — oversize report → `invalid`; node credential required.
- [ ] **T-14**. Add `packages/tasks/src/tasks/trigger/fleet-usage-scan-dispatcher.task.ts` (every 15 min; only nodes with tag `usage-scan`; idempotency key per node per bucket) and `packages/agent/src/fleet/fleet-usage.dispatcher.ts` (`FLEET_USAGE_SCAN_DISPATCHER`); register beside `fleet-job-lease-sweeper.task.ts`.
  **Test**: `packages/tasks/src/__tests__/fleet-usage-scan-dispatcher.task.spec.ts` — untagged nodes skipped; no double enqueue.
- [ ] **T-15**. Add `apps/api/src/fleet/fleet-usage.controller.ts` — `GET /api/fleet/usage`, `GET /api/fleet/nodes/:id/usage`, `POST /api/fleet/nodes/:id/usage/rescan`, `GET /api/fleet/usage/prices`; `FleetFlagGuard('FLEET_USAGE_SCAN_ENABLED')`; audience filtering with the exclusion note.
  **Test**: `fleet-usage.controller.spec.ts` — every §8 code with hint; periods; exclusion note.
- [ ] **T-16**. Extend FL-04's `GET /api/fleet/sessions/:id` view with `tokens`, `costCents`, `priceListVersion` (`packages/contracts/src/fleet/fleet-sessions.types.ts`).
  **Test**: session controller spec extended.

## P1.E — Web, tool, CLI

- [ ] **T-17**. Add `apps/web/src/components/fleet/usage/UsagePayerNote.tsx` and `apps/web/src/components/fleet/sessions/SessionCostChip.tsx` (R-22 slot on FL-05's `SessionCard.tsx`); i18n `fleet.usage.payerNote` and chip keys.
  **Test**: `SessionCostChip.unit.spec.tsx` — sentence verbatim in the tooltip; tokens-only variant.
- [ ] **T-18**. Add `RunReceiptFleetCostLine.tsx` into AW-09's cost block (`apps/web/src/components/runs/RunReceiptPanel.tsx`), gated on the Run having a fleet Session with usage.
  **Test**: receipt unit spec extended — line present only with usage; unchanged otherwise.
- [ ] **T-19**. Add `fleet_usage_get` to the FL-19 catalogue (`packages/contracts/src/fleet/fleet-tools.types.ts`) and MCP whitelist; CLI `apps/cli/src/commands/fleet/usage.ts` (`--days`, `--on`, `--json`).
  **Test**: catalogue parity specs; `apps/cli/src/commands/fleet/__tests__/usage.spec.ts`.
- [ ] **T-20**. Computer page Overview line (`apps/web/src/components/fleet/computer/ComputerOverviewUsageLine.tsx`) — scan state, last scan age, 7-day cost or opt-in hint.
  **Test**: unit spec — three states.
- [ ] **T-21**. Playwright `apps/web/e2e/flow-fleet-usage-contract.spec.ts` — session detail shows tokens and cost after a fake report; receipt line; refusal bodies.

## P2 — Hub tab, samples, roll-ups (after CONTRACTS §8b approval)

- [ ] **T-22**. Entity `packages/agent/src/entities/fleet-usage-sample.entity.ts` and migration `apps/api/src/migrations/1796200100000-CreateFleetUsageSamples.ts` (plan §4.2).
  **Test**: entity spec; migration applies twice.
- [ ] **T-23**. Reconciler upserts daily samples (session and other); `fleet_nodes.usageScanBacklogPct` from `truncated` reports.
  **Test**: reconciler spec — unique-key upsert; other rows owner-only flag.
- [ ] **T-24**. `GET /api/fleet/usage` served from samples: totals, byModel, byNode (last-scan age, offline), busiestCheckouts, sessions breakdown, `unknownModels`.
  **Test**: controller spec — offline node retained; unknown models excluded from dollars with note.
- [ ] **T-25**. Hub tab: `DASHBOARD_FLEET_USAGE` in `apps/web/src/lib/constants.ts`; page `apps/web/src/app/[locale]/(dashboard)/fleet/usage/page.tsx`; registry entry; components `UsagePanel.tsx`, `UsagePeriodControl.tsx`, `UsageTotals.tsx`, `UsageByModel.tsx`, `UsageByComputer.tsx`, `UsageBusiestCheckouts.tsx`, `UsageSessionsBreakdown.tsx`, `UsageCatchingUp.tsx`, `usage.shared.ts`; server action `apps/web/src/app/actions/dashboard/fleet-usage.ts`.
  **Test**: `usage.shared.unit.spec.ts`; Playwright `apps/web/e2e/flow-fleet-usage.spec.ts`.
- [ ] **T-26**. Agent Budgets tab row per computer (`apps/web/src/components/agents/AgentFleetUsageRows.tsx`) and the Budgets roll-up per the §8b decision (ledger rows with a non-debiting payer, or a second aggregation in `BudgetGuardService`).
  **Test**: budget guard spec — fleet cost counts toward the cap, labelled list price, never debits credits.
- [ ] **T-27**. FL-13 schedule rows: last-run and 30-day cost from samples (`apps/web/src/components/fleet/schedules/ScheduleRunHistory.tsx`).
  **Test**: unit spec extended.

## P3 — Digest, export, versions

- [ ] **T-28**. Daily digest line via the existing digest service (`packages/agent/src/digest/`); export CSV from the tab; price-list version history panel.
  **Test**: digest spec; export snapshot.

## Docs and rollout

- [ ] **T-29**. User doc `docs/features/fleet-usage.md` (what is read, what never is, the list-price sentence, the opt-in command); add to `apps/docs/sidebarsPlatform.ts` under fleet (`:183`); link from `docs/features/budgets-and-usage.md` ("Where the numbers come from") and `docs/features/fleet.md`.
- [ ] **T-30**. Update `docs/specs/features/fleet/TRACKER.md`; record the CONTRACTS decisions from spec §8b once made.
- [ ] **T-31**. `pnpm format && pnpm lint && pnpm test && pnpm build`; docs build clean; banned-terms grep on this folder prints nothing.

## Definition of done

- All boxes ticked; every FR has a test; flag off hides the tab, the tool and the routes and stops the dispatcher.
- Spec §9 verified with fixture records on two fake nodes (one opted in, one not), one Agent session, one owner session and one "other" session.
- No prompt, output, file content or credential appears in any report, row, log or test snapshot (asserted by the fixture tests).
