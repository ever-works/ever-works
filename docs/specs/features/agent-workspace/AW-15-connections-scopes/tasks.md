# Task Breakdown: Connections, scope presets, per-agent grants and the vault

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and
> ships with tests per **Constitution VI**. Every schema task ships its migration in the same PR
> per **Constitution V**.

**Epic ID**: `AW-15-connections-scopes`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to
  guess a path.
- "Done" is stated explicitly for every task and is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of
  each phase.

---

# Phase P1 — The registry

*Delivers spec FR-1…FR-15 and FR-26…FR-34: multiple accounts per provider, labels, primary,
two-level presets, scheduled health, reconnect.*

## P1.1 — Contracts and entity

- [ ] **T1. Connection contracts.**
  **Create** `packages/contracts/src/connections/connection.types.ts` with `ConnectionKind`,
  `ConnectionBackingKind`, `ConnectionScopePresetId`, `ConnectionHealth`, `ConnectionDto`,
  `ConnectionGroupDto`, `ConnectionProviderDto`, and the constants
  `CONNECTION_LABEL_MAX = 60`, `CONNECTIONS_PER_PROVIDER_MAX = 10`,
  `CONNECTIONS_PER_WORKSPACE_MAX = 100`, `CONNECTION_ACCESS_ORDER = ['blocked','read','write']`.
  **Create** `packages/contracts/src/connections/index.ts`; **modify**
  `packages/contracts/src/index.ts` to re-export it.
  **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations and
  `import { ConnectionDto } from '@ever-works/contracts'` resolves from `apps/api`.

- [ ] **T2. `Connection` entity.**
  **Create** `packages/agent/src/entities/connection.entity.ts` exactly as specified in
  [plan §3.1](./plan.md) — including `labelNormalized`, `healthCheckInFlightAt`,
  `healthFailureCount`, `lastErrorCode`, `lastErrorMessage`, `lastUsedAt`, `lastUsedRunId`,
  `toolCount`, and the `tenantId`/`organizationId` scope columns with **no** `@ManyToOne`
  (entities import cycle — see the note in `packages/agent/src/entities/user.entity.ts`).
  Use `@PortableDateColumn` for every date, never `type: 'timestamp'`.
  **Modify** `packages/agent/src/entities/index.ts` to export it.
  **Test**: `packages/agent/src/entities/__tests__/connection.entity.spec.ts` — asserts the five
  index names, that every date column is portable, and that both scope columns exist so
  [`apps/api/src/scope/scope-stamping.subscriber.ts`](../../../../../apps/api/src/scope/scope-stamping.subscriber.ts)
  will stamp it.

- [ ] **T3. Migration + backfill.**
  **Create** `apps/api/src/migrations/1789200000000-AddConnectionRegistry.ts`.
  `up()`: `CREATE TABLE connections` with all five indexes, then the three idempotent backfill
  statements from [plan §3.7](./plan.md) (MCP servers, plugin-prefixed `account` rows,
  `repo_connections`), each guarded by `WHERE NOT EXISTS`, ordering by `createdAt` for the
  primary choice, suffixing ` 2`/` 3` on label collision **before** the unique index is created,
  and writing `scopePreset='write'`, `health='unknown'`.
  `down()`: `DROP TABLE connections` only.
  Generate with `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddConnectionRegistry`, then hand-write the backfill into the generated file.
  **Done when**: a fresh DB and a DB with existing MCP/OAuth/repo rows both migrate cleanly, the
  migration is re-runnable with zero additional inserts, and no statement is a `DROP` or a
  rename.

## P1.2 — Scope presets as a plugin capability

- [ ] **T4** *(parallel with T3)*. **New plugin capability.**
  **Create** `packages/plugin/src/contracts/capabilities/connection-scopes.interface.ts` with
  `ConnectionScopePresetId`, `ConnectionScopePreset`, `IConnectionScopesPlugin`, and
  `isConnectionScopesPlugin`, per [plan §7.1](./plan.md).
  **Modify** `packages/plugin/src/contracts/capabilities/index.ts` to `export * from
  './connection-scopes.interface.js';` (note the `.js` suffix — the file uses ESM specifiers).
  **Test**: `packages/plugin/src/contracts/__tests__/connection-scopes.spec.ts` (Vitest) — the
  type guard is true only when `capabilities` includes `'connection-scopes'`.
  **Done when**: `pnpm --filter @ever-works/plugin build && pnpm --filter @ever-works/plugin test`
  is green and no existing capability export moved.

