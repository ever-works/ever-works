# Tenant-Scope Provider Overlay

This document specifies the **tenant-level overlay** on top of the instance-level job-runtime provider matrix. It complements (does not replace) the instance-scope provider doc at [`docs/specs/features/job-runtime-providers/providers.md`](../job-runtime-providers/providers.md), which defines what each provider can do at the operator scope. Here we describe what changes — schema, isolation, inherit/BYO/override behaviour, worker hosting, gotchas, conformance — when a tenant overrides or extends the instance default.

Scope, FR mapping, and the locked design decisions (Q1-Q5) are owned by:

- Spec: [`./spec.md`](./spec.md)
- ADR: [`../../decisions/017-tenant-scoped-job-runtime-overlay.md`](../../decisions/017-tenant-scoped-job-runtime-overlay.md)
- Jira: [EW-742](https://evertech.atlassian.net/browse/EW-742) (epic), [EW-743](https://evertech.atlassian.net/browse/EW-743) (this story)
- Settings-schema conventions (`x-secret`, `x-scope`, `x-envVar`): [`../../architecture/settings-system.md`](../../architecture/settings-system.md)

The three resolution modes referenced throughout this doc are:

- **inherit** — tenant uses the instance default; no tenant-scope credentials stored. Hybrid operator-gated platform-default policy applies (`shared` / `per-tenant` / `tiered`) per Q5.
- **BYO** — tenant brings its own provider account/instance; tenant pastes credentials; operator never sees workload data plane.
- **override** — tenant runs the same provider as the instance default but on a different account/cluster (a special case of BYO where the provider kind matches).

## Availability matrix (tenant scope)

| Provider     | inherit / shared | inherit / per-tenant                | inherit / tiered | BYO  | override | Notes                                                                          |
| ------------ | ---------------- | ----------------------------------- | ---------------- | ---- | -------- | ------------------------------------------------------------------------------ |
| Trigger.dev  | yes              | yes (PAT-provisioned, see gotcha)   | yes              | yes  | yes      | `per-tenant` cannot fully auto-provision prod key (dashboard-only); see below  |
| Temporal     | yes              | yes (control-plane call)            | yes              | yes  | yes      | Per-tenant namespace creation adds ~5-10s to tenant signup                     |
| BullMQ       | yes              | yes (DB or instance per tenant)     | yes              | yes  | yes      | >16 tenants in DB-per-tenant mode requires Redis Cluster (flag)                |
| pg-boss      | yes              | yes (DB or instance per tenant)     | yes              | yes  | yes      | `shared` policy still uses per-tenant **schemas** (Q2); tenant_id column forbidden |
| Inngest      | yes (tenant tag) | manual (no project-create REST)     | yes              | yes  | yes      | `per-tenant` mode needs operator hand-provisioning today (flag)                |

---

## Trigger.dev

### Tenant config JSON Schema

```json
{
	"$id": "https://ever.works/schemas/tenant/jobs/trigger-dev.json",
	"title": "Trigger.dev (tenant scope)",
	"type": "object",
	"x-scope": "tenant",
	"description": "Tenant overlay for Trigger.dev. When mode=inherit, all fields below are ignored and the instance default applies under the operator-selected platform-default policy (shared/per-tenant/tiered).",
	"properties": {
		"mode": {
			"type": "string",
			"enum": ["inherit", "byo", "override"],
			"default": "inherit"
		},
		"projectRef": {
			"type": "string",
			"pattern": "^proj_[a-z0-9]+$",
			"description": "Trigger.dev project reference. Required for byo/override."
		},
		"environment": {
			"type": "string",
			"enum": ["prod", "staging"],
			"default": "prod"
		},
		"secretKey": {
			"type": "string",
			"x-secret": true,
			"x-envVar": "TRIGGER_SECRET_KEY",
			"description": "Server-side prod secret (tr_prod_*). Required for byo/override."
		},
		"apiUrl": {
			"type": "string",
			"format": "uri",
			"default": "https://api.trigger.dev",
			"description": "Override for self-hosted Trigger.dev. Validated by the conformance probe on save."
		}
	},
	"allOf": [
		{
			"if": { "properties": { "mode": { "const": "inherit" } } },
			"then": { "required": ["mode"] },
			"else": { "required": ["mode", "projectRef", "secretKey"] }
		}
	]
}
```

### Isolation model

Per **Trigger.dev project**. Every tenant in `byo` or `override` gets its own project. In `inherit / per-tenant`, the platform auto-provisions a project under the operator's Trigger.dev org. In `inherit / shared`, all tenants share the operator project and are demultiplexed by tag on the run metadata.

### Inherit-mode behaviour

- **shared** — One operator project; tenant id injected as a run tag (`tenant:<id>`) and a `tenantId` payload field. Webhook handler dispatches by tag. Cheapest; weakest isolation.
- **per-tenant** — On tenant signup, platform calls `POST /api/v1/orgs/{orgId}/projects` with the operator's PAT (`tr_pat_*`) sourced from `TRIGGER_OPERATOR_PAT`. Project ref is persisted to the tenant record. See gotcha for the prod-key step.
- **tiered** — Free/low-tier tenants land in `shared`; paid tier triggers a per-tenant provision. Selection is driven by a tenant-tier predicate evaluated at signup and at tier-change events.

### BYO-mode behaviour

Tenant admin pastes `projectRef` and `secretKey` in the tenant admin UI. On save, the platform runs the EW-683 conformance probe (enqueue → status → cancel of a no-op task) against the tenant credentials before persisting. Credentials are written through the secret store, never logged. Webhook URL is `/api/jobs/webhook/<tenant-id>/trigger-dev`.

### Override-mode behaviour

Identical to BYO at the data-plane layer. The only difference is intent — the instance default is also Trigger.dev, so the tenant is moving to its own project (typically for stronger isolation, separate billing, or geo locality) rather than switching provider kinds. UI surfaces this as a one-click "use my own Trigger.dev project" option.

### Worker-hosting impact at tenant scope

Trigger.dev is push-model. Workers are hosted by Trigger.dev; the operator does not run pollers. Per-tenant routing is achieved via per-tenant webhook URLs: `POST /api/jobs/webhook/<tenant-id>/trigger-dev`. The handler resolves the tenant from the path segment, loads the tenant overlay, and validates the signature against the tenant's `secretKey`.

### Per-provider gotchas at tenant scope

- The operator PAT (`tr_pat_*`) can **create** projects via `POST /api/v1/orgs/{orgId}/projects` but **cannot** read the resulting `tr_prod_*` secret key, and cannot delete or rename projects via REST (all dashboard-only as of 2026-06). This breaks the zero-touch promise of `inherit / per-tenant`. Workarounds:
	1. **Worker self-registration (preferred)** — the deployed worker registers itself against an internal Ever Works callback and reports the prod key back. Requires a worker-side patch and a one-time bootstrap token.
	2. **Manual paste** — after auto-provision, surface the project URL in the admin UI and prompt the tenant operator to copy the prod key from the Trigger.dev dashboard. Degrades the `per-tenant` UX to a two-step flow.
- Per-project rate limits apply at the Trigger.dev account level; large `inherit / per-tenant` deployments must monitor org-wide project counts against Trigger.dev plan limits.

### Conformance scope at tenant level

Per-tenant subset of EW-683's conformance suite: enqueue, run, status, cancel, schedule, idempotency — each executed against the tenant's resolved credentials. Plus graceful-drain (enqueue under credential version `v1`, rotate to `v2`, confirm `v1`-enqueued jobs still complete) and force-invalidate (admin action immediately fails in-flight `v1` jobs and refuses `v1`-tagged dequeues).

---

## Temporal

### Tenant config JSON Schema

```json
{
	"$id": "https://ever.works/schemas/tenant/jobs/temporal.json",
	"title": "Temporal (tenant scope)",
	"type": "object",
	"x-scope": "tenant",
	"description": "Tenant overlay for Temporal. Q1: one Temporal namespace per tenant always. Namespace lifecycle is owned by the temporal plugin.",
	"properties": {
		"mode": {
			"type": "string",
			"enum": ["inherit", "byo", "override"],
			"default": "inherit"
		},
		"address": {
			"type": "string",
			"description": "Temporal frontend address (host:port). Required for byo/override.",
			"x-envVar": "TEMPORAL_ADDRESS"
		},
		"namespace": {
			"type": "string",
			"description": "Temporal namespace. Plugin-managed; tenant cannot edit when mode!=byo."
		},
		"tlsCert": {
			"type": "string",
			"x-secret": true,
			"description": "PEM-encoded client cert for mTLS (Temporal Cloud and most self-hosted setups)."
		},
		"tlsKey": {
			"type": "string",
			"x-secret": true,
			"description": "PEM-encoded client key matching tlsCert."
		},
		"apiKey": {
			"type": "string",
			"x-secret": true,
			"x-envVar": "TEMPORAL_API_KEY",
			"description": "Temporal Cloud API key (alternative to mTLS)."
		}
	},
	"allOf": [
		{
			"if": { "properties": { "mode": { "const": "byo" } } },
			"then": { "required": ["mode", "address", "namespace"] }
		}
	]
}
```

### Isolation model

Per **Temporal namespace** (Q1, locked). Every tenant — regardless of inherit/BYO/override — gets a dedicated namespace. The temporal plugin owns the create/describe/deprecate lifecycle.

### Inherit-mode behaviour

- **shared** — One platform Temporal cluster; the plugin creates a namespace per tenant (still per-tenant per Q1) on the shared cluster. "Shared" here refers to the cluster, not the namespace.
- **per-tenant** — On tenant signup, plugin calls the Temporal operator API (`OperatorService.CreateNamespace`) on the operator's cluster. Adds ~5-10s on Temporal Cloud; longer on cold self-hosted.
- **tiered** — Low-tier tenants land on a shared cluster (namespace-per-tenant); paid tier provisions a dedicated cluster or a dedicated Temporal Cloud account.

### BYO-mode behaviour

Tenant admin pastes `address`, `namespace`, and either an mTLS cert/key pair or an API key. Conformance probe runs a workflow-start + signal + query + cancel cycle against the tenant namespace. Persisted via the secret store.

### Override-mode behaviour

Identical to BYO; the distinction is that the underlying provider is also Temporal at instance scope, so the tenant is moving its namespace to a different cluster (often for region/compliance reasons).

### Worker-hosting impact at tenant scope

Temporal is pull-model. Two deployment patterns:

- **Per-tenant pollers** — one worker process per tenant namespace. Simplest, highest isolation, scales linearly with tenant count.
- **Multiplexed worker** — single worker process registers task queues across multiple tenant namespaces; tenant context derived from the namespace it polled. Cheaper at scale; requires careful credential/keyring management when tenant credentials differ.

### Per-provider gotchas at tenant scope

- Namespace creation requires a control-plane API call against the operator's Temporal cluster (Cloud or self-host). Signup latency budget must accommodate ~5-10s on Temporal Cloud.
- Temporal Cloud enforces a per-account namespace cap (defaults around 10, raisable on request) — flag this for any operator planning >10 tenants in `inherit / per-tenant` on a single Temporal Cloud account.
- Namespace deletion via REST is asynchronous and not immediate; "deprovision" in our model marks the tenant overlay deleted but leaves the namespace until the temporal plugin's GC sweeps it.

### Conformance scope at tenant level

Enqueue (workflow-start), run, status (describe-workflow), cancel, schedule (Temporal Schedules), idempotency (workflow-id reuse policy) — each against the tenant namespace. Graceful drain by credential version on the worker's client factory; force-invalidate rejects new workflow starts tagged with the rotated version.

---

## BullMQ

### Tenant config JSON Schema

```json
{
	"$id": "https://ever.works/schemas/tenant/jobs/bullmq.json",
	"title": "BullMQ (tenant scope)",
	"type": "object",
	"x-scope": "tenant",
	"description": "Tenant overlay for BullMQ. Isolation is per-queue-prefix on a shared Redis or per-Redis-DB on a per-tenant Redis. Redis Cluster required for >16 tenants in DB-per-tenant mode.",
	"properties": {
		"mode": {
			"type": "string",
			"enum": ["inherit", "byo", "override"],
			"default": "inherit"
		},
		"redisUrl": {
			"type": "string",
			"format": "uri",
			"x-secret": true,
			"x-envVar": "BULLMQ_REDIS_URL",
			"description": "Full Redis connection string (redis:// or rediss://). Required for byo/override."
		},
		"db": {
			"type": "integer",
			"minimum": 0,
			"maximum": 15,
			"description": "Redis DB index. Mutually exclusive with cluster mode."
		},
		"queuePrefix": {
			"type": "string",
			"description": "BullMQ key prefix; plugin defaults to bull:tenant:<id>: when not set."
		},
		"tls": {
			"type": "boolean",
			"default": false,
			"description": "Force TLS regardless of redis:// vs rediss:// scheme."
		}
	},
	"allOf": [
		{
			"if": { "properties": { "mode": { "enum": ["byo", "override"] } } },
			"then": { "required": ["mode", "redisUrl"] }
		}
	]
}
```

### Isolation model

Two axes, operator-selected per the platform-default policy:

- **per-queue-prefix** on a shared Redis (cheapest)
- **per-Redis-DB** on a shared Redis (max 16 tenants per Redis instance; Redis Cluster does not support DB selection, so DB-per-tenant + Cluster is incompatible — must use prefix-per-tenant in Cluster)

For `>16` tenants in DB-per-tenant mode the operator must front a Redis Cluster and switch to prefix-per-tenant within the cluster — flag this trade-off at operator config time.

### Inherit-mode behaviour

- **shared** — One platform Redis; queue prefix `bull:tenant:<id>:` per tenant.
- **per-tenant** — One Redis DB per tenant (up to 16) or one Redis instance per tenant beyond that.
- **tiered** — Free tier on shared prefix; paid tier on dedicated DB or instance.

### BYO-mode behaviour

Tenant pastes full Redis URL; optional explicit `queuePrefix` (defaults to `bull:tenant:<id>:`). Conformance probe enqueues + drains a no-op job. Credentials secret-stored.

### Override-mode behaviour

Identical to BYO at the data-plane layer; differs only by intent (tenant runs same provider kind as instance default).

### Worker-hosting impact at tenant scope

BullMQ is pull-model. Patterns:

- **Per-tenant pollers** — one Worker per tenant queue prefix; tenant context resolved from prefix at boot.
- **Multiplexed worker** — single Worker subscribes to all tenant prefixes via dynamic queue registration; tenant id derived from the job's queue name or job metadata.

### Per-provider gotchas at tenant scope

- Redis ACL granularity is per-key-pattern; per-tenant ACL rules are recommended when multiple tenants share a Redis instance, to prevent a compromised tenant credential from reading other prefixes.
- The 16-DB cap on stock Redis is a hard limit; document the path from DB-per-tenant (small operator) to Cluster + prefix-per-tenant (large operator) and flag the migration cost.
- BullMQ does not have a native concept of credential versioning — graceful drain is implemented at the worker connection-factory layer (drain old connection's in-flight, switch new pulls to the new credential).

### Conformance scope at tenant level

Enqueue, run, status, cancel, schedule (BullMQ repeatable jobs), idempotency (jobId reuse) — per-tenant prefix or DB. Plus graceful drain on credential rotation and force-invalidate rejecting jobs whose enqueue-time credential version is below the active floor.

---

## pg-boss

### Tenant config JSON Schema

```json
{
	"$id": "https://ever.works/schemas/tenant/jobs/pg-boss.json",
	"title": "pg-boss (tenant scope)",
	"type": "object",
	"x-scope": "tenant",
	"description": "Tenant overlay for pg-boss. Q2: one Postgres schema per tenant always. pg-boss plugin owns CREATE SCHEMA, the per-tenant pg-boss migrate, and DROP SCHEMA on deprovision.",
	"properties": {
		"mode": {
			"type": "string",
			"enum": ["inherit", "byo", "override"],
			"default": "inherit"
		},
		"connectionString": {
			"type": "string",
			"format": "uri",
			"x-secret": true,
			"x-envVar": "PGBOSS_CONNECTION_STRING",
			"description": "Postgres connection string. Required for byo/override."
		},
		"schema": {
			"type": "string",
			"description": "Postgres schema name. Plugin-managed; defaults to pgboss_tenant_<id>. Tenant cannot edit in inherit mode."
		},
		"ssl": {
			"type": "object",
			"description": "Optional SSL config block forwarded to pg.",
			"properties": {
				"rejectUnauthorized": { "type": "boolean", "default": true },
				"ca": { "type": "string", "x-secret": true }
			}
		}
	},
	"allOf": [
		{
			"if": { "properties": { "mode": { "enum": ["byo", "override"] } } },
			"then": { "required": ["mode", "connectionString"] }
		}
	]
}
```

### Isolation model

Per **Postgres schema** named `pgboss_tenant_<id>` (Q2, locked). A `tenant_id` discriminator column inside a shared schema is **explicitly forbidden** — even in `inherit / shared` policy, each tenant gets its own schema inside the shared platform database.

### Inherit-mode behaviour

- **shared** — One platform Postgres database; one schema per tenant inside it (`pgboss_tenant_<id>`). The "shared" axis is the database, not the schema.
- **per-tenant** — One Postgres database per tenant or one Postgres instance per tenant for stronger isolation (separate WAL, backup, and IO budget).
- **tiered** — Free tier on shared DB / per-tenant schema; paid tier on dedicated DB or dedicated instance.

### BYO-mode behaviour

Tenant pastes a connection string; the plugin connects, runs `CREATE SCHEMA IF NOT EXISTS pgboss_tenant_<id>`, applies the pg-boss migration suite inside that schema, and runs the conformance probe (publish/subscribe of a no-op job).

### Override-mode behaviour

Identical to BYO; intent-only distinction.

### Worker-hosting impact at tenant scope

pg-boss is pull-model. Each tenant schema needs polling; patterns are the same as BullMQ:

- **Per-tenant pollers** — one pg-boss instance per tenant schema.
- **Multiplexed worker** — one pg-boss instance per Postgres DB, configured with the tenant's schema via `pgboss({ schema: 'pgboss_tenant_<id>' })`; tenant context derived from the schema the job came from.

### Per-provider gotchas at tenant scope

- `CREATE SCHEMA` plus the per-tenant pg-boss migration runs on every tenant create — budget ~1-3s per tenant signup.
- `DROP SCHEMA pgboss_tenant_<id> CASCADE` on tenant deprovision is destructive and irreversible — guard behind the same confirmation flow used for tenant deletion.
- Catalog bloat (pg_class rows) scales linearly with tenant count; comfortable up to low thousands of tenants per database — beyond that, switch to DB-per-tenant or instance-per-tenant in `inherit / per-tenant` policy.
- pg-boss credential rotation = Postgres credential rotation; graceful drain runs at the pg pool layer, force-invalidate revokes the role.

### Conformance scope at tenant level

Publish (enqueue), run, status (`getJobById`), cancel, schedule (pg-boss cron), idempotency (singleton keys) — per-tenant schema. Plus graceful drain and force-invalidate by credential version.

---

## Inngest

### Tenant config JSON Schema

```json
{
	"$id": "https://ever.works/schemas/tenant/jobs/inngest.json",
	"title": "Inngest (tenant scope)",
	"type": "object",
	"x-scope": "tenant",
	"description": "Tenant overlay for Inngest. Q3: uniform inherit/BYO/override; no instance-only mode. Inngest Cloud project-create is not REST-exposed; per-tenant inherit requires a manual operator step today.",
	"properties": {
		"mode": {
			"type": "string",
			"enum": ["inherit", "byo", "override"],
			"default": "inherit"
		},
		"eventKey": {
			"type": "string",
			"x-secret": true,
			"x-envVar": "INNGEST_EVENT_KEY",
			"description": "Inngest event key used by the producer SDK. Required for byo/override."
		},
		"signingKey": {
			"type": "string",
			"x-secret": true,
			"x-envVar": "INNGEST_SIGNING_KEY",
			"description": "Signing key used to verify Inngest -> webhook callbacks."
		},
		"appId": {
			"type": "string",
			"description": "Inngest app id; defaults to ever-works-tenant-<id>."
		},
		"baseUrl": {
			"type": "string",
			"format": "uri",
			"default": "https://api.inngest.com",
			"description": "Override for self-hosted Inngest or a non-default Inngest Cloud region."
		}
	},
	"allOf": [
		{
			"if": { "properties": { "mode": { "enum": ["byo", "override"] } } },
			"then": { "required": ["mode", "eventKey", "signingKey"] }
		}
	]
}
```

### Isolation model

- **BYO / override** — per Inngest **account** (tenant brings its own Inngest Cloud account or points at a tenant-controlled self-hosted Inngest).
- **inherit / shared** — one operator Inngest account; tenant identity carried as a tag in event metadata (`data.tenantId`) and as part of the event name namespace (`tenant.<id>.<event>`).

### Inherit-mode behaviour

- **shared** — One operator account; tenant tag on every event; webhook handler demultiplexes by tag.
- **per-tenant** — One Inngest project per tenant under the operator's account. Inngest does **not** expose a project-create REST endpoint today, so this mode requires a manual operator step (or a future browser-automation workaround) — flag.
- **tiered** — Low tier on shared tag; paid tier triggers the manual per-tenant project provisioning.

### BYO-mode behaviour

Tenant admin pastes `eventKey` and `signingKey` from their own Inngest account. Conformance probe sends a test event and confirms the per-tenant webhook delivery is signed correctly.

### Override-mode behaviour

Identical to BYO; the intent is that the instance default is also Inngest but the tenant runs against its own Inngest account (typically for billing isolation).

### Worker-hosting impact at tenant scope

Inngest is push-model. Per-tenant webhook URLs: `POST /api/jobs/webhook/<tenant-id>/inngest`. The handler verifies the signature against the tenant's `signingKey`, loads the tenant overlay, dispatches into the application function registry with tenant context.

### Per-provider gotchas at tenant scope

- Inngest Cloud does not expose project-create via REST (verified 2026-06); `inherit / per-tenant` cannot be fully automated and requires an operator hand-provisioning step. Flag this in the admin UI and in the operator runbook.
- BYO tenants are billed directly by Inngest under their own Inngest Cloud account; `shared` tenants accrue against the operator's Inngest plan — surface this trade-off in the tenant admin UI.
- Signing-key rotation: Inngest supports key rotation at the account level; graceful drain is implemented by accepting both old and new signing keys during the rotation window (typically 24h), then dropping the old key on force-invalidate.

### Conformance scope at tenant level

Send (enqueue), run, status (Inngest run lookup), cancel (cancellation events), schedule (cron functions), idempotency (event id dedup) — per-tenant account or per-tenant tag. Plus graceful drain (dual-key acceptance) and force-invalidate (immediate old-key rejection).

---

## Cross-references

- Instance-scope baseline: [`../job-runtime-providers/providers.md`](../job-runtime-providers/providers.md)
- ADR: [`../../decisions/017-tenant-scoped-job-runtime-overlay.md`](../../decisions/017-tenant-scoped-job-runtime-overlay.md)
- Spec & FR mapping: [`./spec.md`](./spec.md)
- Plan & phasing: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Settings-schema conventions: [`../../architecture/settings-system.md`](../../architecture/settings-system.md)
- Jira: [EW-742](https://evertech.atlassian.net/browse/EW-742), [EW-743](https://evertech.atlassian.net/browse/EW-743)
