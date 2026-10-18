# FL-20 — Usage & cost on the fleet · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at this branch's base (`origin/develop`
> `e4334baf7`) before it was cited.

**Epic ID:** `FL-20-usage-and-cost`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    CRON[fleet-usage-scan-dispatcher task<br/>every 15 min] -->|enqueue usage-scan per consenting node| Q[(fleet_jobs)]
    Q -->|lease (cap: usage-scan)| N[Node: usage-scan executor]
    N -->|read ~/.claude/projects/**/*.jsonl<br/>~/.codex/sessions/**/*.jsonl<br/>isolated session homes| FS[(local CLI records)]
    N -->|aggregate · dedupe · bucket folders| N
    N -->|POST /api/fleet/jobs/:id/complete { report }| API[FleetJobs complete]
    API --> REC[FleetUsageReconciler]
    REC -->|match providerSessionId| S[(fleet_sessions.tokens/costCents)]
    REC -->|roll up| R[(agent_runs.costCents)]
    REC -->|other bucket + daily rows (P2)| U[(fleet_usage_samples)]
    REC -->|price| P[ModelListPrices port]
    W[Web: hub Usage · session card · receipt] -->|GET /api/fleet/usage| API2[FleetUsageController]
    T[fleet_usage_get · CLI fleet usage] --> API2