- [ ] **T5. Scope facade.**
  **Create** `packages/agent/src/facades/connection-scopes.facade.ts` exposing
  `getPresets(providerId)`, `coversTool(providerId, preset, toolName)` and
  `providerScopesFor(providerId, preset)`; `getPresets` returns `[]` for a provider that does not
  declare the capability. `coversTool` MUST delegate to `matchesAnyToolPattern` from
  [`packages/contracts/src/policy/tool-grant.types.ts`](../../../../../packages/contracts/src/policy/tool-grant.types.ts)
  so pattern semantics cannot drift from the tool-grant matrix.
  **Modify** `packages/agent/src/facades/facades.module.ts` (register the provider) and
  `packages/agent/src/facades/index.ts` (export it).
  **Test**: `packages/agent/src/facades/__tests__/connection-scopes.facade.spec.ts` with a mock
  plugin — declared presets, undeclared → `[]`, pattern identity with the tool-grant matcher.

- [ ] **T6** *(parallel with T5)*. **Declare presets on the git-provider plugin.**
  **Modify** `packages/plugins/github/src/github.plugin.ts` to add `'connection-scopes'` to its
  `capabilities` array and implement `getConnectionScopePresets()` returning the `read` and
  `write` presets with their provider scope strings and tool patterns.
  **Test**: `packages/plugins/github/src/github.connection-scopes.spec.ts` (Vitest) — both preset
  ids present, `read.toolPatterns` contains no pattern that matches a mutating tool name, and
  `write.providerScopes` is a strict superset of `read.providerScopes`.
  **Done when**: `pnpm --filter @ever-works/plugin-github test` is green. **No provider scope
  string appears anywhere outside this package.**

## P1.3 — Registry service

- [ ] **T7. Repository.**
  **Create** `packages/agent/src/database/repositories/connection.repository.ts` next to the
  existing [`mcp-server-connection.repository.ts`](../../../../../packages/agent/src/database/repositories/mcp-server-connection.repository.ts).
  Methods: `listForUser`, `findById`, `findByBacking`, `countForProvider`, `countForUser`,
  `create`, `update`, `remove`, `setPrimaryTransactional(userId, providerId, connectionId)`
  (the two-statement transaction from [plan §3.1](./plan.md)), `claimDueForHealth(limit)`
  (the `FOR UPDATE SKIP LOCKED` CAS from [plan §6](./plan.md)), `stampHealth`, `stampLastUsed`.
  **Modify** the repositories barrel to export it.
  **Test**: `packages/agent/src/database/repositories/connection.repository.spec.ts`.

- [ ] **T8. Registry service.**
  **Create** `packages/agent/src/connections/connection-registry.service.ts`,
  `packages/agent/src/connections/connections.module.ts`,
  `packages/agent/src/connections/index.ts`.
  Enforces: label 1–60 and case-insensitively unique per `(userId, providerId)`
  (`label_taken`), 10 per provider (`provider_limit_reached`), 100 per workspace
  (`connection_limit_reached`), exactly one primary, primary promotion on delete (oldest
  `healthy`, else oldest), cross-user reads return **not-found**, and preset changes that need
  wider provider scopes throw `preset_requires_reapproval` carrying the re-approval URL.
  Emits the activity-log entries from [plan §9.1](./plan.md) with `{ connectionId, label,
  providerId, field }` and **never a value**.
  **Modify** `packages/agent/src/index.ts` / the agent package's `package.json` `exports` map to
  add the `./connections` subpath, matching how `./mcp` is exported today.
  **Test**: `packages/agent/src/connections/__tests__/connection-registry.service.spec.ts`
  covering every rule above plus the primary-promotion message.

- [ ] **T9. Connection-scoped provider ids for extra OAuth accounts.**
  **Modify** [`packages/agent/src/database/repositories/auth-account.repository.ts`](../../../../../packages/agent/src/database/repositories/auth-account.repository.ts):
  add `buildPluginConnectionProviderId(pluginId, connectionId)` returning
  `` `${PLUGIN_PROVIDER_PREFIX}${pluginId}#${connectionId}` `` and prepend that form to the
  candidate list inside `findConnectedProviderAccount` when a `connectionId` is supplied.
  **Do not touch** the `@Index(['userId','providerId'], { unique: true })` on
  [`auth-account.entity.ts`](../../../../../packages/agent/src/entities/auth-account.entity.ts)
  and **do not add a migration** — see [plan §2.5](./plan.md).
  **Test**: extend `packages/agent/src/database/repositories/auth-account.repository.spec.ts` —
  the connection-scoped id resolves first, the bare plugin id still resolves for legacy rows,
  and a social-login row is never returned for a plugin lookup.

## P1.4 — Health

- [ ] **T10. Health classifier (pure).**
  **Create** `packages/agent/src/connections/connection-health.ts`: `classifyProbeResult(...)`
  → `{ health, errorCode, errorMessage, failureCount }`, plus the fixed error-message catalogue.
  A credential rejection goes straight to `expired`; otherwise 1–2 failures → `degraded`,
  ≥ 3 → `unreachable`; success resets to `healthy` with `failureCount = 0`. The raw provider
  body is **never** returned.
  **Test**: `packages/agent/src/connections/__tests__/connection-health.spec.ts`.

