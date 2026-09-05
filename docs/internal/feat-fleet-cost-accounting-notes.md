# Fleet cost accounting + model identity — working notes (EW-777, self-build slice U)

Closes R12, OPS-04, OPS-05. Depends on slice B (#2298).

## The defect

A fleet node parsed the model CLI's `total_cost_usd` and the API-side
reconciler spent it on **one chat sentence**. `markCompleted` carried no
cost, so `AgentRun.costCents` was NULL for every fleet run, `AgentBudget`
never tripped, the Goal spend cap summed zeros, the Costs dashboard read
$0.00 while six subscriptions burned, and the runbook's "max spend per
run" was unenforceable.

## What ships

1. **Cost and tokens travel end to end.** The node now parses Claude
   Code's `usage` / `modelUsage` (tokens per bucket, the model the money
   went to) and Codex's per-turn `usage`; the shared contract
   (`FleetAgentTaskModelResult`) carries `modelId`, `inputTokens`,
   `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`,
   `totalTokens` next to `costUsd`. `fleetModelCostUsdToCents` is the
   one dollar → cents conversion (nearest cent; non-finite ⇒ `null`,
   i.e. _unknown_, never _free_).
2. **No second accounting.** `FleetAgentTaskReconcilerService.accountModelSpend`
   — taken for any verdict, **before** the question / success / failure
   split — writes what the cloud path writes: one `plugin_usage_events`
   row tagged with the run, Agent, Task and Work
   (`pluginId: fleet-node:<provider>`, `requestId: <fleet job id>`,
   the node's billing identity in `metadata.billedTo`), the run's token
   total through `AgentRunRepository.addTokens`, and the job's cost on
   `fleet_jobs.costCents`. The terminal CAS that follows settles the row
   onto `agent_runs.costCents` through the very same
   `RunCostSettlementService` a cloud run uses. Downstream, nothing
   changed and everything lights up: `GoalOrchestratorService.computeSpend`,
   the Costs dashboard (summary / daily / by-model / top-runs), the
   per-Agent budget precheck.
3. **The budget precheck is real now.** `AgentRunService.checkBudget`
   used to synthesise `currentSpendCents = 0` (a Phase 7.5 TODO). It now
   sums `plugin_usage_events` by `(userId, agentId, occurredAt)` through
   `PluginUsageRepository.getTotalSpendCentsForAgent`, so fleet rows count
   exactly like cloud rows. A capped budget whose spend cannot be read
   (no repository bound, query threw) is refused with
   `reason: 'unevaluable'` — fail closed.
4. **Daily ceilings.** `FleetCostCeilingService` evaluates a per-node and
   a fleet-wide DAILY (UTC) ceiling after every completion, once the
   job's cost is stamped. Sources: the node's `dailyCostCeilingCents`
   column, else `FLEET_NODE_DAILY_COST_CEILING_USD`; the owner's
   `fleet_cost_policies.dailyCeilingCents`, else
   `FLEET_DAILY_COST_CEILING_USD`. Both unset by default ⇒ zero behaviour
   change. Crossing one drains through the drain endpoint's exact pair
   (`FleetService.setDisabledForUser` then
   `FleetJobService.releaseClaimsForNode`; the fleet-wide ceiling drains
   every enrolled node) and files **one** Inbox notice per (scope, day)
   via a CAS on `fleet_nodes.dailyCostTrippedOn` /
   `fleet_cost_policies.trippedOn`. Repeat crossings drain again and say
   nothing new.
5. **Model identity is observable.** Every heartbeat / enroll carries
   `modelIdentity` — a display label the node builds from whitelisted
   fields of `claude auth status --json` (`email`, `orgName`,
   `subscriptionType`, `authMethod`) or `codex login status` prose;
   cached five minutes on the node; capped at 200 chars; never a token.
   Stored on `fleet_nodes.modelIdentity`, shown in the Fleet table, the
   node drawer and the runner-status popover, and frozen per run in the
   usage row's `metadata.billedTo`.

## Decisions recorded here (and only here)

- **The seat policy is NOT decided by this change.** Whether each PC runs
  under a dedicated seat or its owner's own login is the founder's call.
  This slice makes the identity observable and attributable; it takes no
  position on which identity it should be.
- **Fleet spend is a CLI-reported estimate, never a credits debit.**
  Claude Code prints `total_cost_usd` at API list price even on a
  flat-rate seat; Codex prints tokens and no price. The figure is
  recorded for visibility, the Goal cap and the ceilings; it is exempt
  from the credits debit by construction (`fleet-node:*` rows are
  bring-your-own under the same founder rule as BYOK, P2/P3), so the
  owner is never charged twice for a seat they already pay for.
- **Fail closed, in three places.** A configured ceiling drains the node
  when the spend cannot be evaluated: the completing run's CLI reported
  no price (Codex), the daily sum threw or is not a number, or the
  ceiling lookup itself threw. Consequence worth stating: **a ceiling on
  a Codex-only node drains it on its first completion** until Codex
  pricing exists — enabling a ceiling on such a node is a decision, and
  the notice body says why it tripped. The budget precheck refuses the
  run under the same rule.
- **`disabled`, not `paused`.** A node can lift its own pause
  (`setPausedByCredential`) but not an owner-level disable. A drained
  node stays disabled past midnight until the owner re-enables it — a
  ceiling is a stop, not a rate limit. The day boundary is UTC (owner
  time zones are not modelled); the notice says so.
- **The fleet-wide ceiling sums `fleet_jobs.costCents` only** — what the
  owner's own machines reported — never the account's cloud spend or
  BYOK usage rows. Those have their own budgets; folding them in would
  drain a fleet for money spent elsewhere. Do not "fix" it to the
  `plugin_usage_events` aggregate.
- **One exception to "no second accounting".** A run with no Work to
  attribute the usage row to (`plugin_usage_events.workId` is NOT NULL),
  or a deployment with no usage service bound, gets its cost stamped on
  the run directly (`AgentRunRepository.stampCostCents`) so the Goal cap
  and the run list still see it. Logged at warn level each time.
- **Codex runs keep `costCents` NULL.** No usage row is written when the
  CLI reported no price (a zero-cost row would settle `costCents = 0`
  and read as free); tokens are still added to the run.

## Known gaps / follow-ups

- Fleet **dispatch** does not consult `AgentBudget` before enqueueing
  (it never did; the cloud worker's `AgentRunService.execute` is the
  only caller of `checkBudget`). Fleet runs are bounded by the daily
  ceilings; the per-Agent cap trips the _next_ cloud run once fleet
  spend has accumulated. Wiring the precheck into
  `FleetRunRouterService` is a separate slice.
- Codex pricing: once a price table exists, the node can fill
  `costUsd` for Codex and the fail-closed drain on Codex-only nodes goes
  away without any platform change.
- The runner-status popover shows the identity through
  `FleetRunnerNodeView.modelIdentity`; the sidebar component itself was
  not restyled in this slice.

## Files

Contracts `packages/contracts/src/fleet/{fleet-jobs,fleet-node,fleet-runner-status}.types.ts`;
node `apps/node/src/core/{executors/model-cli,telemetry-probe,capabilities,runtime,fleet-client}.ts`;
agent `packages/agent/src/{entities/fleet-node,entities/fleet-job,entities/fleet-cost-policy}.entity.ts`,
`packages/agent/src/fleet/{fleet-cost-ceiling.service,fleet-cost-ceiling.shared,fleet-cost-policy.repository,fleet-node.repository,fleet-job.repository,fleet.service,fleet.module}.ts`,
`packages/agent/src/agents/agent-run.service.ts`,
`packages/agent/src/database/repositories/plugin-usage.repository.ts`,
`packages/agent/src/subscriptions/credits/run-cost-settlement.service.ts`,
`packages/agent/src/config/index.ts`;
API `apps/api/src/fleet/{fleet-agent-task-reconciler.service,fleet.controller,fleet-runner-status.service,dto/fleet.dto}.ts`,
`apps/api/src/tasks/tasks.module.ts`,
`apps/api/src/migrations/1788300000000-AddFleetCostAccounting.ts`;
web `apps/web/src/components/settings/{FleetSettings,FleetNodeDrawer,FleetCostCeiling}.tsx`,
`apps/web/src/components/settings/fleet-cost-ceiling.shared.ts`,
`apps/web/src/lib/api/fleet.ts`, `apps/web/src/app/actions/settings/fleet.ts`,
`apps/web/messages/*.json`.

## Adversarial review fixes (same branch, before merge)

- **USD → cents rounding.** `fleetModelCostUsdToCents` snaps the product
  to a micro-cent before `Math.round`: `1.005 * 100` is
  `100.49999999999999` in IEEE-754 and the bare round billed 100 cents for
  a run the CLI priced at $1.005 (likewise `0.285 → 28`, `0.145 → 14`).
  The decimal the CLI printed now decides the cent. Pinned in the
  contracts spec.
- **Codex token total double-counted the cache.** OpenAI usage reports
  `cached_input_tokens` as a SUBSET of `input_tokens`; the node summed all
  buckets, so a Codex run's `totalTokens` was input + cache + output.
  Codex totals are now input + output; Claude Code (whose `input_tokens`
  EXCLUDES cache traffic) is unchanged.
- **Identity probe lost the Claude seat on stderr noise.** The probe fed
  `stdout + stderr` to `JSON.parse`; a deprecation warning on stderr next
  to a valid `claude auth status --json` document made the seat
  unparseable and fell through to codex. stdout is parsed on its own
  first.
- **Server-side scrub of the identity label.** The daemon whitelists what
  it sends, but the wire is untrusted and the label is stored, listed,
  frozen into every run's usage metadata and quoted in notices.
  `FleetService` now runs it through `redactSecrets` (defence in depth)
  before storing it.
- **Silent re-drain after a raised ceiling.** The one-notice marker
  (`fleet_nodes.dailyCostTrippedOn`, `fleet_cost_policies.trippedOn`) was
  keyed by day only, so an owner who raised the ceiling after a trip and
  crossed the NEW ceiling later the same day got a drain with no notice.
  Changing a ceiling (per-node or fleet-wide) now clears its marker; the
  next crossing files a fresh notice. Repeat crossings of an UNCHANGED
  ceiling stay quiet as before. Re-enabling a node without raising the
  ceiling still re-drains it silently on the next completion — the notice
  body already says to raise the ceiling first; resetting the marker on
  re-enable is a possible follow-up.
- **Repository integration spec** (`fleet-cost-accounting.repository.integration.spec.ts`,
  better-sqlite3): the daily sums (Date bound, midnight inclusive, NULL
  cost counts as nothing, running jobs excluded, owner isolation), the
  two-step per-node CAS and the fleet-wide CAS + re-arm on a real engine.

Not changed, flagged for the founder / follow-up:

- A ceiling LOOKUP failure (the policy or node read throws) drains the
  reporting node even when no ceiling is configured at all — the
  conservative reading of "fail closed", but a transient DB blip now
  costs a manual re-enable. Draining and the notice both need the same
  database, so in the common outage both fail together and nothing
  happens; a partial outage is where this bites.
- The reconciler's replay guard is the RUN's terminal status. A
  completion event replayed while the run is still `running` (the first
  reconcile died between `accountModelSpend` and the terminal CAS) would
  record the usage row and `addTokens` twice; `requestId = job id` on the
  usage row is the forensic handle if that ever needs a dedupe.
- The ceiling clock is `new Date()` at evaluation, not the job's
  `completedAt`; a completion straddling midnight UTC by the reconcile
  latency is counted on the day it completed but evaluated on the next.
  The sums have no upper bound, so nothing is ever lost — only the
  boundary case is a beat late.