```

The node never prices; it reports counts. The platform prices once at ingest, stores tokens and
the version, and serves every surface from stored rows. Data back to the node: only the
acknowledged watermark (`since`) in the next job payload.

## 2. Current state in the codebase

| Piece                                                       | Where (verified at HEAD)                                                                                                                                | Reused as                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Headless run cost report from the node                      | `packages/contracts/src/fleet/fleet-jobs.types.ts:1021-1054` (`FleetAgentTaskModelResult`: `sessionId`, `inputTokens`, `outputTokens`, `totalTokens`, `costCents`) | Kept for `-p` runs; the scan supersedes it when both exist (scan wins, dedupe by session id) |
| Where a fleet run's CLI session id lives                    | `packages/agent/src/entities/agent-run.entity.ts:35-42, 269` (`fleetCliSession { sessionId, nodeId, provider }`)                                       | Second match key for Task runs without a `FleetSession`                                |
| Session's provider session id                               | CONTRACTS §4.2 `FleetSession.providerSessionId` (FL-04)                                                                                                | Primary attribution key (R-13)                                                         |
| Run cost field and ledger                                   | `agent-run.entity.ts:394` (`costCents`); `packages/agent/src/entities/plugin-usage-event.entity.ts:77, 114, 120, 151-152`                               | Run roll-up; ledger left untouched (spec §8b for Budgets)                              |
| Credit price list port (keyed by `capability.operation`)    | `packages/agent/src/usage/credit-price-list.ts:16-27, 33-68`                                                                                            | **Pattern** for the new `MODEL_LIST_PRICES` port (same shape: versions, `find`)        |
| Model catalog with per-1k input/output                      | `packages/agent/src/facades/model-catalog.ts:27-38` (`ModelCatalogEntry.inputCostPer1k/outputCostPer1k`)                                                | Fallback rates (no cache classes)                                                      |
| Meter classifier, usage module                              | `packages/agent/src/usage/usage-meter-classifier.ts:142-154`; `usage.module.ts`                                                                         | `UsageModule` hosts the new port binding                                               |
| Budgets                                                     | `packages/agent/src/entities/agent-budget.entity.ts:22-69` (per-Agent cap; aggregator over `plugin_usage_events`)                                       | P2 roll-up (spec §8b)                                                                  |
| Bounded, incremental JSONL parsing on the node              | `apps/node/src/core/executors/model-transcript.ts:15-60` (constant-memory, head/tail, redaction)                                                        | Scanner's streaming reader                                                             |
| Isolated CLI homes the node creates                         | `apps/node/src/core/model-execution/isolated-home.ts:287-316` (`MODEL_SESSION_HOME_ENV_NAME`, `MODEL_SESSION_HOME_DIR_NAME` `.claude` / `.codex`)      | Extra scan roots                                                                       |
| Executor registration                                       | `apps/node/src/core/runtime.ts:739, 749, 947, 1062`                                                                                                     | `usage-scan` executor registered when the local switch is on                            |
| Job kinds (closed union + max-age record)                   | `packages/contracts/src/fleet/fleet-jobs.types.ts:117-120, 239`                                                                                         | Add `usage-scan` (+ its max-age entry)                                                 |
| Node CLI flags                                              | `apps/node/src/cli/program.ts` (`start --work/--attend`)                                                                                                | `--usage-scan`                                                                         |
| Node config persistence                                     | `apps/node/src/core/config-store.ts:39-45`                                                                                                              | `usageScan: boolean`, `usageScanWatermark`                                             |
| Fleet task cron precedent                                   | `packages/tasks/src/tasks/trigger/fleet-job-lease-sweeper.task.ts`                                                                                      | Dispatcher task shape                                                                  |
| Hub tab registry, routes                                    | FL-01 `apps/web/src/components/fleet/registry.ts`; `apps/web/src/lib/constants.ts:339-347`                                                              | `usage` hub panel; `DASHBOARD_FLEET_USAGE`                                             |
| Session card (R-22), receipt cost block                     | FL-05 `apps/web/src/components/fleet/sessions/SessionCard.tsx`; AW-09 receipt `apps/web/src/components/runs/RunReceiptPanel.tsx`                        | Cost chip; receipt line                                                                |

Missing today: any transcript scan, any per-model list-price table, any Session cost, any fleet
usage route or tab (`apps/web/src/app/[locale]/(dashboard)/settings/usage/page.tsx` is the
platform-usage page, not the fleet's).

## 3. Tech choices

| Concern                     | Choice                                                                                                                                       | Why                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Transport                   | Durable `usage-scan` fleet job (CONTRACTS §12), enqueued by a job-runtime cron, leased with `cap:usage-scan`, result in `complete`           | Periodic, retryable, survives link drops; reuses lease/complete                                 |
| Consent                     | Local `--usage-scan` switch → capability tag `usage-scan` (spec §8b)                                                                          | Machine owner decides; platform never flips it                                                  |
| Scanner                     | Streaming line reader (pattern of `model-transcript.ts`), per-file byte offsets persisted in the node config dir, dedupe set of provider ids kept as a rolling bloom + exact set for the last 30 days | Constant memory; idempotent                                                                    |
| Claude Code records         | `<home>/projects/<project-dir>/*.jsonl` + `$CLAUDE_CONFIG_DIR/projects` + isolated homes; key `message.id` + `requestId`; model from `message.model`; `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`; session id = file's `sessionId`; folder = `cwd` | Fields the CLI writes today; parser tolerant to unknown fields                                 |
| Codex records               | `<home>/sessions/**/*.jsonl` + isolated homes; `token_count` events (`input_tokens`, `cached_input_tokens`, `output_tokens`), model from the session meta line; session id from the meta line; folder = `cwd` | Same tolerance                                                                                  |
| Report shape                | `FleetUsageReport { watermark, rows: FleetUsageRow[] ≤ 2000, truncated }`, row = `{ provider, providerSessionId, model, day, folderBucket, tokens{in,out,cacheRead,cacheWrite}, requests, firstAt, lastAt }` | Bounded per job; backlog drains over scans                                                     |
| Folder bucket               | The checkout path when under a `FleetCheckout` path or allowed root (R-18); else `other:<sha256 prefix 8>`                                   | Spec FR-3                                                                                       |
| Pricing                     | `MODEL_LIST_PRICES` port (`packages/agent/src/usage/model-list-prices.ts`) over a published `model-list-pricebook.ts` (versioned; per 1 M tokens, four classes; Claude Code and Codex model families), fallback to `ModelCatalogEntry` input/output, else tokens-only | Spec FR-7/8; §8b                                                                                |
| Storage P1                  | `fleet_sessions.tokens jsonb` `{ byModel: { [model]: {in,out,cacheRead,cacheWrite,requests} }, priceListVersion, unknownModels[] }`, `costCents`; `agent_runs.costCents` | CONTRACTS §4.2, slot 00                                                                         |
| Storage P2                  | `fleet_usage_samples` (spec §8b, new slot)                                                                                                    | Daily by node × model × attribution × folder                                                   |
| i18n                        | `fleet.usage.*`                                                                                                                              | CONTRACTS §11.4                                                                                 |

## 4. Data model

### 4.1 P1 — slot `1796200000000-AddFleetSessionUsage` (`apps/api/src/migrations/`)

`fleet_sessions`: `tokens simple-json?`, `costCents int?`, `priceListVersion int?`, `usageUpdatedAt timestamptz?`.
`fleet_nodes`: `usageScanAt timestamptz?`, `usageScanBacklogPct smallint?` (display only).
Index `idx_fleet_sessions_provider_session (provider, providerSessionId)` for attribution lookups.

### 4.2 P2 — proposed slot `1796200100000-CreateFleetUsageSamples` (CONTRACTS change, spec §8b)

`fleet_usage_samples`: `id`, `userId`, `nodeId`, `day date`, `provider`, `model`, `attribution varchar(8)`
(`session · other`), `fleetSessionId uuid?`, `providerSessionId text?`, `folderBucket text`,
`tokensIn bigint`, `tokensOut bigint`, `tokensCacheRead bigint`, `tokensCacheWrite bigint`,
`requests int`, `costCents int?`, `priceListVersion int?`, `firstAt`, `lastAt`. Unique
`(nodeId, day, provider, model, attribution, providerSessionId, folderBucket)`; index `(userId, day)`.

### 4.3 Contracts

- `packages/contracts/src/fleet/fleet-usage.types.ts` (new): `FleetUsageReport`, `FleetUsageRow`,
  `FleetUsageView` (totals, byModel, byNode, busiestCheckouts, sessions, unknownModels, note,
  priceListVersion), `FLEET_USAGE_REPORT_MAX_ROWS = 2000`, `FLEET_USAGE_PERIODS = [1, 7, 30, 90]`.
- `fleet-jobs.types.ts`: `'usage-scan'` in `FleetJobKind` (`:117`), `FLEET_JOB_KINDS` (`:120`),
  entry in `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` (`:239`, value `900`); capability constant `FLEET_USAGE_SCAN_CAPABILITY = 'usage-scan'`.
- `packages/contracts/src/fleet/fleet-model-list-prices.types.ts`: `ModelListPriceEntry { model, provider, perMillion: { in, out, cacheRead, cacheWrite } }`, `ModelListPriceListVersion`.

## 5. API surface

| Method | Path                                      | Shape / DTO                                                              | Auth / family                 | Rate   | Errors                                                       |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------ | ----------------------------- | ------ | ------------------------------------------------------------ |
| GET    | `/api/fleet/usage?days=7&node=&model=`    | `FleetUsageView`                                                         | `view` per node; totals exclude unseen | 60/min | `invalid` (days ∉ {1,7,30,90})                              |
| GET    | `/api/fleet/nodes/:id/usage?days=`        | `FleetUsageView` scoped to one node                                      | `view`                        | 60/min | `not_found`, `consent_missing` (hint: the opt-in command), `unsupported_on_node` |
| POST   | `/api/fleet/nodes/:id/usage/rescan`       | `202 { jobId }` — enqueues one `usage-scan` now                          | owner                         | 6/hour | `unreachable`, `consent_missing`, `kill_switch`              |
| GET    | `/api/fleet/sessions/:id` (FL-04)         | gains `tokens`, `costCents`, `priceListVersion`                          | existing                      | —      | —                                                            |
| POST   | `/api/fleet/jobs/:id/complete` (existing) | accepts `result: FleetUsageReport` for kind `usage-scan`                  | node credential               | —      | `invalid` (rows > 2000)                                      |
| GET    | `/api/fleet/usage/prices`                 | the current model list-price version (read-only)                          | authenticated                 | 60/min | —                                                            |

## 6. Node side

**Module:** `apps/node/src/core/usage/` — `usage-scan-executor.ts` (job kind `usage-scan`),
`claude-records.ts`, `codex-records.ts` (parsers), `usage-dedupe.ts`, `usage-aggregate.ts`,
`usage-roots.ts` (which directories: real home CLI dirs, `$CLAUDE_CONFIG_DIR`, every isolated home
under the node's data root from `isolated-home.ts`), `usage-watermark.ts` (per-file offsets in
`<configDir>/usage/offsets.json`). Registered in `runtime.ts` only when `nodeConfig.usageScan` is
true; then advertises tag `usage-scan`. CLI: `start --usage-scan` and `usage-scan on|off` verbs in
`apps/node/src/cli/program.ts`; `status` prints the privacy sentence.

| OS      | Claude Code home                       | Codex home                     | Notes                                                       |
| ------- | -------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Linux   | `~/.claude/projects`                   | `~/.codex/sessions`            | plus `$CLAUDE_CONFIG_DIR/projects` when set for the user     |
| macOS   | same                                   | same                           |                                                             |
| Windows | `%USERPROFILE%\.claude\projects`       | `%USERPROFILE%\.codex\sessions`| service runs as the enrolling user, so the same dirs         |

Job protocol: payload `{ since: watermark | null }`; executor reads from offsets, aggregates, trims
to 2 000 rows (oldest first), reports `{ watermark, rows, truncated }`; the platform stores the
acknowledged watermark in `fleet_nodes.usageScanAt` and passes it back next time. No link channel
is used (CONTRACTS §12 places `usage-scan` in the durable column). Kill switch: nodes lease
nothing while it is on (existing). Consent: the local switch only; the platform never enqueues for
a node without the tag.

What the executor never does: open a file outside the roots, read a line past 64 KiB (skipped,
counted), transmit any string field other than `model`, `providerSessionId`, `folderBucket`.

## 7. Plugin surface

None. (A future `model-price-source` plugin could feed the port; not in this epic.)

## 8. Web surface

- Route `/fleet/usage` — `apps/web/src/app/[locale]/(dashboard)/fleet/usage/page.tsx`; constant
  `DASHBOARD_FLEET_USAGE` in `apps/web/src/lib/constants.ts`; registry entry `usage` in
  `apps/web/src/components/fleet/registry.ts`.
- Components `apps/web/src/components/fleet/usage/`: `UsagePanel.tsx`, `UsagePeriodControl.tsx`,
  `UsageTotals.tsx`, `UsageByModel.tsx`, `UsageByComputer.tsx`, `UsageBusiestCheckouts.tsx`,
  `UsageSessionsBreakdown.tsx`, `UsagePayerNote.tsx` (the FR-9 sentence, one component mounted
  everywhere), `UsageCatchingUp.tsx`, `usage.shared.ts` (pure: formatting, exclusion notes).
- Session card: `SessionCostChip.tsx` in `apps/web/src/components/fleet/sessions/` (R-22 slot).
- Receipt: `RunReceiptFleetCostLine.tsx` mounted in AW-09's cost block.
- Computer Overview line and Agent Budgets tab row: small components in the same folder.
- Server actions `apps/web/src/app/actions/dashboard/fleet-usage.ts`; API client `apps/web/src/lib/api/fleet.ts` gains `usage`.
- i18n `fleet.usage.{tab,periods,totals,byModel,byComputer,checkouts,sessions,payerNote,empty,catchingUp,errors}`.
- Playwright: `apps/web/e2e/flow-fleet-usage.spec.ts`, `apps/web/e2e/flow-fleet-usage-contract.spec.ts`.

## 9. Agent / MCP / CLI surface

| Surface | Name                                              | Annotation        |
| ------- | ------------------------------------------------- | ----------------- |
| Agent   | `fleet_usage_get { days?, node? }`                | `readOnly: true`  |
| MCP     | `fleet_usage_get` → `GET /api/fleet/usage`        | `readOnlyHint`    |
| CLI     | `ever-works fleet usage [--days 1|7|30|90] [--on <node>] [--json]` | exit `0/1/2` |

## 10. Background jobs

| Task                           | File                                                                      | When          | Does                                                                                                   | Idempotency                                  |
| ------------------------------ | ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `fleet-usage-scan-dispatcher`  | `packages/tasks/src/tasks/trigger/fleet-usage-scan-dispatcher.task.ts`    | every 15 min  | For every online node advertising `usage-scan`: enqueue `usage-scan` with `since`; skip when one is queued/leased | `idempotencyKey = usage-scan:<nodeId>:<15-min bucket>` |
| `FleetUsageReconciler` (on `complete`) | `packages/agent/src/fleet/fleet-usage-reconciler.service.ts`      | per report    | Match rows to Sessions (`providerSessionId`) and Task runs (`fleetCliSession.sessionId`); price; write Session tokens/cost, Run `costCents`; P2 upsert samples; advance watermark | upsert by the unique key; rows carry the node's dedupe guarantee |
| `fleet-usage-rollup` (P2)      | same reconciler                                                           | daily         | Budget contributions; Agent/computer period aggregates cached in `fleet_usage_samples`                  | by day                                       |

Dispatched through `*_DISPATCHER` symbols in `packages/agent/src/fleet/fleet-usage.dispatcher.ts` (Constitution IV).

## 11. Security & permissions

- Privacy boundary is on the machine: the parser emits only the allowed fields; a test feeds
  records with prompts, outputs and tokens-shaped secrets and asserts none survive.
- Folder names leave the machine only for known checkouts/roots (R-18 canonicalisation); others
  are hashed buckets.
- Reads: `view` audience per node; totals exclude what the viewer may not see and say so; "other"
  sessions owner-only by default (spec §8b).
- No audit row per scan (read-only); switching the local flag writes `node.consent.change`.
- The platform never requests the scan on a node without the tag; the node refuses a `usage-scan`
  lease when the switch is off (defence in depth).

## 12. Observability

Metrics `fleet_usage_records_scanned_total{provider}`, `…_deduplicated_total`, `…_attributed_total{attribution}`,
`fleet_usage_unknown_model_total`, `fleet_usage_scan_duration_seconds`, `fleet_usage_backlog_pct`.
Activity log: none (no user action); platform alert when `unknownModels` exceeds 10 % of requests
for a week (price table needs an update).

## 13. Phased rollout

| Phase | Flag                        | Contents                                                                                                                                                 |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | `FLEET_USAGE_SCAN_ENABLED`  | Job kind, node executor + parsers + switch, dispatcher, reconciler (Sessions, Runs), price port + pricebook v1, slot-00 migration, session chip, receipt line, `fleet_usage_get`, CLI `fleet usage --on` |
| P2    | same                        | `fleet_usage_samples` (after the CONTRACTS change), hub Usage tab, computer Overview line, Agent Budgets tab, Budgets roll-up, FL-13 rows, "other" sessions |
| P3    | same                        | Digest line, export, price-list version history                                                                                                          |

## 14. Test plan

| Package              | Runner     | Specs                                                                                                                                                                                         |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-usage.spec.ts` (shapes, caps); `fleet-jobs.spec.ts` extended (`usage-scan`, max-age entry)                                                                        |
| `apps/node`          | Vitest     | `src/core/usage/claude-records.spec.ts` and `codex-records.spec.ts` (fixtures under `src/core/usage/__fixtures__/` with prompts/outputs; only allowed fields emitted; oversize lines skipped); `usage-dedupe.spec.ts` (twice = once; deletion never subtracts); `usage-roots.spec.ts` (isolated homes included; nothing outside); `usage-scan-executor.spec.ts` (2 000-row trim, watermark, refuses when switch off) |
| `packages/agent`     | Jest       | `src/usage/__tests__/model-list-prices.spec.ts` (four classes; version; fallback; unknown → null, never 0); `src/fleet/__tests__/fleet-usage-reconciler.service.spec.ts` (session match, Task-run match, other, late claim, Run roll-up, idempotency) |
| `packages/tasks`     | Jest       | `src/__tests__/fleet-usage-scan-dispatcher.task.spec.ts` (only tagged nodes; no double enqueue)                                                                                               |
| `apps/api`           | Jest       | `src/fleet/fleet-usage.controller.spec.ts` (every code+hint; audience exclusion note; periods)                                                                                                |
| `apps/cli`           | Vitest     | `src/commands/fleet/__tests__/usage.spec.ts`                                                                                                                                                  |
| `apps/web`           | Vitest     | `components/fleet/usage/usage.shared.unit.spec.ts`; `SessionCostChip.unit.spec.tsx` (payer sentence verbatim; tokens-only)                                                                    |
| `apps/web`           | Playwright | `e2e/flow-fleet-usage.spec.ts` (periods, blocks, offline row, opt-in hint, catching up); `e2e/flow-fleet-usage-contract.spec.ts`                                                              |