- [ ] **T11. Health service.**
  **Create** `packages/agent/src/connections/connection-health.service.ts` with
  `probe(connectionId)` dispatching by `kind` to the **existing** probes ([plan §6](./plan.md)):
  `OAuthFacadeService.getAuthenticatedUser` for `oauth`,
  `McpConnectionsService.test` for `mcp`, `PluginValidationService` for `api_key`, the repo
  credential check for `repo`. Timeout **8 s**. Writes health via the repository, emits
  `connection_health_changed` only on a transition, and raises a notification through the
  existing notification preferences.
  **Test**: `packages/agent/src/connections/__tests__/connection-health.service.spec.ts` — each
  kind routes to its probe, timeout is honoured, no transition ⇒ no activity-log row, no probe
  result ever reaches the log with a token in it.

- [ ] **T12. Health dispatcher port + service.**
  **Create** `packages/agent/src/connections/connection-health-dispatcher.ts` — a **type-only
  leaf file** exporting `CONNECTION_HEALTH_DISPATCHER`, `ConnectionHealthDispatchPayload` and
  `ConnectionHealthDispatcher`, modelled on
  [`packages/agent/src/tasks-domain/task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts).
  **Create** `packages/agent/src/connections/connection-health-dispatcher.service.ts` with
  `dispatchDue()`: claim ≤ 200 due rows via `claimDueForHealth`, enqueue one payload each
  through the `@Optional() @Inject(CONNECTION_HEALTH_DISPATCHER)` port.
  **Constitution IV**: this file must **not** import `@trigger.dev/sdk`.
  **Test**: `packages/agent/src/connections/__tests__/connection-health-dispatcher.service.spec.ts`
  — per-kind due intervals (60/30/360 min), the 200 cap, in-flight claim, and two concurrent
  ticks producing disjoint sets.

- [ ] **T13. Scheduled task + probe task.**
  **Create** `packages/tasks/src/tasks/trigger/connection-health-dispatcher.task.ts` —
  `schedules.task({ id: 'connection-health-dispatcher', cron: '*/15 * * * *' })`, booting
  `TriggerInternalModule` exactly like
  [`agent-heartbeat-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts).
  **Create** `packages/tasks/src/tasks/trigger/connection-health-probe.task.ts` — one probe,
  returning `{ ok: false, error }` rather than throwing.
  **Modify** `packages/tasks/src/tasks/trigger/index.ts` to register both.
  **Done when**: `pnpm --filter @ever-works/tasks build` is green and the dispatcher binding is
  provided in the API's Trigger adapter module.

## P1.5 — API

- [ ] **T14. Registry controller + module.**
  **Create** `apps/api/src/connections/connections.controller.ts`,
  `apps/api/src/connections/connections.module.ts`, and
  `apps/api/src/connections/dto/connection.dto.ts` (`UpdateConnectionDto`,
  `CreateConnectUrlDto`) with class-validator decorators.
  Endpoints exactly as in [plan §4.1](./plan.md), with `@ApiTags`/`@ApiOperation`/`@ApiResponse`
  and the `@Throttle` tiers listed there (`check` is **6/min**).
  **Modify** `apps/api/src/api.module.ts` to import `ConnectionsModule`.
  **Test**: `apps/api/src/connections/connections.controller.spec.ts`, following
  [`apps/api/src/mcp-connections/mcp-connections.controller.spec.ts`](../../../../../apps/api/src/mcp-connections/mcp-connections.controller.spec.ts):
  auth guard present, cross-user is `404` not `403`, throttle decorators present, DTO validation
  rejects a 61-char label, and no response body contains a token field.

## P1.6 — Web

- [ ] **T15. API client + server actions.**
  **Create** `apps/web/src/lib/api/connections.ts` (server-only `serverFetch`, `X-Scope-Slug`
  attached) mirroring
  [`apps/web/src/lib/api/mcp-connections.ts`](../../../../../apps/web/src/lib/api/mcp-connections.ts),
  and `apps/web/src/app/actions/connections.ts` mirroring
  [`apps/web/src/app/actions/mcp-connections.ts`](../../../../../apps/web/src/app/actions/mcp-connections.ts).
  **Modify** `apps/web/src/lib/constants.ts` to add the route constants.

