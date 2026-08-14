# Feature F — MCP Connections (manual servers + bindings + tool funnel)

Branch: `session/feat-mcp-connections`. Implements the MCP slice of the merged
`docs/specs/features/agent-plugins/` spec (plan §2.4/§2.5, tasks T23–T27
adapted) plus the founder-added `manual` connection source that works without
the package system (T1–T22 remain out of scope).

## What shipped

- **Manual MCP connection registry** (`mcp_server_connections`): user-global
  rows with `name` (slug-safe, becomes the `mcp__<name>__<tool>` prefix), url,
  transport (`streamable-http` | `sse`; NO stdio per ADR-018), encrypted
  `authHeaders` (`_secret-json-column` envelope), `enabled`, `source`
  (`'manual'` now, `'package'` reserved), `lastConnectedAt`/`lastError` status
  stamps.
- **Per-agent bindings** (`agent_mcp_server_bindings`, per plan §2.5 naming):
  `'tenant'` rows inherit a connection to ALL of the user's agents (created
  enabled=true alongside the connection), `'agent'` rows override per agent
  (narrow-only semantics like tool grants; delete the row to revert to
  inheritance). Unique `(connectionId, targetType, targetId)`.
- **`packages/agent/src/mcp/`** (new module, exported as
  `@ever-works/agent/mcp`):
    - `McpClientService` — official `@modelcontextprotocol/sdk` (^1.27.1, same
      as apps/mcp) behind the `MCP_CLIENT_FACTORY` seam (structural interfaces,
      lazy `import()`; tests inject fakes — no SDK, no network). listTools with
      a 60s TTL cache per connection; callTool with 30s timeout + 100KB
      serialized-result cap; errors classified into short header-free messages
      and stamped on the row. Auth header values never reach logs or errors.
    - `McpConnectionsService` — CRUD + masking (responses carry
      `authHeaderNames` only), name/URL/header validation (lexical SSRF guard
      `isSafeWebhookUrl` on URLs), test endpoint, per-agent binding state +
      effective-connection resolution. Cross-user access → 404.
    - `McpToolSource` — bound connections → `AgentToolDescriptor`s named
      `mcp__<server>__<tool>` (schema passthrough, description prefixed
      `[<server>]`, name/description sanitized, length caps). Dead server →
      zero tools + WARN, never a failed run. Gated on
      `permissions.canCallExternalTools` (outbound-call risk class).
- **Tool funnel integration**: new `AGENT_MCP_TOOL_SOURCE` token
  (`packages/agent/src/agents/agent-mcp-tool-source.ts`), injected
  `@Optional()` APPENDED LAST into `AgentToolService`; consumed inside
  `resolveGrantedTools` (async) BEFORE the grant partition, so
  `mcp__*` names flow through `partitionToolsByGrant` and the run-level
  funnel for free. Built-in name collisions are dropped with a WARN, and
  each accepted descriptor is wrapped in the same
  `withCredentialInterpolation` the built-ins get — MCP servers are the
  outbound calls `{{cred.key}}` exists for, so an unwrapped descriptor
  would forward the literal template text to a third party and scrub
  nothing on the way back. Bound in the api-side @Global `AgentsModule`
  (`useExisting: McpToolSource`) + pin-spec updated.
- **Activity**: additive `ActivityActionType` members
  `mcp_connection_created/updated/deleted/tested`, `mcp_binding_updated`
  (varchar storage — no migration). Emitted from `McpConnectionsService`.
- **Run-log**: no change needed — MCP invocations ride the existing tool-loop
  logging; `toolName` carries the `mcp__` prefix end-to-end.

## Data model / migration

`apps/api/src/migrations/1785100000000-CreateMcpServerConnections.ts` —
portable `Table` API (postgres + better-sqlite3), idempotent guards, both
tables + unique indexes, FKs to `users` (+ bindings → connections CASCADE).
Entities registered in `entities/index.ts`, `_entities-inventory.ts`, and
`_entity-names.ts` (both halves of the two-step registration).

## Endpoints

- `GET/POST /api/mcp-connections`, `GET/PATCH/DELETE /api/mcp-connections/:id`,
  `POST /api/mcp-connections/:id/test` (returns `{ok, toolCount, tools[]}`).
- `GET /api/agents/:agentId/mcp-servers` (connections + effective state incl.
  `inheritedFromTenant`), `PUT /api/agents/:agentId/mcp-servers/:connectionId`
  `{enabled}`, `DELETE …/:connectionId` (revert to inherit).
- Module `apps/api/src/mcp-connections/`, registered in `api.module.ts`.

## UI routes

- **Settings → Connections** (`/settings/connections`): list + add form
  (name/url/transport/one auth header), enable/disable switch, Test (shows
  tool count + first names), delete, last-status line. New tab in
  `settings-layout-client.tsx` (Plug icon).
- **Agent detail → MCP Servers tab** (`/agents/[id]/mcp-servers`): all
  connections with effective toggles, Inherited/Override/Connection-disabled
  badges, Revert-to-inherit. Tab added in `AgentDetailTabs.tsx`; route
  constant `DASHBOARD_AGENT_MCP_SERVERS`.
- i18n keys added to ALL 21 `apps/web/messages/*.json` (English values
  copied per convention).

## Tests