## 15. Risks

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                          |
| ----------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------- |
| CLI record formats change                                   | High       | Medium | Tolerant parsers; unknown fields ignored; `unknownModels` alert; fixtures per CLI version            |
| Users read "list price" as a charge                         | Medium     | High   | FR-9 sentence on every surface, one component; never a currency without the word "list"             |
| Price table goes stale                                      | High       | Medium | Versioned; alert at 10 % unknown; P3 history view                                                   |
| Privacy regression (a prompt leaks)                         | Low        | High   | Fixture test asserting field allow-list; the node's secret scanner as a second belt on string fields |
| CONTRACTS changes for P2 not approved                       | Medium     | Medium | P1 ships complete on slot 00; P2 is clearly gated                                                   |

## 16. Constitution reconciliation

I n/a (local files, existing facade fallback) · II price via a port · III metadata only · IV dispatcher and reconciler via `*_DISPATCHER`; node job leased · V slot 00 now, P2 slot flagged · VI tests per package · VII counts only; no credential · VIII n/a · IX spec code-free · X additive.

## 17. References

Spec `./spec.md` · Tasks `./tasks.md` · CONTRACTS R-1, R-13, R-22, §4.2, §8, §9, §11, §12, §13 · AW-17 plan (price list port) · FL-04 plan (`providerSessionId`) · FL-05 plan (session card) · AW-09 plan (receipt) · FL-01 plan (registry)