- [ ] **T16. Registry UI.**
  **Create** under `apps/web/src/components/settings/connections/`:
  `ConnectionsClient.tsx`, `ConnectionGroup.tsx`, `ConnectionRow.tsx`,
  `ConnectionHealthPill.tsx`, `ConnectionManageDrawer.tsx`, `ConnectionPresetChooser.tsx`,
  `ConnectionsEmptyState.tsx`.
  **Modify** [`apps/web/src/app/[locale]/(dashboard)/settings/connections/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/connections/page.tsx>)
  to render `ConnectionsClient` with four tabs, where the **MCP servers** tab renders the
  existing [`McpConnectionsClient`](../../../../../apps/web/src/components/settings/McpConnectionsClient.tsx)
  **unchanged** (import it, do not fork it).
  Implement every state in [spec §7.1–§7.4](./spec.md): loading skeleton (no spinner, no layout
  jump), empty, list error, provider-full, attention banner, and the keyboard map
  (`↑`/`↓`/`Enter`/`r`/`p`/`c`/`/`/`Esc`).
  The preset chooser is **never optimistic** (widening may be refused).
  **Test**: `apps/web/src/components/settings/connections/ConnectionsClient.unit.spec.tsx`.

- [ ] **T17. i18n — P1 keys.**
  **Modify** [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json): add the
  `dashboard.settings.connections` sub-objects `tabs`, `mcpTab`, `add`, `health`, `preset`,
  `banner`, `limits`, `errors`, `empty`, plus `accountsOfMax`, `primary`, `makePrimary`,
  `rename`, `manage`, `reconnect`, `checkNow`, `disconnect`, `disconnectHint`, `lastUsed`,
  `neverUsed`, `seeRuns`. Change the **value** (never the key) of
  `dashboard.settings.connections.subtitle` to
  `"Accounts your agents can use, and exactly what each one may do."` and move the old sentence
  to `mcpTab.subtitle`. Do not touch any existing `…connections.form.*` key.
  Mirror the same key set into all 20 sibling locale files in `apps/web/messages/`.
  **Every leaf key name is camelCase and contains no literal `.`.**
  **Done when**: no user-visible literal remains in any component from T16, and
  `pnpm --filter ever-works-web lint` is green.

- [ ] **T18. E2E — registry, presets, health.**
  **Create** `apps/web/e2e/flow-connections-registry.spec.ts`,
  `apps/web/e2e/flow-connection-presets.spec.ts`,
  `apps/web/e2e/flow-connection-health-reconnect.spec.ts` per [plan §10.3](./plan.md).
  **Done when**: all three pass locally and in CI.

- [ ] **T19. P1 ship gate.**
  Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
  **Done when**: green, the migration applies to a copy of a real database, and the existing
  MCP settings screen, repository registry and per-plugin settings pages are visibly unchanged.

---

# Phase P2 — Grants and per-call enforcement

*Delivers spec FR-16…FR-25 and FR-35…FR-38.*

## P2.1 — Data model

- [ ] **T20. Grant + usage entities and contracts.**
  **Create** `packages/agent/src/entities/connection-grant.entity.ts` and
  `packages/agent/src/entities/connection-run-usage.entity.ts` per
  [plan §3.2–§3.3](./plan.md); **modify** `packages/agent/src/entities/index.ts`.
  **Create** `packages/contracts/src/connections/grant.types.ts` with `ConnectionGrantMode`,
  `ConnectionGrantDto` (`requested` / `effective` / `clampedBy`) and export it from the
  connections barrel.
  **Note**: `connection_run_usage` deliberately has **no** FK to `connections` — Runs keep their
  history when a Connection is deleted (FR-38). Record that in the entity doc-comment.
  **Test**: `packages/agent/src/entities/__tests__/connection-grant.entity.spec.ts` — the unique
  index has no nullable member (`targetId` is the owning `userId` for `workspace` rows).

- [ ] **T21. Migration.**
  **Create** `apps/api/src/migrations/1789210000000-AddConnectionGrantsAndUsage.ts`:
  `CREATE TABLE connection_grants` (+ FK `connectionId → connections(id) ON DELETE CASCADE`,
  + its three indexes), `CREATE TABLE connection_run_usage` (+ its two indexes),
  `ALTER TABLE plugin_usage_events ADD COLUMN "connectionId" uuid NULL` +
  `idx_plugin_usage_connection`.
  `down()` drops exactly what `up()` created.
  **Done when**: additive only — no `DROP COLUMN`, no rename, no type change.

## P2.2 — The resolution ladder

- [ ] **T22. Pure ladder.**
  **Create** `packages/agent/src/connections/connection-access.ts` — side-effect free, mirroring
  the structure of [`packages/agent/src/policy/tool-grant.ts`](../../../../../packages/agent/src/policy/tool-grant.ts):
  `resolveConnectionAccess(ceiling, workspaceGrant, agentGrant)` →
  `{ effective, requested, clampedBy }` computed as `min` over `blocked < read < write`;
  absence of a row means `inherit`; a grant above its ceiling is **stored as written and reported
  as clamped**, never rejected (FR-19).
  **Test**: `packages/agent/src/connections/__tests__/connection-access.spec.ts` — the full
  3×4×4 truth table, never-widen, clamping, and un-clamping when the ceiling rises.

- [ ] **T23. Enforcer port + service + cache.**
  **Create** `packages/agent/src/connections/connection-access.enforcer.ts` — a **type-only leaf
  file** exporting `CONNECTION_ACCESS_ENFORCER`, `ConnectionAccessResolveInput` and
  `ConnectionAccessEnforcer { resolve(input), decide(input, toolName) }`, modelled exactly on
  [`packages/agent/src/policy/tool-grant.enforcer.ts`](../../../../../packages/agent/src/policy/tool-grant.enforcer.ts).
  **Create** `packages/agent/src/connections/connection-access.service.ts` implementing it, with
  the process-local cache (`MAX_AGE_MS = 5_000`, keyed by `userId`, evicted immediately on any
  grant or registry write in the same process — [plan §2.4](./plan.md)).
  `decide()` maps a tool name to its Connection: `mcp__<server>__*` → the MCP Connection whose
  label is `<server>`; otherwise the provider's primary (or the Connection the call names)
  through the scope facade's `coversTool`.
  On lookup failure: return the **Connection's own preset**, warn-log, never `write` (FR-24).
  **Modify** `packages/agent/src/connections/connections.module.ts` to bind the token.
  **Test**: `packages/agent/src/connections/__tests__/connection-access.service.spec.ts` — cache
  max-age, immediate in-process eviction, tool→connection mapping for MCP and non-MCP names, and
  the degrade-to-ceiling path.

- [ ] **T24. Grant service + repository.**
  **Create** `packages/agent/src/connections/connection-grant.repository.ts` and
  `packages/agent/src/connections/connection-grants.service.ts`:
  `getForConnection`, `setGrant` (upsert on the unique index), `clearGrant` (delete = revert to
  inherit), `listForAgent`. Every write evicts the access cache and emits
  `connection_grant_set` / `connection_grant_cleared`.
  **Test**: `packages/agent/src/connections/__tests__/connection-grants.service.spec.ts` — one
  row per `(connection, target)` under a concurrent double-write, `clearGrant` on a missing row
  is a no-op success, cross-user is not-found.

## P2.3 — Wiring into the run loop

- [ ] **T25. Run-assembly filter (FR-23).**
  **Modify** [`packages/agent/src/agents/agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts):
  inject `@Optional() @Inject(CONNECTION_ACCESS_ENFORCER)`; inside `resolveGrantedTools`
  (line ~661), **after** the existing tool-grant partition, drop every descriptor whose
  Connection resolves to `blocked` or whose name the effective preset does not cover, adding the
  dropped names to the returned `refused` array so the existing WARN logging explains them.
  Unbound enforcer ⇒ the descriptor list is byte-identical to today's.
  **Test**: `packages/agent/src/agents/__tests__/agent-tool.connection-gate.spec.ts`.

