# Implementation Plan: Connections, scope presets, per-agent grants and the vault

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns
> implementation detail; the spec owns behaviour. Every path below was verified to exist in the
> worktree before it was written down.

**Epic ID**: `AW-15-connections-scopes`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## 1. Current state in the codebase

### 1.1 Four unrelated connection models, no registry

| # | What it is | Entity | Table | API | Web |
| --- | --- | --- | --- | --- | --- |
| 1 | Plugin settings + secrets, three tiers (admin → user → Work) | `PluginEntity` / `UserPluginEntity` / `WorkPluginEntity` under `packages/agent/src/plugins/entities/` | `plugins`, `user_plugins`, `work_plugins` | [`apps/api/src/plugins/plugins.controller.ts`](../../../../../apps/api/src/plugins/plugins.controller.ts) | [`apps/web/src/app/[locale]/(dashboard)/plugins/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/plugins/page.tsx>) |
| 2 | OAuth accounts, shared with platform login | [`packages/agent/src/entities/auth-account.entity.ts`](../../../../../packages/agent/src/entities/auth-account.entity.ts) | `account` | [`apps/api/src/plugins-capabilities/oauth/oauth.controller.ts`](../../../../../apps/api/src/plugins-capabilities/oauth/oauth.controller.ts) | `apps/web/src/components/settings/PluginOAuthConnection.tsx` |
| 3 | External MCP servers | [`packages/agent/src/entities/mcp-server-connection.entity.ts`](../../../../../packages/agent/src/entities/mcp-server-connection.entity.ts) + [`agent-mcp-server-binding.entity.ts`](../../../../../packages/agent/src/entities/agent-mcp-server-binding.entity.ts) | `mcp_server_connections`, `agent_mcp_server_bindings` | [`apps/api/src/mcp-connections/mcp-connections.controller.ts`](../../../../../apps/api/src/mcp-connections/mcp-connections.controller.ts), [`agent-mcp-servers.controller.ts`](../../../../../apps/api/src/mcp-connections/agent-mcp-servers.controller.ts) | [`apps/web/src/components/settings/McpConnectionsClient.tsx`](../../../../../apps/web/src/components/settings/McpConnectionsClient.tsx), [`AgentMcpServersClient.tsx`](../../../../../apps/web/src/components/agents/AgentMcpServersClient.tsx) |
| 4 | Repositories | [`packages/agent/src/entities/repo-connection.entity.ts`](../../../../../packages/agent/src/entities/repo-connection.entity.ts) | `repo_connections`, `agent_repo_attachments` | [`apps/api/src/repo-connections/repo-connections.controller.ts`](../../../../../apps/api/src/repo-connections/repo-connections.controller.ts) | `apps/web/src/components/settings/RepositoriesSettings.tsx` |

Nothing joins them. There is no row that means "an account", so there is nowhere to hang a
label, a preset, a health state or a last-used timestamp.

### 1.2 The exact blockers

- **One account per provider.** `auth-account.entity.ts` carries
  `@Index(['userId','providerId'], { unique: true })`. A second account on the same provider
  cannot be inserted.
- **Access is resolved once per Run, not per call.**
  [`packages/agent/src/agents/agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts)
  `resolveGrantedTools` (line 661) folds the tool-grant matrix once while assembling the
  descriptor list; `AgentRunService.invokeTool`
  ([`packages/agent/src/agents/agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts), line 1219)
  then calls `descriptor.invoke(...)` with **no further access check**. A grant written
  mid-Run therefore does not bind until the next Run.
- **Tool grants cannot name an account.**
  [`packages/agent/src/policy/tool-grant.ts`](../../../../../packages/agent/src/policy/tool-grant.ts)
  matches glob patterns over tool *names*; tool names carry no account identity, so
  "read on the client's repo, write on ours" is inexpressible.
- **Health is pull-only.** `POST /api/mcp-connections/:id/test`
  ([controller](../../../../../apps/api/src/mcp-connections/mcp-connections.controller.ts))
  and `OAuthService.checkConnection`
  ([`apps/api/src/plugins-capabilities/oauth/oauth.service.ts`](../../../../../apps/api/src/plugins-capabilities/oauth/oauth.service.ts))
  both probe live, but nothing calls them on a schedule. There is no `@Cron` and no scheduled
  task anywhere in this domain.
- **The credential port has no workspace-backed implementation.**
  [`packages/agent/src/policy/credential-resolver.ts`](../../../../../packages/agent/src/policy/credential-resolver.ts)
  defines `CredentialResolver` / `CREDENTIAL_RESOLVER` and ships exactly one implementation,
  `EnvCredentialResolver`, which reads `EVERWORKS_CRED_*` process env. Its own doc-comment says
  it is "explicitly NOT correct for multi-tenant SaaS — that deployment binds a store-backed
  resolver instead". This epic is that store-backed resolver.
- **MCP onboarding is a form, not a paste.**
  [`packages/agent/src/mcp/mcp-connections.service.ts`](../../../../../packages/agent/src/mcp/mcp-connections.service.ts)
  accepts `{ name, url, transport, authHeaders }` only; there is no config parser and no
  interactive-sign-in path.

### 1.3 What already exists and must be reused, not rebuilt

- **Envelope encryption** — `EncryptedJsonColumn` in
  [`packages/agent/src/entities/_secret-json-column.ts`](../../../../../packages/agent/src/entities/_secret-json-column.ts),
  backed by AES-256-GCM in
  [`plugin-secret-enc.service.ts`](../../../../../packages/agent/src/plugins/services/plugin-secret-enc.service.ts).
- **Outbound-request guard** —
  [`packages/agent/src/mcp/guarded-fetch.ts`](../../../../../packages/agent/src/mcp/guarded-fetch.ts)
  re-checks every redirect hop and drops caller headers on cross-origin.
- **Narrow-only merge semantics** —
  [`packages/agent/src/policy/tool-grant.ts`](../../../../../packages/agent/src/policy/tool-grant.ts)
  is the template the connection ladder copies verbatim in shape.
- **The enforcer-token pattern** — `TOOL_GRANT_ENFORCER` in
  [`tool-grant.enforcer.ts`](../../../../../packages/agent/src/policy/tool-grant.enforcer.ts)
  (type-only leaf file, `@Optional() @Inject`, unbound = previous behaviour).
- **Scope stamping** — `tenantId`/`organizationId` are auto-filled by
  [`apps/api/src/scope/scope-stamping.subscriber.ts`](../../../../../apps/api/src/scope/scope-stamping.subscriber.ts)
  for any entity declaring both columns.
- **Scheduled dispatch** —
  [`packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts)
  is the exact shape the health sweeper copies.
- **MCP tool naming** — `mcp__<server>__<tool>`, `MCP_TOOL_NAME_MAX = 128`, in
  [`packages/agent/src/mcp/mcp-tool-source.ts`](../../../../../packages/agent/src/mcp/mcp-tool-source.ts).

## 2. Architecture and the seam this plugs into

### 2.1 The registry is a pointer table, not a replacement

`connections` does **not** own credentials. It points at whichever existing record already holds
them. Nothing in §1.1 is migrated away, renamed, or made to route through the new table.

```
                      ┌──────────────────────────────────────────┐
                      │           connections (NEW)              │
                      │  label · isPrimary · scopePreset ·        │
                      │  health · lastUsedAt · providerId · kind  │
                      └──────────────┬───────────────────────────┘
                                     │ backingKind + backingId
        ┌──────────────┬─────────────┼───────────────┬────────────────┐
        ▼              ▼             ▼               ▼                ▼
   account       mcp_server_    repo_connections  user_plugins   (none — an
   (OAuth)       connections    (repo kind)       (api_key kind) MCP row is
   unchanged     unchanged      unchanged         unchanged       its own)
```

### 2.2 Request/data flow

```mermaid
flowchart TB
    subgraph Web
      A["/settings/connections<br/>ConnectionsClient"]
      B["/agents/:id/connections<br/>AgentConnectionsClient"]
      V["/settings/connections (Vault tab)<br/>VaultClient"]
    end
    subgraph API["apps/api/src/connections + apps/api/src/vault"]
      C[ConnectionsController]
      G[ConnectionGrantsController]
      M[McpOnboardingController]
      K[VaultController]
    end
    subgraph Agent["packages/agent/src"]
      R[ConnectionRegistryService]
      H[ConnectionHealthService]
      P[ConnectionScopeFacadeService]
      X[ConnectionAccessService<br/>CONNECTION_ACCESS_ENFORCER]
      S[VaultService + VaultCredentialResolver]
      DB[(connections<br/>connection_grants<br/>connection_run_usage<br/>vault_secrets)]
    end
    subgraph Runtime["agent run loop"]
      T1[AgentToolService.resolveGrantedTools]
      T2[AgentRunService.invokeTool]
    end
    A --> C --> R --> DB
    B --> G --> DB
    V --> K --> S --> DB
    M --> R
    C --> H
    R --> P
    P -->|capability lookup| PL[plugin registry]
    T1 -->|drop blocked tools| X
    T2 -->|decide before every call| X
    X --> DB
    T2 -->|{{cred.key}}| S
    JOB[connection-health-dispatcher<br/>scheduled task] --> H
```

### 2.3 The two enforcement seams

| Seam | File | What is added |
| --- | --- | --- |
| **Run assembly** (FR-23) | [`packages/agent/src/agents/agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts) `resolveGrantedTools`, after the existing tool-grant partition | drop every descriptor whose Connection resolves to `blocked`, and every descriptor whose tool name is not covered by the effective preset's patterns |
| **Per invocation** (FR-20/21/22) | [`packages/agent/src/agents/agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) `invokeTool`, between the `descriptorByName.get(call.name)` lookup and `descriptor.invoke(...)` | `await this.connectionAccess?.decide(agent, call.name)`; a refusal returns `{ error: … }` exactly like the existing "not in the allow-list" branch — the Run continues |

Both consume `CONNECTION_ACCESS_ENFORCER` through `@Optional() @Inject(...)`, so any runtime
that has not bound it (unit tests, CLI, a worker without the policy module) behaves exactly as
it does today. Unlike the tool-grant matrix, an **unbound** connection enforcer means "no
connection rows exist", which is also the correct answer.

### 2.4 How "no restart" is achieved

`ConnectionAccessService` keeps a process-local `Map<userId, { resolvedAt, byConnection }>` with
`MAX_AGE_MS = 5_000`. `decide()` reads the cache; on a miss (or an entry older than 5 s) it
reloads that user's `connections` + `connection_grants` in one query and re-caches. Any write
through `ConnectionGrantsService` or `ConnectionRegistryService` **evicts the user's entry in
the writing process immediately**, so the UI's own process sees the change at once, and every
other process converges within 5 s. This gives FR-21's guarantee with a hot-path cost of a map
lookup (FR non-functional: ≤ 2 ms P95) and no cross-process signalling infrastructure.

> Deliberate non-choice: no Redis pub/sub invalidation. It would buy sub-second convergence at
> the cost of a new hard dependency in the tool hot path, and the spec's contract is 5 seconds.
> Recorded as an open question in [`spec.md` §10](./spec.md).

### 2.5 Multiple OAuth accounts without touching the `account` table

`account` keeps `@Index(['userId','providerId'], { unique: true })` untouched — better-auth's
social-login lookups depend on it. Instead, additional plugin-originated accounts are stored
with a **connection-scoped provider id**:

```
existing (stays)   providerId = "plugin:github"                  ← the first / primary account
additional (new)   providerId = "plugin:github#<connectionId>"    ← every account after the first
```

`PLUGIN_PROVIDER_PREFIX` and `buildPluginProviderId` already live in
[`packages/agent/src/database/repositories/auth-account.repository.ts`](../../../../../packages/agent/src/database/repositories/auth-account.repository.ts)
(line 15) and `findConnectedProviderAccount` already resolves through a **candidate list**
(`[buildPluginProviderId(providerId), providerId]`, line 173). A new
`buildPluginConnectionProviderId(pluginId, connectionId)` prepends a third candidate. Result:

- **zero migration on `account`**,
- every existing lookup keeps working unchanged,
- `@Index(['providerId','accountId'], { unique: true })` still prevents linking the same remote
  account twice.

## 3. Data model

All new entities live in `packages/agent/src/entities/` and are exported from
[`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts).
All migrations live in `apps/api/src/migrations/` (timestamp-prefixed), and per **Constitution
V** each entity change ships its migration **in the same PR**.

### 3.1 `Connection` — `packages/agent/src/entities/connection.entity.ts`

```ts
export type ConnectionKind = 'oauth' | 'api_key' | 'mcp' | 'repo';
export type ConnectionBackingKind =
    | 'auth_account'
    | 'mcp_server_connection'
    | 'repo_connection'
    | 'plugin_settings';
export type ConnectionScopePreset = 'read' | 'write';
export type ConnectionHealth = 'unknown' | 'healthy' | 'degraded' | 'expired' | 'unreachable';

export const CONNECTION_LABEL_MAX = 60;
export const CONNECTIONS_PER_PROVIDER_MAX = 10;
export const CONNECTIONS_PER_WORKSPACE_MAX = 100;

@Entity({ name: 'connections' })
@Index('uq_connections_owner_provider_label', ['userId', 'providerId', 'labelNormalized'], { unique: true })
@Index('idx_connections_user', ['userId'])
@Index('idx_connections_user_provider', ['userId', 'providerId'])
@Index('idx_connections_health_sweep', ['health', 'healthCheckedAt'])
@Index('idx_connections_backing', ['backingKind', 'backingId'])
export class Connection {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column({ type: 'uuid' }) userId: string;

    /** Plugin id, or the literal 'mcp' for MCP-kind rows. Never hardcoded in core. */
    @Column({ type: 'varchar', length: 128 }) providerId: string;
    @Column({ type: 'varchar', length: 16 }) kind: ConnectionKind;
    @Column({ type: 'varchar', length: 24 }) backingKind: ConnectionBackingKind;
    /** varchar, not uuid: `account.id` is varchar. Null for plugin_settings. */
    @Column({ type: 'varchar', length: 255, nullable: true }) backingId?: string | null;

    @Column({ type: 'varchar', length: 60 }) label: string;
    /** lower(label) — the case-insensitive uniqueness key (FR-3). */
    @Column({ type: 'varchar', length: 60 }) labelNormalized: string;
    @Column({ type: 'boolean', default: false }) isPrimary: boolean;
    @Column({ type: 'varchar', length: 8, default: 'read' }) scopePreset: ConnectionScopePreset;

    @Column({ type: 'varchar', length: 16, default: 'unknown' }) health: ConnectionHealth;
    @PortableDateColumn({ nullable: true }) healthCheckedAt?: Date | null;
    @PortableDateColumn({ nullable: true }) healthCheckInFlightAt?: Date | null;
    @Column({ type: 'int', default: 0 }) healthFailureCount: number;
    /** Classified code, never a provider response body. */
    @Column({ type: 'varchar', length: 48, nullable: true }) lastErrorCode?: string | null;
    @Column({ type: 'text', nullable: true }) lastErrorMessage?: string | null;

    @PortableDateColumn({ nullable: true }) lastUsedAt?: Date | null;
    @Column({ type: 'uuid', nullable: true }) lastUsedRunId?: string | null;
    /** MCP only — tools discovered at the last successful connect. */
    @Column({ type: 'int', nullable: true }) toolCount?: number | null;

    @Column({ type: 'uuid', nullable: true }) tenantId?: string | null;
    @Column({ type: 'uuid', nullable: true }) organizationId?: string | null;
    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

> **Why single-primary is not a partial unique index.** `@Index(..., { where: '"isPrimary"' })`
> emits dialect-specific SQL, and the e2e stack + CI run better-sqlite3 (see the
> `PortableDateColumn` boot guard referenced in `mcp-server-connection.entity.ts`). Single-primary
> is instead enforced inside one transaction: `UPDATE connections SET "isPrimary" = false WHERE
> "userId" = $1 AND "providerId" = $2` immediately followed by the `true` write on the target row.
> Two concurrent promotions serialise on the same rows and the last one wins, which is the
> correct outcome — there is never a window with two primaries visible to a committed read.

### 3.2 `ConnectionGrant` — `packages/agent/src/entities/connection-grant.entity.ts`

```ts
export type ConnectionGrantTarget = 'workspace' | 'agent';
export type ConnectionGrantMode = 'read' | 'write' | 'blocked'; // `inherit` = no row

@Entity({ name: 'connection_grants' })
@Index('uq_connection_grants_conn_target', ['connectionId', 'targetType', 'targetId'], { unique: true })
@Index('idx_connection_grants_user', ['userId'])
@Index('idx_connection_grants_target', ['targetType', 'targetId'])
export class ConnectionGrant {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column({ type: 'uuid' }) userId: string;
    @Column({ type: 'uuid' }) connectionId: string;
    @Column({ type: 'varchar', length: 16 }) targetType: ConnectionGrantTarget;
    /**
     * Agent id for 'agent'; the owning userId for 'workspace'. Non-null on
     * both so the unique index has no nullable member — SQL treats NULLs as
     * DISTINCT, which would let a concurrent create burst all succeed. Same
     * reasoning as `tool_grants.scopeId`.
     */
    @Column({ type: 'uuid' }) targetId: string;
    @Column({ type: 'varchar', length: 8 }) mode: ConnectionGrantMode;
    @Column({ type: 'text', nullable: true }) note?: string | null;
    @Column({ type: 'uuid', nullable: true }) tenantId?: string | null;
    @Column({ type: 'uuid', nullable: true }) organizationId?: string | null;
    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

FK `connectionId → connections(id) ON DELETE CASCADE` is created by the migration (no
`@ManyToOne`, to stay clear of the known entities import cycle documented in
`user.entity.ts`).

### 3.3 `ConnectionRunUsage` — `packages/agent/src/entities/connection-run-usage.entity.ts`

```ts
@Entity({ name: 'connection_run_usage' })
@Index('uq_connection_run_usage', ['connectionId', 'runId'], { unique: true })
@Index('idx_connection_run_usage_conn_last', ['connectionId', 'lastUsedAt'])
export class ConnectionRunUsage {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column({ type: 'uuid' }) connectionId: string;
    @Column({ type: 'uuid' }) runId: string;
    @Column({ type: 'uuid', nullable: true }) agentId?: string | null;
    /** Label at the time of use — Runs keep their history when a Connection goes (FR-38). */
    @Column({ type: 'varchar', length: 60 }) connectionLabel: string;
    @Column({ type: 'int', default: 0 }) callCount: number;
    @PortableDateColumn() firstUsedAt: Date;
    @PortableDateColumn() lastUsedAt: Date;
}
```

`ON DELETE SET NULL` is **not** used: the FK is deliberately omitted so deleting a Connection
leaves its Run history intact (FR-38). Orphan rows are pruned by the existing 12-month
retention pattern, added to the same cleanup service that already prunes `plugin_usage_events`
([`apps/api/src/budgets/plugin-usage-cleanup.service.ts`](../../../../../apps/api/src/budgets/plugin-usage-cleanup.service.ts)).

### 3.4 `VaultSecret` — `packages/agent/src/entities/vault-secret.entity.ts`

```ts
export const VAULT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const VAULT_SECRETS_MAX = 200;
export const VAULT_VALUE_MAX_BYTES = 8 * 1024;

@Entity({ name: 'vault_secrets' })
@Index('uq_vault_secrets_owner_key', ['userId', 'key'], { unique: true })
@Index('idx_vault_secrets_owner_group', ['userId', 'groupName'])
export class VaultSecret {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column({ type: 'uuid' }) userId: string;
    @Column({ type: 'varchar', length: 40 }) groupName: string;
    @Column({ type: 'varchar', length: 64 }) key: string;
    @Column({ type: 'varchar', length: 80, nullable: true }) label?: string | null;
    /** AES-256-GCM envelope, same column helper as mcp authHeaders. WRITE-ONLY. */
    @EncryptedJsonColumn() secret: { v: string };
    @Column({ type: 'uuid' }) createdByUserId: string;
    @PortableDateColumn({ nullable: true }) lastUsedAt?: Date | null;
    @Column({ type: 'int', default: 0 }) referenceCount: number;
    @Column({ type: 'uuid', nullable: true }) tenantId?: string | null;
    @Column({ type: 'uuid', nullable: true }) organizationId?: string | null;
    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

`secret` is **never** put on any DTO. `VaultService` has no `getValue(id)` at all — the only
read path is `VaultCredentialResolver.resolve(ctx, keys)`, which returns a `Map` to the
`{{cred.key}}` interpolator and is not reachable from a controller. Enforced by a unit test
that asserts no exported DTO type has a field assignable from `VaultSecret['secret']`.

### 3.5 Additive columns on existing tables

| Table | Column | Phase | Why |
| --- | --- | --- | --- |
| `mcp_server_connections` | `authMode varchar(16) NOT NULL DEFAULT 'header'` (`header \| interactive`) | P3 | distinguishes header-auth from interactive-sign-in servers |
| `mcp_server_connections` | `oauthTokens` (`EncryptedJsonColumn`, nullable) | P3 | access/refresh pair for interactive servers, envelope-encrypted like `authHeaders` |
| `mcp_server_connections` | `oauthMetadata simple-json NULL` | P3 | issuer, authorization/token endpoints, registered client id, granted scopes — **non-secret** |
| `plugin_usage_events` | `connectionId uuid NULL` + `idx_plugin_usage_connection (connectionId, createdAt)` | P2 | lets AW-17 group spend by Connection with no further schema work |

### 3.6 Migrations (forward-only, one per phase, shipped with its entities)

Timestamps are AW-15 slots 00–02 of the program's reserved migration blocks ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow));
re-stamp before merge if `develop` has moved past them.

| File | Phase | Contents |
| --- | --- | --- |
| `apps/api/src/migrations/1791150000000-AddConnectionRegistry.ts` | P1 | `CREATE TABLE connections` + its five indexes + backfill (§3.7) |
| `apps/api/src/migrations/1791150100000-AddConnectionGrantsAndUsage.ts` | P2 | `CREATE TABLE connection_grants` (+ FK cascade), `CREATE TABLE connection_run_usage`, `ALTER TABLE plugin_usage_events ADD COLUMN connectionId` + index |
| `apps/api/src/migrations/1791150200000-AddVaultAndMcpInteractiveAuth.ts` | P3 | `CREATE TABLE vault_secrets`, `ALTER TABLE mcp_server_connections ADD authMode/oauthTokens/oauthMetadata` |

Every `ALTER` is `ADD COLUMN … NULL` or `ADD COLUMN … NOT NULL DEFAULT`; no `DROP`, no rename,
no type change. `down()` drops only what `up()` created.

### 3.7 Backfill (inside the P1 migration, idempotent)

```sql
-- MCP servers  → one Connection each, preset 'write' (no presets declared), label = name
INSERT INTO connections (id, "userId", "providerId", kind, "backingKind", "backingId",
                         label, "labelNormalized", "isPrimary", "scopePreset", health,
                         "tenantId", "organizationId", "createdAt", "updatedAt")
SELECT <uuid>, m."userId", 'mcp', 'mcp', 'mcp_server_connection', m.id::text,
       m.name, lower(m.name), true, 'write', 'unknown',
       m."tenantId", m."organizationId", m."createdAt", now()
FROM mcp_server_connections m
WHERE NOT EXISTS (SELECT 1 FROM connections c
                  WHERE c."backingKind" = 'mcp_server_connection' AND c."backingId" = m.id::text);

-- Plugin OAuth accounts → one Connection each (social-login rows excluded by the prefix)
--   providerId LIKE 'plugin:%' ; label = COALESCE(username, email, provider name)
-- Repo connections → one Connection each, kind 'repo', preset 'write'
```

Rules honoured by the backfill:

- `isPrimary = true` for the **oldest** row per `(userId, providerId)`, `false` for the rest.
- `scopePreset = 'write'` for every backfilled row — existing connections already have whatever
  access they were granted, and silently narrowing a working connection would break live Agents.
  New connections default to `read` (FR-10); backfilled ones do not.
- `health = 'unknown'` — the first sweep sets the real value; nothing is asserted we have not
  checked.
- Label collisions inside one `(userId, providerId)` are resolved by appending ` 2`, ` 3`, …
  before the unique index is created.
- Re-running the migration inserts nothing (the `NOT EXISTS` guard).

### 3.8 Contracts (`packages/contracts/src/connections/`, new, exported from `src/index.ts`)

```ts
// connection.types.ts
export type ConnectionScopePresetId = 'read' | 'write';
export type ConnectionGrantMode = 'inherit' | 'read' | 'write' | 'blocked';
export const CONNECTION_ACCESS_ORDER = ['blocked', 'read', 'write'] as const;

export interface ConnectionDto {
  id: string; providerId: string; providerName: string; kind: ConnectionKind;
  label: string; isPrimary: boolean;
  scopePreset: ConnectionScopePresetId | null;   // null ⇒ provider declares no presets
  presetsAvailable: ConnectionScopePresetId[];   // [] ⇒ render "Standard access"
  health: ConnectionHealth; healthCheckedAt: string | null;
  lastErrorCode: string | null; lastErrorMessage: string | null;
  lastUsedAt: string | null; lastUsedRunId: string | null; runCount: number;
  toolCount: number | null; createdAt: string;
}

export interface ConnectionGrantDto {
  targetType: 'workspace' | 'agent'; targetId: string; targetLabel: string;
  requested: ConnectionGrantMode;      // what is stored ('inherit' when no row)
  effective: Exclude<ConnectionGrantMode, 'inherit'>;
  clampedBy: 'connection' | 'workspace' | null;   // FR-19
}

export interface VaultSecretDto {
  id: string; groupName: string; key: string; label: string | null;
  value: '●●●●●●●●';                  // literal type — the compiler forbids a real value
  createdAt: string; createdByName: string;
  lastUsedAt: string | null; referenceCount: number;
}

export interface ParsedMcpServerDto {
  name: string; url: string; transport: 'streamable-http' | 'sse';
  headerNames: string[];               // names only, never values
  secretsDetected: number;
  authMode: 'header' | 'interactive' | 'unknown';
  warnings: string[];
}
```

The literal type on `VaultSecretDto.value` is deliberate: a service that tried to put a real
secret there would not type-check.

## 4. API surface

New Nest modules: `apps/api/src/connections/` and `apps/api/src/vault/`. Every endpoint is
authenticated (`@CurrentUser()`), scope-aware through the existing `X-Scope-Slug` header, and
returns `404` (never `403`) for a row owned by someone else.

### 4.1 Registry — `apps/api/src/connections/connections.controller.ts` (`@Controller('api/connections')`)

| Method | Path | Body / query | Response | Throttle |
| --- | --- | --- | --- | --- |
| `GET` | `/api/connections` | `?providerId&kind&health` | `{ groups: Array<{ providerId, providerName, max, connections: ConnectionDto[] }> }` | default |
| `GET` | `/api/connections/providers` | — | `{ providers: Array<{ id, name, kind, presets: ConnectionScopePresetId[], connected: number, max: 10 }> }` | default |
| `GET` | `/api/connections/:id` | — | `ConnectionDto` | default |
| `PATCH` | `/api/connections/:id` | `UpdateConnectionDto { label?, scopePreset?, isPrimary? }` | `ConnectionDto` | 60/min |
| `DELETE` | `/api/connections/:id` | — | `{ deleted: true, promotedPrimaryId?: string }` | 30/min |
| `POST` | `/api/connections/:id/check` | — | `{ health, checkedAt, errorCode?, errorMessage? }` | **6/min** |
| `GET` | `/api/connections/:id/reconnect-url` | `?redirectUri` | `{ url, state }` — `409 reconnect_not_applicable` unless `health='expired'` and `kind='oauth'` | 20/min |
| `GET` | `/api/connections/:id/runs` | `?cursor&limit(≤50)` | `{ runs: RunSummaryDto[], nextCursor }` | default |
| `POST` | `/api/connections/providers/:providerId/connect-url` | `{ redirectUri, scopePreset }` | `{ url, state, connectionId }` — pre-creates a pending Connection so the callback can bind | 30/min |

`UpdateConnectionDto` (class-validator): `@IsOptional() @IsString() @Length(1,60) label`,
`@IsOptional() @IsIn(['read','write']) scopePreset`, `@IsOptional() @IsBoolean() isPrimary`.

Error codes: `connection_limit_reached` (409), `provider_limit_reached` (409),
`label_taken` (409), `reconnect_not_applicable` (409), `preset_requires_reapproval` (409, body
carries `{ reapprovalUrl }`), `connection_not_found` (404).

### 4.2 Grants — `apps/api/src/connections/connection-grants.controller.ts`

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/connections/:id/grants` | — | `{ ceiling, workspace: ConnectionGrantDto, agents: ConnectionGrantDto[] }` |
| `PUT` | `/api/connections/:id/grants/:targetType/:targetId` | `SetConnectionGrantDto { mode, note? }` | `ConnectionGrantDto` (with `effective` + `clampedBy`) |
| `DELETE` | `/api/connections/:id/grants/:targetType/:targetId` | — | `{ reverted: true }` (back to `inherit`) |
| `GET` | `/api/agents/:agentId/connections` | — | `{ connections: Array<ConnectionDto & { grant: ConnectionGrantDto }> }` |

`PUT` is 120/min. `mode` is `@IsIn(['read','write','blocked'])`; `inherit` is expressed by
`DELETE`, never by `PUT`, so "no row means inherit" stays true at the storage layer.
`GET /api/agents/:agentId/connections` lives in the same module but is registered under the
agents path, mirroring how `agent-mcp-servers.controller.ts` already does it.

### 4.3 MCP onboarding — `apps/api/src/connections/mcp-onboarding.controller.ts`

| Method | Path | Body | Response | Throttle |
| --- | --- | --- | --- | --- |
| `POST` | `/api/connections/mcp/parse` | `ParseMcpConfigDto { text: string }` (≤ 16 KB) | `{ servers: ParsedMcpServerDto[], errors: string[] }` — **nothing persisted** | 30/min |
| `POST` | `/api/connections/mcp` | `CreateMcpConnectionFromParseDto { servers: [{ name, url, transport, headers?: Record<string,string> }] }` (≤ 10) | `{ connections: ConnectionDto[] }` | 20/min |
| `POST` | `/api/connections/mcp/:id/authorize` | — | `{ authorizeUrl, pollToken, expiresAt }` | 20/min |
| `GET` | `/api/connections/mcp/:id/authorize/status` | `?pollToken` | `{ state: 'pending' \| 'connected' \| 'failed' \| 'timeout', toolCount?, toolNames? }` | 60/min |
| `GET` | `/api/connections/mcp/callback` | `?code&state` | `302` to a "you can close this tab" page | 60/min |

- `parse` is a **pure function over the pasted text** plus one HEAD/probe of the URL for
  `authMode` detection. It never writes a row and never stores a secret, which is what makes
  the collision and unparseable cases in §7.6 of the spec safe (nothing to clean up).
- `POST /api/connections/mcp` moves any supplied header value into the Vault first, stores only
  the resulting `{{cred.key}}` reference in `mcp_server_connections.authHeaders`, then delegates
  row creation to the **existing** `McpConnectionsService.create` so the tenant-inherit binding,
  the name pattern and the SSRF guard all still apply unchanged. Storing a reference is only
  safe together with the connect-time resolution below — without it the reference would be sent
  to the server literally.
- `GET /api/connections/mcp/callback` is the only `@Public()` endpoint added. Justification: the
  provider's browser redirect cannot be relied on to carry a session cookie (`SameSite`). It is
  protected by a **signed, single-use `state`** bound to `(connectionId, userId)` with a
  **10-minute TTL**, stored server-side and deleted on first use; an unknown or expired state is
  a `400` that reveals nothing.

#### 4.3.1 Header credentials are resolved at connect time

Today `McpClientService.connect` ([`packages/agent/src/mcp/mcp-client.service.ts`](../../../../../packages/agent/src/mcp/mcp-client.service.ts))
passes `headers: connection.authHeaders ?? {}` straight to the SDK client factory, and
`{{cred.key}}` interpolation runs only over **tool arguments**, in
[`AgentToolService`](../../../../../packages/agent/src/agents/agent-tool.service.ts) via
[`interpolateCredentials`](../../../../../packages/agent/src/policy/credential-interpolation.ts).
Nothing resolves a reference inside a header, so the placeholder stored by §4.3 would reach the
MCP server as the literal text `{{cred.key}}`. This epic adds one step, inside `connect()`, before
the factory is called:

1. **Collect.** `collectCredentialRefs(connection.authHeaders)` (existing helper). No references
   ⇒ the stored headers are used unchanged, so every existing literal-header row keeps working
   (Constitution X).
2. **Resolve.** `CREDENTIAL_RESOLVER.resolve(ctx, keys)` with
   `ctx = { userId, organizationId, tenantId }` taken from the Connection row — the same port the
   tool-argument path uses, bound to `VaultCredentialResolver` by T36. `McpClientService` takes
   it as `@Optional() @Inject(CREDENTIAL_RESOLVER)`; when it is unbound every reference counts as
   missing (fail closed), never forwarded verbatim.
3. **Substitute.** `interpolateCredentials(connection.authHeaders, resolved)` into a **new local
   object**. The resolved headers live only in the `connect()` stack frame and are handed to
   `factory.connect` once. They are never assigned to the `McpServerConnection` entity, the tools
   cache, `stampConnectionResult`, a logger, a Sentry/PostHog breadcrumb or an error message.
4. **Refuse on missing.** If `missing.length > 0` the method throws
   `McpHeaderCredentialMissingError { keys }` **before** `factory.connect` — no request leaves the
   platform. `classifyError` maps it to the stored message ``Missing credential `<key>` `` (keys
   only), `listTools` / `callTool` / the health probe surface that message, and the health
   classifier maps it to `expired` (spec FR-26, FR-47a) so *Reconnect* — which re-enters the
   header value into the Vault — is the offered fix.
5. **Redact what was actually sent.** `redactHeaderValues` scrubs the values of
   `connection.authHeaders`, which are now references rather than secrets. It gains the resolved
   map as a second source, so a header-echoing SDK error cannot put a Vault value into
   `lastError`, the API response or the model's conversation — the exact leak its doc-comment
   already describes. `redactCredentialValues` supplies the `[redacted:cred.<key>]` token.

The pure half (collect → substitute → missing) lives in
`packages/agent/src/mcp/mcp-header-credentials.ts` with no NestJS import, so every branch is a
unit test; `McpClientService` only wires the resolver and the error.

### 4.4 Vault — `apps/api/src/vault/vault.controller.ts` (`@Controller('api/vault')`)

| Method | Path | Body | Response | Throttle |
| --- | --- | --- | --- | --- |
| `GET` | `/api/vault` | `?group` | `{ groups: Array<{ groupName, secrets: VaultSecretDto[] }>, used, max: 200 }` | default |
| `POST` | `/api/vault` | `CreateVaultSecretDto { groupName, key, label?, value }` | `VaultSecretDto` | 30/min |
| `PATCH` | `/api/vault/:id` | `UpdateVaultSecretDto { groupName?, label?, value? }` | `VaultSecretDto` | 30/min |
| `DELETE` | `/api/vault/:id` | — | `{ deleted: true }` | 30/min |

There is **no** `GET /api/vault/:id/value`, no `?reveal=true`, no export route, and no
admin-scoped variant. `CreateVaultSecretDto.value` is `@IsString() @MaxLength(8192)` and is
marked `@Exclude()` on the way back out; the controller returns the mapped `VaultSecretDto`
whose `value` is the literal mask.

## 5. Web surface

All new components hang off the **existing** settings shell
([`apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx>))
and the existing agent detail layout
(`apps/web/src/app/[locale]/(dashboard)/agents/[id]/layout.tsx`). **No route is removed.**

| Route | Status | What changes |
| --- | --- | --- |
| `/settings/connections` | **exists** ([page.tsx](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/connections/page.tsx>)) | becomes the registry with a four-tab client; the **MCP servers** tab renders today's `McpConnectionsClient` **verbatim** so nothing regresses |
| `/settings/connections?tab=vault` | new (query param, no new route) | the Vault |
| `/agents/[id]/connections` | **new page** | per-agent grants across all Connections |
| `/agents/[id]/mcp-servers` | **exists**, unchanged | keeps working; gains a link "See all connections for this agent →" |

### 5.1 Components

```
apps/web/src/components/settings/connections/
  ConnectionsClient.tsx          'use client' — tabs, filter, banner, groups
  ConnectionGroup.tsx            one provider header + its rows + "Add account"
  ConnectionRow.tsx              label, ★, health pill, preset chip, last-used link
  ConnectionHealthPill.tsx       the 5 states, one place
  ConnectionManageDrawer.tsx     rename / primary / preset / agent access / danger
  ConnectionPresetChooser.tsx    two radios + the re-approval dialog
  ConnectionAgentAccessList.tsx  filterable listbox of agents with mode selects
  ConnectionsEmptyState.tsx
  AddMcpServerDialog.tsx         one textarea → parse preview → connect / sign-in states
  McpAuthorizeCard.tsx           detected / waiting / connected / timeout
apps/web/src/components/settings/vault/
  VaultClient.tsx                grouped list + counter
  VaultSecretRow.tsx             masked value, set-on/by, used, [Replace][Delete]
  VaultSecretDialog.tsx          add / replace
apps/web/src/components/agents/
  AgentConnectionsClient.tsx     the per-agent tab
```

### 5.2 Data plumbing (mirrors the existing MCP pattern exactly)

- Server actions: `apps/web/src/app/actions/connections.ts`, `.../vault.ts` — same shape as the
  existing [`apps/web/src/app/actions/mcp-connections.ts`](../../../../../apps/web/src/app/actions/mcp-connections.ts).
- API clients (server-only, `serverFetch`, `X-Scope-Slug` attached):
  `apps/web/src/lib/api/connections.ts`, `apps/web/src/lib/api/vault.ts` — same shape as
  [`apps/web/src/lib/api/mcp-connections.ts`](../../../../../apps/web/src/lib/api/mcp-connections.ts).
- Routes are added to `ROUTES` in
  [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts).
- The MCP authorize poll is a **client-side `setInterval(3000)`** in `McpAuthorizeCard.tsx`
  against the status action, cleared on unmount, on terminal state, and after 10 minutes.
- Every mutation control saves on change with an optimistic update, an inline "Saved" flash and
  a 5-second **Undo** that re-issues the inverse call. The preset chooser is the one exception:
  it is **never** optimistic, because widening may be refused (FR-14).

## 6. Background work

Per **Constitution IV**, nothing here calls a queue directly. The health sweep uses the
provider's native cron through a `schedules.task`, and per-Connection probes fan out through a
`*_DISPATCHER` DI symbol.

| File | Kind | Cadence | What it does |
| --- | --- | --- | --- |
| `packages/agent/src/connections/connection-health-dispatcher.ts` | port | — | exports `CONNECTION_HEALTH_DISPATCHER` + `ConnectionHealthDispatchPayload { connectionId, userId, tenantId?, organizationId? }` (type-only leaf file, same shape as `packages/agent/src/tasks-domain/task-dispatcher.ts`) |
| `packages/agent/src/connections/connection-health-dispatcher.service.ts` | service | called by the cron task | selects due rows, claims them, enqueues one probe each via the dispatcher |
| `packages/tasks/src/tasks/trigger/connection-health-dispatcher.task.ts` | `schedules.task` | `*/15 * * * *` | boots `TriggerInternalModule`, calls `dispatchDue()` — copied from [`agent-heartbeat-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts) |
| `packages/tasks/src/tasks/trigger/connection-health-probe.task.ts` | `task` | on demand | probes one Connection with an **8 s** timeout, writes health, returns `{ok:false,error}` rather than throwing so retries stay deterministic |

Both are registered in
[`packages/tasks/src/tasks/trigger/index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts).

**Due selection + claim (idempotent under concurrent ticks).** One atomic CAS per tick, no
distributed lock needed:

```sql
UPDATE connections SET "healthCheckInFlightAt" = now()
WHERE id IN (
  SELECT id FROM connections
  WHERE ("healthCheckInFlightAt" IS NULL OR "healthCheckInFlightAt" < now() - interval '5 minutes')
    AND ("healthCheckedAt" IS NULL OR "healthCheckedAt" < now() - (interval '1 minute' * :intervalMinutes))
  ORDER BY "healthCheckedAt" NULLS FIRST
  LIMIT 200 FOR UPDATE SKIP LOCKED)
RETURNING id, "userId", "tenantId", "organizationId";
```

`:intervalMinutes` is `60` for `kind='oauth'`, `30` for `'mcp'`, `360` for `'api_key'`/`'repo'`
(FR-27), applied as a `CASE` in the predicate. `FOR UPDATE SKIP LOCKED` + the in-flight stamp
means two overlapping ticks never probe the same row.

**Probe implementations — no new provider knowledge:**

| Kind | Probe |
| --- | --- |
| `oauth` | `OAuthFacadeService.getAuthenticatedUser(providerId, token)` — the same round-trip `OAuthService.checkConnection` already makes |
| `mcp` | `McpConnectionsService.test(userId, backingId)` — existing connect + `listTools`, already stamps `lastConnectedAt`/`lastError` |
| `api_key` | the plugin's existing `validate-connection` path via `PluginValidationService` |
| `repo` | the existing repo credential check in `repo-connections` |

**Classification** lives in a pure `packages/agent/src/connections/connection-health.ts`:
a credential rejection (`401`/`403`-class, or a provider error the facade maps to
`invalid_token`) → `expired` immediately; anything else increments `healthFailureCount`
(`1–2 → degraded`, `≥3 → unreachable`); success resets the counter to `0` and sets `healthy`.
The stored `lastErrorMessage` is a fixed catalogue string chosen by the classifier — the raw
provider body is never persisted (FR-30).

**Last-used flushing.** `ConnectionUsageBuffer` (in `packages/agent/src/connections/`) accumulates
`(connectionId, runId, agentId)` hits in memory and flushes on whichever comes first: **10
seconds** or **100 buffered calls**, plus a flush on `AgentRunService`'s run-teardown path. Each
flush is one upsert per `(connectionId, runId)` into `connection_run_usage` and one `UPDATE
connections SET lastUsedAt, lastUsedRunId` per Connection — satisfying FR-35 and FR-36 together.

## 7. Plugin boundaries

**Constitution I** — nothing external is added to core. **Constitution II** — no plugin id
appears outside its own package.

### 7.1 New capability: `connection-scopes`

`packages/plugin/src/contracts/capabilities/connection-scopes.interface.ts` (new file, exported
from `packages/plugin/src/contracts/capabilities/index.ts`):

```ts
export type ConnectionScopePresetId = 'read' | 'write';

export interface ConnectionScopePreset {
	readonly id: ConnectionScopePresetId;
	/** Provider scope strings requested at connect / re-approval time. */
	readonly providerScopes: readonly string[];
	/** Tool-name patterns this preset unlocks: '*', 'prefix*', or an exact name. */
	readonly toolPatterns: readonly string[];
}

export interface IConnectionScopesPlugin extends IPlugin {
	getConnectionScopePresets(): readonly ConnectionScopePreset[];
}

export function isConnectionScopesPlugin(p: IPlugin): p is IConnectionScopesPlugin {
	return p.capabilities.includes('connection-scopes');
}
```

Declaring it is **optional**. A plugin that does not gets FR-12's "Standard access" behaviour
for free, so no existing plugin has to change for this epic to ship.

### 7.2 Facade

`packages/agent/src/facades/connection-scopes.facade.ts`, registered in
[`facades.module.ts`](../../../../../packages/agent/src/facades/facades.module.ts) alongside the
existing 20-odd facades:

```ts
getPresets(providerId: string): Promise<readonly ConnectionScopePreset[]>   // [] when undeclared
coversTool(providerId, preset, toolName): Promise<boolean>
providerScopesFor(providerId, preset): Promise<readonly string[]>
```

`coversTool` reuses `matchesAnyToolPattern` from
[`packages/contracts/src/policy/tool-grant.types.ts`](../../../../../packages/contracts/src/policy/tool-grant.types.ts)
so pattern semantics are identical to the tool-grant matrix and cannot drift.

### 7.3 Which plugins declare presets

P1 ships the declaration in exactly one package so the mechanism is proven end to end without a
wide blast radius: `packages/plugins/github/`. P3 adds the 11 `connector`-category packages.
Anything not listed keeps "Standard access". (Confirmed as an open question in the spec.)

### 7.4 MCP interactive sign-in is a protocol, not a service-specific plugin

The detection and handshake are generic and live in
`packages/agent/src/connections/mcp-auth-detect.ts` + `mcp-authorize.service.ts`:

1. Probe the URL. A `401` carrying a `WWW-Authenticate` challenge that names a protected-resource
   metadata document ⇒ `authMode = 'interactive'`. Anything else ⇒ `'header'`.
2. Fetch the metadata document, then the authorization-server metadata it names.
3. Register a client dynamically if the server supports it; otherwise fall back to the
   deployment's configured redirect and a pre-registered client id.
4. Authorization-code with PKCE, `state` bound to `(connectionId, userId)`, single-use, 10-minute
   TTL.
5. Store the token pair in `mcp_server_connections.oauthTokens` (envelope-encrypted); refresh
   silently on `401` at call time; a refresh failure sets the Connection to `expired`.

Every request in this flow goes through
[`guarded-fetch.ts`](../../../../../packages/agent/src/mcp/guarded-fetch.ts), so metadata
discovery cannot be used to reach a private address (FR-58). No server-specific code exists
anywhere in this path — it works because the servers implement the protocol, not because we
recognise them.

### 7.5 The config parser

`packages/agent/src/connections/mcp-config-parser.ts` — pure, no I/O, unit-tested in isolation:

1. Strip markdown fences and `//` / `/* */` comments.
2. If the whole thing parses as a URL with an `https` scheme → single server, name derived from
   the host.
3. Otherwise wrap a bare `"name": { … }` fragment in braces, strip trailing commas, `JSON.parse`.
4. Accept `{ mcpServers: { … } }`, `{ servers: { … } }`, or a bare map of name → config.
5. For each entry pull `url`, `type`/`transport`, `headers`, and any `env`; classify every value
   whose key matches `/(key|token|secret|password|authorization|api[-_]?key)/i` **or** whose
   containing object is `headers` as a secret.
6. Reject: > 16 KB input, > 10 servers, a non-`https` url, a name failing
   `MCP_CONNECTION_NAME_PATTERN` (already exported from `mcp-server-connection.entity.ts`).

## 8. i18n

New keys in [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json). Leaf key
names are **camelCase** and contain **no literal `.`** (nesting supplies the path separator).
The 20 sibling locale files get the same key set in the same PR.

**Existing keys kept, one value changed.** `dashboard.settings.connections.title` stays
`"Connections"`. `dashboard.settings.connections.subtitle` changes value only, from
`"External MCP servers your agents can use as tools…"` to
`"Accounts your agents can use, and exactly what each one may do."` — the MCP-specific sentence
moves to the new `mcpTab.subtitle`. Every existing `dashboard.settings.connections.form.*` key
is untouched because `McpConnectionsClient` still renders with them.

```
dashboard.settings.connections
  subtitle                                    (value change only)
  tabs           { all, providers, mcpServers, vault }
  mcpTab         { subtitle }
  add            { menu, provider, mcpServer, account }
  accountsOfMax                               "{used} of {max} accounts"
  primary, makePrimary, rename, manage, reconnect, checkNow, disconnect
  disconnectHint
  lastUsed, neverUsed, seeRuns
  banner         { needsAttention, fixIt }
  health         { unknown, healthy, degraded, expired, unreachable, checkedAgo }
  preset         { read, readHint, write, writeHint, standard, hint,
                   reapprovalTitle, reapprovalBody, reapproveCta }
  agentAccess    { title, inheritDefault, inherit, read, write, blocked,
                   clamped, blockedHint, appliesNext, filterPlaceholder, empty }
  limits         { providerFull, workspaceFull }
  errors         { labelTaken, nameTaken, duplicateUrl, parseFailed, tooManyServers,
                   addressRefused, loadFailed, retry }
  empty          { title, body, browseProviders, addMcp }
  mcpWizard      { title, pasteLabel, pasteHelp, secretHelp, reading, connect, cancel,
                   detectedInteractive, openSignIn, openSignInAgain, waiting, timedOut,
                   tryAgain, connected, toolsAvailable, openExisting, done }
dashboard.settings.vault
  title, subtitle, addSecret, replace, delete
  fields         { group, key, keyHelp, label, value, valueHelp }
  masked, setOnBy, usedAgo, neverUsed, unusedByAnyConnection
  countOfMax, empty, full
dashboard.agents.connections
  title, subtitle, appliesNext, empty, connectOne, seeAllForAgent
```

**No `metadata.pages` key is added.** The connections page derives its `<title>` from
`dashboard.settings.connections.title` inside its own `generateMetadata()`
([page.tsx](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/connections/page.tsx>)),
and the agent sub-pages (e.g.
[`agents/[id]/mcp-servers/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/mcp-servers/page.tsx>))
declare no metadata at all. The new agent tab follows the same convention.

## 9. Telemetry and failure modes

### 9.1 Activity log

Additive members on `ActivityActionType`
([`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)).
The column is a free `varchar`, so **no migration is required** — the same reasoning already
recorded for the `MCP_CONNECTION_*` members at line 294 of that file.

```
connection_created · connection_updated · connection_deleted
connection_primary_changed · connection_preset_changed
connection_health_changed · connection_reconnected
connection_grant_set · connection_grant_cleared · connection_call_refused
vault_secret_created · vault_secret_rotated · vault_secret_deleted
```

`details` carries `{ connectionId, label, providerId, field }` — **never a value**, per
Constitution VII. `connection_call_refused` additionally carries `{ agentId, runId, toolName,
reason }`.

### 9.2 Metrics and Sentry

- counter `connection_call_refused_total{reason}` — `blocked`, `preset`, `not_found`
- counter `connection_health_transition_total{from,to}`
- gauge `connections_by_health{health}`
- histogram `connection_probe_duration_ms{kind}`
- counter `vault_credential_resolve_total{outcome}` — `hit`, `miss`
- Sentry tag `connectionKind` on every probe and authorize span; **no** Sentry breadcrumb in any
  code path that has a decrypted value in scope.

### 9.3 Failure modes and the chosen degradation

| Failure | Degrades to | Why that direction |
| --- | --- | --- |
| `CONNECTION_ACCESS_ENFORCER` unbound | no connection gate (tool grants + permissions still apply) | a DI mistake must not take the product down; matches the `TOOL_GRANT_ENFORCER` posture |
| Grant lookup throws | the **Connection's own preset**, warn-logged | fails toward the ceiling the owner explicitly set, never to `write` (FR-24) |
| Health sweep down | rows keep last known health + "checked N ago" | a stale probe must never flip a working row to `expired` or block a call (FR-31) |
| `VaultCredentialResolver` cannot resolve a key | the tool call is **refused**, naming the key | a half-authenticated outbound call is worse than a clear refusal — the existing `assertToolCredentialsAvailable` contract, unchanged |
| An MCP header references a Vault key that cannot be resolved | the connection attempt fails **before any request is sent**, naming the key; health `expired` | sending the literal `{{cred.key}}` would look like a server-side auth failure and hide the real cause; §4.3.1 |
| `PLUGIN_SECRET_ENCRYPTION_KEY` unset | vault **writes are rejected** with a clear error | the existing plaintext-passthrough fallback is acceptable for plugin settings in dev; for a write-only vault it is not, so this path opts out of the fallback explicitly |
| Interactive sign-in never completes | `timeout` after 10 min, nothing persisted | no half-created Connection, no orphan state row |
| Config parse fails | `400` with the field-level message, nothing persisted | the parse endpoint writes nothing by construction |

## 10. Test plan

### 10.1 Unit (Jest, `packages/agent`)

| File | Covers |
| --- | --- |
| `packages/agent/src/connections/__tests__/connection-access.spec.ts` | the ladder: min over `blocked < read < write`, clamping (FR-19), never-widen (FR-18/60), `inherit` = no row, cache max-age = 5 s, eviction on write |
| `packages/agent/src/connections/__tests__/connection-registry.service.spec.ts` | label uniqueness case-insensitive, per-provider cap 10, workspace cap 100, single-primary transaction, primary promotion on delete (FR-5), `404` cross-workspace |
| `packages/agent/src/connections/__tests__/connection-health.spec.ts` | classifier: credential rejection → `expired` at once; 1–2 failures → `degraded`; ≥3 → `unreachable`; success resets; error catalogue never carries a raw body |
| `packages/agent/src/connections/__tests__/connection-health-dispatcher.service.spec.ts` | due predicate per kind, 200 cap, in-flight claim, two concurrent ticks probe disjoint sets |
| `packages/agent/src/connections/__tests__/mcp-config-parser.spec.ts` | trailing commas, fences, comments, bare fragment, `mcpServers` wrapper, bare URL, > 10 servers, > 16 KB, non-https, bad name, secret classification |
| `packages/agent/src/connections/__tests__/mcp-auth-detect.spec.ts` | challenge → `interactive`; no challenge → `header`; malformed metadata → `unknown` + warning |
| `packages/agent/src/connections/__tests__/connection-usage-buffer.spec.ts` | flush at 10 s / 100 calls / run teardown; one upsert per `(connection, run)` |
| `packages/agent/src/vault/__tests__/vault.service.spec.ts` | key pattern, 200 cap, 8 KB cap, replace-only semantics, `referenceCount` maintenance, delete does not cascade from a Connection delete (FR-46) |
| `packages/agent/src/vault/__tests__/vault-credential-resolver.spec.ts` | resolves declared keys, **omits** unknown ones (never empty string), never logs a value, stamps `lastUsedAt` |
| `packages/agent/src/mcp/__tests__/mcp-header-credentials.spec.ts` | a header with no reference passes through byte-identical; a whole-value and an embedded reference (`Bearer {{cred.k}}`) both substitute; the input object is never mutated; a missing key is reported by name and the output keeps no partial substitution |
| `packages/agent/src/mcp/__tests__/mcp-client.service.spec.ts` (extend) | the factory receives resolved headers while the entity still holds the reference; a missing key throws before the factory is called and stamps ``Missing credential `<key>` ``; an unbound resolver fails closed; an SDK error echoing the resolved value is redacted; a spy logger and the stamped error never contain the resolved value |
| `packages/agent/src/vault/__tests__/vault-no-read-path.spec.ts` | reflective guard: no exported DTO type or controller method can return `VaultSecret['secret']` |
| `packages/agent/src/facades/__tests__/connection-scopes.facade.spec.ts` | preset lookup against a mock plugin, `[]` when undeclared, `coversTool` pattern identity with the tool-grant matcher |
| `packages/agent/src/agents/__tests__/agent-tool.connection-gate.spec.ts` | blocked Connection's tools absent from the descriptor list; preset filters write tools; enforcer unbound = today's list |

### 10.2 Controller specs (Jest, `apps/api`)

`apps/api/src/connections/connections.controller.spec.ts`,
`connection-grants.controller.spec.ts`, `mcp-onboarding.controller.spec.ts`,
`apps/api/src/vault/vault.controller.spec.ts` — following the shape of the existing
[`apps/api/src/mcp-connections/mcp-connections.controller.spec.ts`](../../../../../apps/api/src/mcp-connections/mcp-connections.controller.spec.ts)
and [`apps/api/src/tool-grants/tool-grants.controller.spec.ts`](../../../../../apps/api/src/tool-grants/tool-grants.controller.spec.ts).
Each asserts: auth guard present, cross-user is `404`, throttle decorators, DTO validation
rejects, and **no response body contains a credential value**.

### 10.3 E2E (Playwright, `apps/web/e2e/`)

| File | Golden path |
| --- | --- |
| `flow-connections-registry.spec.ts` | connect a second account, rename, re-primary, delete the primary → promotion message, provider-full disabled state, empty state |
| `flow-connection-presets.spec.ts` | default `read` at connect; widen needing re-approval → cancel leaves `read`; narrow needs nothing |
| `flow-connection-agent-grants.spec.ts` | set an Agent to `read`, another to `blocked`, a third to a clamped `write`; assert the copy and the effective values |
| `flow-connection-health-reconnect.spec.ts` | force `expired`, banner counts it, `Reconnect` returns the same row with label/preset/grants intact; `unreachable` offers no reconnect |
| `flow-connection-last-used-runs.spec.ts` | "Last used" opens the Runs list filtered to that Connection |
| `flow-vault-write-only.spec.ts` | add, list is masked, replace, delete, 200-cap copy; assert **no** network response body in the trace contains the plaintext |
| `flow-mcp-add-server.spec.ts` | paste a config with a trailing comma → parse preview → connect → tools listed; name collision; duplicate URL; unparseable; private address refused |
| `flow-mcp-interactive-signin.spec.ts` | paste URL → detected → *Open sign-in page* → card settles to Connected on its own; timeout path |

`apps/web/src/components/settings/connections/ConnectionsClient.unit.spec.tsx` and
`.../vault/VaultClient.unit.spec.tsx` cover loading / empty / error / over-limit rendering,
matching the existing `*.unit.spec.tsx` convention in `apps/web/src/components/settings/`.

## 11. Phasing

Each phase is independently shippable and leaves `develop` green on its own.

### P1 — The registry (spec FR-1…FR-15, FR-26…FR-34)

Connections table + backfill, labels, primary, presets, health sweep, reconnect, the rebuilt
Settings → Connections page with today's MCP list preserved verbatim as a tab, and the
`connection-scopes` capability with one declaring plugin.

*Ships:* migration `1791150000000`, `apps/api/src/connections/` (registry controller only),
`packages/agent/src/connections/`, the health tasks, the facade, the web registry.
*User-visible value on its own:* two accounts per provider, plain-English levels, and a page
that tells you what is broken before a Run does.
*Green on develop because:* nothing consumes the enforcer yet; the run loop is untouched.

### P2 — Grants and per-call enforcement (FR-16…FR-25, FR-35…FR-38)

Grant table, the resolution ladder, both enforcement seams, the Manage drawer's agent list, the
per-agent Connections tab, last-used attribution and the Runs link.

*Ships:* migration `1791150100000`, grants controller, `ConnectionAccessService` +
`CONNECTION_ACCESS_ENFORCER`, the two seam edits, `ConnectionUsageBuffer`.
*Green on develop because:* the enforcer is `@Optional()`; with no grant rows the ladder returns
the Connection's preset, and with no Connections it returns "allow", i.e. today's behaviour.

### P3 — Vault and MCP onboarding (FR-39…FR-58)

Vault table + controller + `VaultCredentialResolver` bound to `CREDENTIAL_RESOLVER`, the paste
parser, interactive sign-in detection and handshake, presets on the connector plugins.

*Ships:* migration `1791150200000`, `apps/api/src/vault/`, `packages/agent/src/vault/`,
`mcp-config-parser.ts`, `mcp-auth-detect.ts`, `mcp-authorize.service.ts`, the wizard.
*Green on develop because:* `EnvCredentialResolver` remains the bound implementation until the
vault module is imported; the existing manual MCP form keeps working beside the wizard.

## 12. Constitution compliance

| Principle | Status | Justification |
| --- | --- | --- |
| **I — Plugin-first** | ✅ | Presets are declared by plugins through a new optional capability; the MCP handshake is a protocol implementation that names no service; no external client is added to core. |
| **II — Capability-driven** | ✅ | `ConnectionScopeFacadeService` resolves presets by `providerId`; the only literal provider string in core is `'mcp'`, which is a **kind**, not a plugin id. |
| **III — Source-of-truth repos** | ✅ (n/a) | No content moves; `repo_connections` is referenced, never rewritten. |
| **IV — Job runtime** | ✅ | The sweep is a `schedules.task`; per-Connection probes fan out through `CONNECTION_HEALTH_DISPATCHER`. No call site imports `@trigger.dev/sdk`. |
| **V — Forward-only migrations** | ✅ | Three additive migrations, one per phase, each in the PR with its entities. No `DROP`, no rename, no type change; backfill is `INSERT … WHERE NOT EXISTS`. |
| **VI — Tests** | ✅ | 12 unit suites, 4 controller specs, 8 e2e specs, all named in §10. |
| **VII — Secret hygiene** | ✅ | Vault values are write-only and envelope-encrypted; DTO types make a plaintext return a compile error; probe errors are catalogue strings; activity-log details name fields only; no Sentry breadcrumb where a decrypted value is in scope. |
| **VIII — Plugin counts** | ✅ (n/a) | No plugin is added or removed; `docs/plugin-system/built-in-plugins.md` is untouched. |
| **IX — Behaviour-first spec** | ✅ | `spec.md` names no class, file or endpoint; every one of those lives here. |
| **X — Backwards compatible** | ✅ | `account` is not altered at all (§2.5); every existing endpoint, table, route and component keeps its shape; new columns are nullable or defaulted. |

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Backfill mislabels or mis-primaries a busy workspace | med | med | deterministic ordering by `createdAt`; suffix on collision; `health='unknown'` so nothing is asserted; re-runnable |
| The per-call gate adds latency to every tool call | low | high | process-local map, 5 s max age, no I/O on the hot path; a benchmark test asserts ≤ 2 ms P95 |
| Health sweep hammers providers | med | med | per-kind intervals, 200/tick cap, 8 s timeout, `SKIP LOCKED` claim, failures back off through `healthFailureCount` |
| The interactive MCP handshake works against one server and not the next | high | med | ship it behind the *detected* state only, fall back to the header form with a clear message, and log the metadata shape (non-secret) on failure |
| Two access matrices (tool grants + connection grants) confuse debugging | med | med | one combined explain endpoint response (`GET /api/connections/:id/grants` returns the ceiling and every layer) and one refusal reason vocabulary shared by both |
| A vault secret is orphaned when a Connection is deleted | high | low | deliberate — surfaced as "Not used by any connection" rather than deleted (FR-46) |

## 14. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [`../README.md`](../README.md)
- Constitution: [`../../../../../.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Related specs: [`../../agent-plugins/spec.md`](../../agent-plugins/spec.md),
  [`../../policy-matrices/`](../../policy-matrices/),
  [`../../plugins-capabilities/`](../../plugins-capabilities/),
  [`../../mcp-server/`](../../mcp-server/)