- `packages/agent` (Jest):
  `cd packages/agent && npx jest --testPathPattern='(src/mcp/|agent-tool-mcp-funnel)'`
  — 37 tests. Client cache TTL/timeout/size-cap/error-classification/secret
  masking; binding resolution matrix (tenant-inherit / agent-disable /
  agent-only / disabled-connection); descriptor naming + sanitization +
  executor proxy + dead-server isolation; connections CRUD + masking +
  SSRF + cross-user 404 + test endpoint + per-agent state.
  `agents/__tests__/agent-tool-mcp-funnel.spec.ts` is the FUNNEL half:
  no-source parity, descriptors appended, built-in collision dropped,
  grant-matrix deny of an `mcp__*` name (proves the append happens
  before `partitionToolsByGrant`), a throwing source never failing run
  assembly, and `{{cred.key}}` interpolation reaching MCP args.
  Updated pin spec: `entities/__tests__/activity-log.types.spec.ts`
  (+5 MCP action types).
- `apps/api` (Jest):
  `cd apps/api && npx jest --testPathPattern='(agents.module|mcp-connections|CreateMcpServerConnections)'`
  — pin spec asserts McpModule import + AGENT_MCP_TOOL_SOURCE binding/export;
  controller delegation/auth-scoping pins; the migration spec runs both
  tables' `up`/`down` on better-sqlite3 (columns, indexes, idempotency,
  both unique constraints).

### Verification run on this branch

- `cd packages/agent && npx tsc -p tsconfig.types.json --noEmit` — clean.
- `npx turbo build --filter=@ever-works/agent` — passes.
- `cd packages/agent && npx jest --testPathPattern='(src/mcp/|activity-log.types|portable-date-columns|agent-tool)'`
  — 12 suites / 219 tests green (regression sweep over every
  `agent-tool*` suite, since the funnel changed).
- `cd apps/api && npx jest` — 254 suites / 4030 tests green.
- `cd apps/api && npx tsc --noEmit` — 4 PRE-EXISTING errors unrelated to
  this branch (`@ever-works/k8s-plugin` missing in `deploy.e2e.spec.ts`;
  three `@src/*` alias misses in `packages/agent` sources reached through
  a relative path). None involve MCP files; not fixed here.
- `cd apps/web && npx tsc --noEmit` — clean.
- `cd apps/web && npx eslint <the six new web files>` — clean.
  (`packages/agent` and `apps/api` have no `lint` script and no eslint
  config — `pnpm lint` only reaches `apps/web`.)
- `npx prettier --check` over every touched file — clean (root config
  resolves to `.prettierrc`: 4-space, 100 cols, trailing commas).
- i18n audit: all 10 new key paths present in all 21
  `apps/web/messages/*.json` files, English values copied.

## Decisions & divergences from the brief

- Bindings are consumed in `resolveGrantedTools` (async), not the sync
  `resolveAllowedTools`: descriptor assembly needs I/O and the run path
  (`agent-run.service.ts:1480-1488`) already prefers the async method.
  Sync-only callers (no grant enforcer path) see no MCP tools — acceptable:
  production runs go through `resolveGrantedTools`.
- Creating a connection auto-creates the enabled tenant binding so a manual
  connection is usable immediately (the brief's "global to the workspace"),
  narrowable per agent. No separate tenant-binding management UI in v1.
- MCP tools are gated on `canCallExternalTools` — same outbound-network risk
  class as searchWeb/screenshot/extractContent/sendEmail. Not in the brief,
  consistent with the funnel's posture.
- `skill-binding`-style `@ManyToOne` to the connection/user rows (the
  no-`@ManyToOne` rule applies to SCOPE entities only; tenant/org stay raw
  uuid columns).
- `lastConnectedAt` is `@PortableDateColumn` (NOT raw `type: 'timestamp'`):
  the e2e/CI driver is better-sqlite3, which has no `timestamp` type — a raw
  timestamp fails TypeORM metadata validation at boot. The repo-wide
  `entities/__tests__/portable-date-columns.spec.ts` guard SCANS entity
  sources, so it needed no edit; it simply had to pass, which is what
  forced the column type. The MIGRATION still uses `timestamp` (house
  pattern — migrations run on Postgres only); TypeORM maps `type: Date`
  to `timestamp` there, so entity and schema agree.

## Known follow-ups

- Account-transfer whitelist entries for the two new tables (export/import
  of connections as references, masked secrets) — plan §2.5's 4-place
  whitelist work was out of budget here; new tables simply do not transfer.
- Playwright e2e for the two new pages (binding CRUD, authz matrix).
- No tenant-binding management UI: `POST /api/mcp-connections` creates the
  enabled `'tenant'` row and nothing exposes it afterwards, so "disable
  everywhere" is done by disabling the CONNECTION. Fine for v1 (they are
  equivalent while `manual` is the only source), but the tenant row needs
  its own control once `'package'` connections exist.
- Domain chat tools for connections/bindings (the in-code DoD at
  `agent-tool.service.ts:317-319`) — new entities have no chat-tool source yet.
- Redirect policy (AP-15 cross-origin header rules) relies on the SDK's fetch
  defaults; the explicit no-forward implementation is deferred to the package
  slice (T25).
- Per-run connection pooling (connect-per-operation today; fine at v1 scale).