- [ ] **T26. Per-invocation gate (FR-20/21/22).**
  **Modify** [`packages/agent/src/agents/agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts):
  in `invokeTool` (line 1219), **between** `const descriptor = descriptorByName.get(call.name)`
  and `await descriptor.invoke(...)`, call
  `await this.connectionAccess?.decide({ userId, agentId, … }, call.name)`. A refusal returns
  `{ error: 'Blocked by connection access — <label>' }` in the same shape as the existing
  "not in the allow-list" branch, appends **one** `WARN` `agent_run_logs` row with
  `{ toolName, connectionId, connectionLabel, reason }`, and the Run continues.
  **The refusal happens before any outbound request is made.**
  **Test**: extend `packages/agent/src/agents/__tests__/agent-run.service.*.spec.ts` — a grant
  written mid-Run refuses the next call, the Run does not fail, and the log row appears exactly
  once per refusal.

- [ ] **T27. Usage buffer and last-used (FR-35/36/37).**
  **Create** `packages/agent/src/connections/connection-usage-buffer.ts` — accumulates
  `(connectionId, runId, agentId, label)` and flushes on **10 s**, **100 calls**, or run
  teardown; each flush upserts `connection_run_usage` and updates
  `connections.lastUsedAt`/`lastUsedRunId`.
  **Modify** `agent-run.service.ts` to record a hit after a successful invoke and to flush on
  every run-exit path (the same paths that already call `releaseMcpRun`).
  **Modify** [`packages/agent/src/mcp/mcp-tool-source.ts`](../../../../../packages/agent/src/mcp/mcp-tool-source.ts)
  `recordInvocation` to also set `connectionId` on the `plugin_usage_events` row it already
  writes (additive; leave the existing `workId` guard exactly as it is).
  **Test**: `packages/agent/src/connections/__tests__/connection-usage-buffer.spec.ts`.

- [ ] **T28. Usage retention.**
  **Modify** [`apps/api/src/budgets/plugin-usage-cleanup.service.ts`](../../../../../apps/api/src/budgets/plugin-usage-cleanup.service.ts)
  to prune `connection_run_usage` rows older than the same 12-month window, inside the same
  distributed-lock-guarded daily cron. No new cron.
  **Test**: extend that service's existing spec.

## P2.4 — API and web

- [ ] **T29. Grants controller.**
  **Create** `apps/api/src/connections/connection-grants.controller.ts` and
  `apps/api/src/connections/dto/connection-grant.dto.ts` (`SetConnectionGrantDto`,
  `mode` is `@IsIn(['read','write','blocked'])` — `inherit` is expressed by `DELETE` only).
  Endpoints per [plan §4.2](./plan.md), including
  `GET /api/agents/:agentId/connections` and `GET /api/connections/:id/runs`.
  **Modify** `apps/api/src/connections/connections.module.ts`.
  **Test**: `apps/api/src/connections/connection-grants.controller.spec.ts` — the response always
  carries `requested`, `effective` and `clampedBy`; a widening `PUT` returns `200` with a clamped
  `effective`, never a `4xx`.

- [ ] **T30. Manage-drawer agent access + per-agent tab.**
  **Create** `apps/web/src/components/settings/connections/ConnectionAgentAccessList.tsx` and
  `apps/web/src/components/agents/AgentConnectionsClient.tsx`.
  **Create** `apps/web/src/app/[locale]/(dashboard)/agents/[id]/connections/page.tsx` following
  the shape of the existing
  [`agents/[id]/mcp-servers/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/mcp-servers/page.tsx>)
  (server component, `agentsAPI.get` + `notFound()`, no `generateMetadata`).
  **Modify** [`AgentMcpServersClient.tsx`](../../../../../apps/web/src/components/agents/AgentMcpServersClient.tsx)
  to add a "See all connections for this agent →" link. **Do not remove or redirect the
  `mcp-servers` route.**
  Render the clamped state, the blocked hint, and the "Changes apply on each agent's next call.
  Nothing restarts." line from [spec §7.3/§7.8](./spec.md).

- [ ] **T31. i18n — P2 keys.**
  **Modify** `apps/web/messages/en.json`: add `dashboard.settings.connections.agentAccess.*`
  and the whole `dashboard.agents.connections` namespace; mirror into the 20 locale files.
  camelCase leaves, no literal dot.

- [ ] **T32. E2E — grants and attribution.**
  **Create** `apps/web/e2e/flow-connection-agent-grants.spec.ts` and
  `apps/web/e2e/flow-connection-last-used-runs.spec.ts` per [plan §10.3](./plan.md).

- [ ] **T33. P2 ship gate.**
  `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
  Additionally: run the agent test suite with `CONNECTION_ACCESS_ENFORCER` deliberately unbound
  and confirm **zero** behavioural diffs, and add a benchmark assertion that `decide()` adds
  ≤ 2 ms P95 to an invocation.

---

# Phase P3 — Vault and MCP onboarding

*Delivers spec FR-39…FR-58.*

## P3.1 — Vault

- [ ] **T34. Vault entity, contracts, migration.**
  **Create** `packages/agent/src/entities/vault-secret.entity.ts` per [plan §3.4](./plan.md),
  using `EncryptedJsonColumn` from
  [`packages/agent/src/entities/_secret-json-column.ts`](../../../../../packages/agent/src/entities/_secret-json-column.ts);
  **modify** `packages/agent/src/entities/index.ts`.
  **Create** `packages/contracts/src/connections/vault.types.ts` with `VaultSecretDto` whose
  `value` field is the **literal type** `'●●●●●●●●'` (a real secret then fails to type-check).
  **Create** `apps/api/src/migrations/1789220000000-AddVaultAndMcpInteractiveAuth.ts`:
  `CREATE TABLE vault_secrets` (+ two indexes) and
  `ALTER TABLE mcp_server_connections ADD "authMode" varchar(16) NOT NULL DEFAULT 'header',
  ADD "oauthTokens" text NULL, ADD "oauthMetadata" text NULL`.
  **Modify** [`packages/agent/src/entities/mcp-server-connection.entity.ts`](../../../../../packages/agent/src/entities/mcp-server-connection.entity.ts)
  to add the three matching columns (`oauthTokens` as an `EncryptedJsonColumn`).

- [ ] **T35. Vault service.**
  **Create** `packages/agent/src/vault/vault.service.ts`, `vault.repository.ts`,
  `vault.module.ts`, `index.ts`.
  Enforces `VAULT_KEY_PATTERN`, the 200-entry cap, the 8 KB value cap, replace-and-delete-only
  semantics, `referenceCount` maintenance, and `lastUsedAt` stamping.
  **There is no `getValue` method on this service.** The only decrypt path is T36.
  Emits `vault_secret_created` / `_rotated` / `_deleted` with the key name, never the value.
  Refuses **writes** when `PLUGIN_SECRET_ENCRYPTION_KEY` is unset (this path opts out of the
  dev plaintext-passthrough fallback — [plan §9.3](./plan.md)).
  **Test**: `packages/agent/src/vault/__tests__/vault.service.spec.ts`.

- [ ] **T36. Vault-backed credential resolver.**
  **Create** `packages/agent/src/vault/vault-credential-resolver.ts` implementing
  `CredentialResolver` from
  [`packages/agent/src/policy/credential-resolver.ts`](../../../../../packages/agent/src/policy/credential-resolver.ts):
  batch `resolve(ctx, keys)`, **omits** keys it cannot supply (never an empty string), never
  logs a value, stamps `lastUsedAt`.
  **Modify** `packages/agent/src/vault/vault.module.ts` to bind it to `CREDENTIAL_RESOLVER`,
  taking precedence over `EnvCredentialResolver` when the vault module is imported.
  **Test**: `packages/agent/src/vault/__tests__/vault-credential-resolver.spec.ts` plus
  `packages/agent/src/vault/__tests__/vault-no-read-path.spec.ts` — a reflective guard asserting
  no exported DTO type and no controller method can return `VaultSecret['secret']`.

- [ ] **T37. Vault API.**
  **Create** `apps/api/src/vault/vault.controller.ts`, `vault.module.ts`,
  `dto/vault-secret.dto.ts` (`CreateVaultSecretDto`, `UpdateVaultSecretDto`;
  `value` is `@IsString() @MaxLength(8192)` and `@Exclude()` on output).
  Endpoints per [plan §4.4](./plan.md). **No** value-read route, no `?reveal`, no export, no
  admin variant.
  **Modify** `apps/api/src/api.module.ts`.
  **Test**: `apps/api/src/vault/vault.controller.spec.ts` — enumerate every route on the
  controller and assert none returns a field derived from the encrypted column.

- [ ] **T38. Vault UI + i18n.**
  **Create** `apps/web/src/components/settings/vault/VaultClient.tsx`,
  `VaultSecretRow.tsx`, `VaultSecretDialog.tsx`;
  `apps/web/src/lib/api/vault.ts`; `apps/web/src/app/actions/vault.ts`.
  **Modify** `ConnectionsClient.tsx` to render it under the `?tab=vault` query param.
  **Modify** `apps/web/messages/en.json` with the `dashboard.settings.vault` namespace and
  mirror into the 20 locale files.
  Implement every state in [spec §7.7](./spec.md): grouped list, masked value, add/replace
  dialog, empty, full, "Not used by any connection".
  **Test**: `apps/web/src/components/settings/vault/VaultClient.unit.spec.tsx`.

## P3.2 — MCP onboarding

- [ ] **T39. Config parser (pure).**
  **Create** `packages/agent/src/connections/mcp-config-parser.ts` per [plan §7.5](./plan.md).
  Reuse `MCP_CONNECTION_NAME_PATTERN` exported from
  [`mcp-server-connection.entity.ts`](../../../../../packages/agent/src/entities/mcp-server-connection.entity.ts)
  — do not restate the regex.
  **Test**: `packages/agent/src/connections/__tests__/mcp-config-parser.spec.ts` with fixtures
  for: trailing comma, markdown fence, `//` comment, bare `"name": { … }` fragment,
  `mcpServers` wrapper, bare URL, 11 servers, 17 KB input, `http://` url, invalid name, and a
  header whose value must be classified as a secret.

- [ ] **T40. Interactive-auth detection and handshake.**
  **Create** `packages/agent/src/connections/mcp-auth-detect.ts` (probe → `header` /
  `interactive` / `unknown`) and
  `packages/agent/src/connections/mcp-authorize.service.ts` (metadata discovery, dynamic client
  registration with a configured-client fallback, authorization-code + PKCE, signed single-use
  `state` bound to `(connectionId, userId)` with a **10-minute** TTL, token storage in
  `mcp_server_connections.oauthTokens`, silent refresh on `401`, refresh failure ⇒ Connection
  `expired`).
  **Every** request in this flow goes through
  [`packages/agent/src/mcp/guarded-fetch.ts`](../../../../../packages/agent/src/mcp/guarded-fetch.ts).
  **No server-specific branch may exist in either file.**
  **Test**: `packages/agent/src/connections/__tests__/mcp-auth-detect.spec.ts` and
  `.../mcp-authorize.service.spec.ts` — state is single-use, an expired state is a `400` that
  reveals nothing, a metadata document pointing at a private address is refused.

- [ ] **T41. MCP onboarding controller.**
  **Create** `apps/api/src/connections/mcp-onboarding.controller.ts` and
  `apps/api/src/connections/dto/mcp-onboarding.dto.ts` (`ParseMcpConfigDto` with
  `@MaxLength(16384)`, `CreateMcpConnectionFromParseDto` with `@ArrayMaxSize(10)`).
  Endpoints per [plan §4.3](./plan.md). `POST /api/connections/mcp` moves header values into the
  Vault **first** and stores only `{{cred.key}}` references, then delegates row creation to the
  existing `McpConnectionsService.create` so the tenant-inherit binding, name pattern and SSRF
  guard all still apply.
  `GET /api/connections/mcp/callback` is the **only** new `@Public()` endpoint; document the
  justification in a doc-comment above it.
  Name-collision check spans installed plugin ids **and** existing Connection labels; on
  collision nothing is persisted, including the pasted secret.
  **Test**: `apps/api/src/connections/mcp-onboarding.controller.spec.ts` — parse persists
  nothing; collision persists nothing; duplicate URL returns the existing Connection id;
  callback rejects an unknown state.

- [ ] **T42. MCP wizard UI + i18n.**
  **Create** `apps/web/src/components/settings/connections/AddMcpServerDialog.tsx` and
  `McpAuthorizeCard.tsx` implementing every state in [spec §7.5–§7.6](./spec.md): paste,
  reading preview, detected-interactive, waiting (with the countdown), connected (tool names),
  timed out, name collision, duplicate URL, unparseable, address refused.
  Poll `…/authorize/status` on a client `setInterval(3000)`, cleared on unmount, terminal state,
  and at 10 minutes.
  **Modify** `apps/web/messages/en.json` with `dashboard.settings.connections.mcpWizard.*` and
  mirror into the 20 locale files.

- [ ] **T43. Presets on the connector plugins.**
  **Modify** each of the 11 packages under `packages/plugins/*-connector/` to declare
  `'connection-scopes'` and implement `getConnectionScopePresets()`.
  **Test**: one Vitest spec per package asserting both preset ids and
  `write.providerScopes ⊇ read.providerScopes`.
  **Done when**: no provider scope string exists outside its own plugin package.

- [ ] **T44. E2E — vault and MCP onboarding.**
  **Create** `apps/web/e2e/flow-vault-write-only.spec.ts` (asserting **no** network response
  body in the Playwright trace contains the plaintext), `apps/web/e2e/flow-mcp-add-server.spec.ts`
  and `apps/web/e2e/flow-mcp-interactive-signin.spec.ts` per [plan §10.3](./plan.md).

---

# Phase P4 — Documentation and rollout

- [ ] **T45. User-facing docs.**
  **Create** `docs/features/connections-and-scopes.md` covering the registry, presets, per-agent
  access, health, the vault and adding an MCP server.
  **Modify** `docs/features/index.md` and `apps/docs/sidebarsPlatform.ts` to list it (the sidebar
  is manual — an unlisted file renders only as an orphan page).
  **Done when**: `pnpm --filter ever-works-docs build` reports no broken links.

- [ ] **T46. Program bookkeeping.**
  **Modify** `docs/specs/features/agent-workspace/TRACKER.md` — mark AW-15 spec `Approved` and
  implementation `In Progress` / `Done` as phases land.
  **Modify** [`docs/specs/features/agent-workspace/README.md`](../README.md) §1 vocabulary table
  only if a new noun was actually introduced (it is: **Connection** gains a row, plus **Scope
  preset**, **Connection grant** and **Vault credential** — add all four in the same PR as P1,
  P2 and P3 respectively).
  **Modify** this epic's `spec.md` and `plan.md` status fields to `Implemented` / `Done`.

- [ ] **T47. Final gate.**
  `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`, plus the full
  Playwright suite.
  Walk the [spec §9 acceptance checklist](./spec.md) end to end against a running stack and tick
  every box.

---

## Definition of Done

- Every checkbox above is ticked.
- All three migrations apply forward cleanly on a copy of a real database and are re-runnable
  with no additional writes.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check` and `pnpm test` are green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- The agent suite passes with **both** new enforcer tokens unbound, with zero behavioural diffs
  from `develop` (proving the degradation posture in [plan §9.3](./plan.md)).
- A grep of the repository finds **no** provider scope string outside its own plugin package
  (Constitution II).
- A grep of the diff finds **no** log statement, DTO field, activity-log `details` key or Sentry
  breadcrumb that can carry a credential value (Constitution VII).
- Every constitution gate in [`spec.md` §11](./spec.md) is confirmed satisfied.
