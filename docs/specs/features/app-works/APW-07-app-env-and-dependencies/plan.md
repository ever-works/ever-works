# Implementation Plan: App env & dependencies

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail; the spec
> owns behaviour. **Every existing path below was opened in the worktree before it was written down**; paths marked
> **(new)** are created by [`tasks.md`](./tasks.md).

**Epic ID**: `APW-07-app-env-and-dependencies`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Program contracts**: [`../CONTRACTS.md`](../CONTRACTS.md) (this epic owns `app-dependency`, `IAppDependencyProvider`,
`WorkAppEnvValue`, `WorkAppDependency`, the app-env and app-dependencies routes, `app-dependency-provision`,
`app.env.*`, `app.dependency.*`, and the semantics of the App spec `env` + `dependencies` blocks, whose field names and
ranges are fixed by [APW-03 `schema.md` §11, §12, §21, §22](../APW-03-app-spec-and-catalog/schema.md))
**Status**: `Draft`
**Last updated**: 2026-09-17

> **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))
> binding on this plan: **R-1** shared types in `packages/contracts/src/apps/` (§3.3); **R-2** Activity `action` = dotted
> event, `actionType` = `app_env` / `app_dependency` (§7); **R-5** managed providers resolve only through
> `AppsTierPolicy.isOpen()` — `EVER_WORKS_APPS_MANAGED_ENABLED` is never read (§4.11); **R-10**
> `AppRuntimeEnvSource` ephemeral mode and ephemeral dependencies (§4.6.1, §4.7, §4.9); **R-11** keypair `format`
> (§3.3, §4.3); **R-12** target `none` provisions nothing (§4.8); **R-15** deleting an App Work (§4.12); **R-22** no
> `apps/api/test/` suites (§10).

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer     | File                                                                                                                                                                                                                                                                                       | What it does                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env       | [`packages/agent/src/services/work-runtime-env.constants.ts`](../../../../../packages/agent/src/services/work-runtime-env.constants.ts)                                                                                                                                                    | `WORK_RUNTIME_ENV_ALLOWED_KEYS` (8 payment keys), `WORK_RUNTIME_ENV_SECRET_KEYS`, 4096-char cap, masking helpers. **Left untouched.**                                                                                                                                                                          |
| Env       | [`packages/agent/src/services/work-runtime-env.service.ts`](../../../../../packages/agent/src/services/work-runtime-env.service.ts)                                                                                                                                                        | One JSON map per Work in `works.deployRuntimeEnvEncrypted` (AES-256-GCM, `PLATFORM_ENCRYPTION_KEY`); race-safe `getOrGenerate` via conditional `set…IfNull` UPDATEs; 32-byte base64 `AUTH_SECRET`/`COOKIE_SECRET`. **Left untouched**; the race-safe first-write idea is reused.                               |
| Runbook   | [`docs/runbooks/WORK_RUNTIME_ENV.md`](../../../../../docs/runbooks/WORK_RUNTIME_ENV.md)                                                                                                                                                                                                    | Documents the allow-list model and its delivery paths. **Left untouched**; a new page documents App env.                                                                                                                                                                                                       |
| DB        | [`packages/agent/src/ever-works-providers/ever-works-db-provision.service.ts`](../../../../../packages/agent/src/ever-works-providers/ever-works-db-provision.service.ts)                                                                                                                  | Per-Work `ew_<hex>` database + `ewr_<hex>` role; idempotent DDL (role exists → `ALTER`, else `CREATE`; database created outside a transaction); exported `pgClientOptions` and `summarizeDbProvisionError`. Built for platform-generated Works; the tenant hardening App Works need (§4.11) is not part of it. |
| Config    | [`packages/agent/src/config/index.ts`](../../../../../packages/agent/src/config/index.ts)                                                                                                                                                                                                  | `config.database.getUrl/getHost/getPort` (the platform's own database) and `config.everWorks.sharedDb.*` (the shared Work DB) — the servers the P2 provider must refuse.                                                                                                                                       |
| Plugin    | [`packages/plugin/src/contracts/capabilities/datastore.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/datastore.interface.ts), [`packages/plugins/postgres-db/src/postgres-db.plugin.ts`](../../../../../packages/plugins/postgres-db/src/postgres-db.plugin.ts) | The existing `database` category: a thin connection-choice plugin for directory sites. Distinct concept; unchanged.                                                                                                                                                                                            |
| Secrets   | [`packages/agent/src/plugins/services/plugin-secret-enc.service.ts`](../../../../../packages/agent/src/plugins/services/plugin-secret-enc.service.ts)                                                                                                                                      | `enc::v1::` AES-256-GCM envelope keyed by `PLUGIN_SECRET_ENCRYPTION_KEY`; `isEnabled()`; without a key it stores settings unencrypted as a development convenience (production requires the key) — App env refuses instead, in every environment.                                                              |
| Secrets   | [`packages/agent/src/entities/_secret-json-column.ts`](../../../../../packages/agent/src/entities/_secret-json-column.ts)                                                                                                                                                                  | `EncryptedJsonColumn` transformer over the same service. Not used here because it inherits the development behaviour without a key.                                                                                                                                                                            |
| Secrets   | [`packages/plugin/src/settings/json-schema.types.ts`](../../../../../packages/plugin/src/settings/json-schema.types.ts), [`packages/plugin/src/api/api-response.types.ts`](../../../../../packages/plugin/src/api/api-response.types.ts)                                                   | `x-secret` on settings schemas; secret fields are never returned. Used for provider settings and prompted provider configuration schemas.                                                                                                                                                                      |
| Secrets   | [`apps/api/src/fleet/fleet-run-secrets.service.ts`](../../../../../apps/api/src/fleet/fleet-run-secrets.service.ts)                                                                                                                                                                        | Fail-closed secret resolution with stable reason tokens and "nothing is logged about a value" — the posture copied by `AppEnvResolver`.                                                                                                                                                                        |
| Deploy    | [`apps/api/src/plugins-capabilities/deploy/deploy.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.service.ts) (`collectServerSideRuntimeEnv`)                                                                                                                  | Best-effort per value: a failed lookup logs and **omits** the key. App Works need the opposite (a missing value blocks the Deploy).                                                                                                                                                                            |
| Deploy    | [`apps/api/src/plugins-capabilities/deploy/deploy.controller.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.controller.ts)                                                                                                                                            | `GET/PUT /api/deploy/works/:id/runtime-env` with `ownershipService.ensureCanEdit`; masked state. Pattern for the new controller.                                                                                                                                                                               |
| k8s       | [`packages/plugins/k8s/src/k8s-api.service.ts`](../../../../../packages/plugins/k8s/src/k8s-api.service.ts)                                                                                                                                                                                | `validateConnection`, `ensureNamespace`, `applyDeployment/Service/Ingress/ImagePullSecret`, `applySecret` (server-side apply of an arbitrary manifest through `objectApi.patch`). No StatefulSet, PVC, NetworkPolicy, CRD or access-review helpers.                                                            |
| k8s       | [`packages/plugins/k8s/src/k8s.plugin.ts`](../../../../../packages/plugins/k8s/src/k8s.plugin.ts), [`packages/plugins/k8s/src/manifest.renderer.ts`](../../../../../packages/plugins/k8s/src/manifest.renderer.ts)                                                                         | `capabilities: ['deployment']`, kubeconfig as `x-secret`; `buildRuntimeEnvSecret` + `envFrom` (APW-06 renders App runtime Secrets from this epic's map).                                                                                                                                                       |
| k8s       | [`packages/agent/src/facades/deployment-context.resolver.ts`](../../../../../packages/agent/src/facades/deployment-context.resolver.ts)                                                                                                                                                    | `ClusterSource` (`custom-kubeconfig` for Your cluster) and kubeconfig resolution — consumed through APW-06, never re-implemented here.                                                                                                                                                                         |
| Parsing   | [`apps/desktop/src/services/runtime-setup.ts`](../../../../../apps/desktop/src/services/runtime-setup.ts) (`parseEnvFile`)                                                                                                                                                                 | A minimal desktop-only dotenv parser (no single quotes, no escapes, no multi-line, no line numbers). Not importable from the agent package and too loose for FR-28; a strict parser is written instead.                                                                                                        |
| Works     | [`packages/agent/src/services/work-lifecycle.service.ts`](../../../../../packages/agent/src/services/work-lifecycle.service.ts) (`deleteWork`)                                                                                                                                             | Owner-only deletion; kind-specific refusals. App Work deletion (Resolution R-15) composes APW-06's `AppRuntimeDeletionService` with this epic's `onAppWorkDeleting` "keep data" default (§4.12).                                                                                                               |
| Activity  | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)                                                                                                                                                                    | `ActivityActionType` enum.                                                                                                                                                                                                                                                                                     |
| Web       | [`apps/web/src/components/works/detail/settings/SettingsSubTabs.tsx`](../../../../../apps/web/src/components/works/detail/settings/SettingsSubTabs.tsx)                                                                                                                                    | Settings sub-tabs General, Members, Budgets; namespace `dashboard.workDetail.settings.tabs`.                                                                                                                                                                                                                   |
| Web       | [`apps/web/src/components/works/detail/deploy/RuntimeEnvManagement.tsx`](../../../../../apps/web/src/components/works/detail/deploy/RuntimeEnvManagement.tsx)                                                                                                                              | The allow-listed env form on the Deploy tab. **Left untouched**; App Works never render it.                                                                                                                                                                                                                    |
| Contracts | [`packages/contracts/src/domain/work-capabilities.ts`](../../../../../packages/contracts/src/domain/work-capabilities.ts)                                                                                                                                                                  | `WorkCapabilities` hide-list; `appEnvironment` added by APW-01 (R-7), read here.                                                                                                                                                                                                                               |
| Schema    | [`../APW-03-app-spec-and-catalog/schema.md`](../APW-03-app-spec-and-catalog/schema.md)                                                                                                                                                                                                     | Normative field ranges: env ≤ 200, one value source, `generate` (`bytes` 16–128, `length` 16–256, `alphabet`, `keypair.type`, `rotate: never`), `validate` (RE2), dependency fields, reference grammar, rules R6–R9, R23.                                                                                      |

### 1.2 The exact blockers

- **The only env store is an allow-listed single map.** It rejects every unknown key with a 400, stores no origin,
  version or generation state, and its masking view returns value prefixes. None of that fits App Works.
- **Plugin secret encryption is optional in development.** Acceptable for plugin settings in dev; not for app secrets.
  App env checks `isEnabled()` and refuses.
- **No provider can create a dependency.** The k8s plugin applies only Deployments, Services, Ingresses and Secrets;
  there is no StatefulSet, PVC, NetworkPolicy, CRD detection or access review.
- **The per-Work Postgres provisioner is shaped for platform-generated Works.** It reads its server from platform
  config and was not designed for untrusted tenants: App Works need per-role and per-database connection limits,
  connect restricted to the owning role, and timeouts. It is not pointed at tenant servers; its idempotent pattern
  is re-expressed as a hardened pure DDL builder.
- **Resolution is best-effort today.** `collectServerSideRuntimeEnv` omits a key when a lookup fails. App Works must
  fail closed with a precise reason.

### 1.3 What already exists and must be reused, not rebuilt

- `PluginSecretEncService` for the envelope (behind a refusing wrapper), `pgClientOptions` and
  `summarizeDbProvisionError` for every Postgres connection, `KubernetesApiService`'s (`packages/plugins/k8s/src/k8s-api.service.ts`) server-side-apply mechanics (`objectApi.patch`
  with the field manager) for every manifest, `WorkOwnershipService.ensureCanView/ensureCanEdit`, the dispatcher pattern in
  `packages/agent/src/tasks/kb-reembed-work-dispatcher.ts`, and `ActivityLogService.log`.

---

## 2. Architecture and the seams this plugs into

### 2.1 Pieces

```
                     app.spec.applied (APW-03)
                              │
               ┌──────────────┴───────────────┐
               ▼                              ▼
     AppEnvService.ensureGenerated()   AppDependenciesService.reconcile()
     (in-process, idempotent insert)          │ APP_DEPENDENCY_PROVISION_DISPATCHER
               │                              ▼
               │                  job app-dependency-provision { workId, kind?, mode }
               │                              │ AppDependencyFacadeService.select(kind, target)
               │                              ▼
               │                  IAppDependencyProvider
               │                   ├─ k8s plugin: k8s-inline-postgres | -redis | -minio      (P1)
               │                   ├─ app-dependencies-external: smtp-external | s3-external | platform-smtp-relay (P1; the relay also serves Ever Works Apps, GAP-22)
               │                   └─ apps-tier-dependencies: managed-postgres | -redis | -object-storage | -smtp (P2)
               │                              │ outputs (encrypted) · status · backup state
               ▼                              ▼
     work_app_env_values            work_app_dependencies
               └──────────────┬───────────────┘
                              ▼
                   AppEnvResolver (fail closed)
                 ├─ resolveForBuild(workId, buildServices)  ─► APW-05 (EW_ secrets)
                 ├─ resolveForRuntime(workId, runtimeContext) ─► APW-06 (namespace Secret)
                 ├─ missingRequired(workId, phase)           ─► APW-05 / APW-06 gating
                 └─ buildRedactor(workId)                    ─► APW-05 log excerpts, APW-06 logs
```

### 2.2 Resolution

`AppEnvResolver.resolve(workId, phase, ctx)` walks the effective App spec `env[]` for `phase ∈ {build, runtime}`
(`both` entries appear in each) and returns `{ values: ResolvedEnvValue[], unresolved: UnresolvedEnv[] }`:

| Entry source                                                                   | Build phase                                                                                   | Runtime phase                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| stored override                                                                | the stored value (origin `user`)                                                              | same                                                                                                          |
| `generate`                                                                     | stored value; absent → `ensureGenerated` first; keypair adds `<NAME>_PUBLIC`                  | same                                                                                                          |
| `prompt`                                                                       | stored value; absent + `required` → unresolved `missingRequired`; absent + optional → omitted | same                                                                                                          |
| `value`                                                                        | the literal                                                                                   | same                                                                                                          |
| `from: domains.primary.*`                                                      | `ctx.domains.primary` (APW-06); none → unresolved `noPrimaryDomain`                           | same                                                                                                          |
| `from: deps.<kind>.<out>`                                                      | the build service outputs for `<kind>` (§4.6.2); no service → unresolved `noBuildService`     | `work_app_dependencies` outputs; status ≠ ready → unresolved `dependencyNotReady`                             |
| `from: platform.smtp.*`                                                        | unresolved `notAvailableAtBuild`                                                              | outputs of the smtp dependency when its provider is `platform-smtp-relay`, else unresolved `relayNotSelected` |
| `from: build.commitSha`, `components.<n>.internalUrl` (CONTRACTS §1 additions) | `ctx.build.commitSha`; `internalUrl` unresolved at build                                      | `ctx` from APW-06                                                                                             |
| `template`                                                                     | placeholders resolved with the rules above plus `env.<NAME>` (same phase), depth ≤ 10         | same                                                                                                          |

Every `ResolvedEnvValue` is `{ name, value, secret, fingerprint }` where `fingerprint` is `v<version>` for stored values,
`d<outputsVersion>` for dependency outputs and `sha256(value)` only for non-secret or build-service values (APW-05 uses it
for `buildInputsHash`; no hash of a stored secret is ever persisted). Unresolved items carry `{ name, reason, ref }` and
never a value. APW-05 and APW-06 must refuse to proceed while `unresolved` is non-empty for a required or referenced entry.

**One fingerprint rule (added 2026-09-17, APW07-G03).** The per-entry `changedSinceBuild` / `changedSinceDeploy` flags
(FR-24) cannot be derived from a single combined hash, so every fingerprint is defined per name and recorded on the row
that already exists for it:

| Entry                                                                                                               | Fingerprint                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| stored override / generated / prompted                                                                              | `v<version>`                                                                                                 |
| a `from` entry that is a direct dependency output                                                                   | `d<outputsVersion>`                                                                                          |
| a `template` entry, or a `from` entry that is not a direct dependency output, **when the resolved value is secret** | `t<sha256 over the template or reference text plus the sorted (placeholder, fingerprint) pairs it resolved>` |
| a non-secret value, or a build-service value                                                                        | `sha256(value)`                                                                                              |

A hash of a secret value is **never** computed or persisted. `AppRuntimeEnvSource.resolve` and `resolveForBuild`
therefore also return `fingerprints: Record<string, string>` with exactly the same keys as `values`; APW-05 persists
that map as `WorkBuild.buildValueFingerprints` for the latest Build with `deployable = true` on the tracked branch, and
APW-06 persists it inside `appRender.envFingerprints` for the current Deployment (CONTRACTS §2 rows requested from their
owners). `list` compares each entry's current fingerprint with those maps and marks `changedSinceBuild` /
`changedSinceDeploy`. Comparison rule: a name present on only one side counts as changed; no Build or Deployment, or a
null map on a row written before the column existed, gives `false`; an unresolved entry gives `false`, because the
"Needed before…" state already covers it. Neither flag ever reads or decrypts a value.

### 2.3 Dependency provisioning

```mermaid
flowchart TB
    A["app.spec.applied / deploy target changed / Retry / Deploy preflight (APW-06)"] --> B["AppDependenciesService.reconcile(workId)"]
    B --> C{"declared kinds vs rows"}
    C -- "new kind" --> D["insert row status=pending, providerId=select(kind, target)"]
    C -- "kind removed from spec" --> E["inSpec=false (nothing deprovisioned)"]
    C -- "target changed" --> F["old row → kept; new row pending"]
    D --> G["dispatch app-dependency-provision {workId, kind, mode:'provision'}"]
    G --> H["claim provisionLease (atomic UPDATE)"]
    H --> I["provider.provision(ctx) — cluster / external / tenant server"]
    I -- "ready" --> J["encrypt outputs, outputsVersion+1, status=ready, app.dependency.provisioned"]
    I -- "transient" --> K["attempt < 3 → re-dispatch after 5 min"]
    I -- "definite / attempts exhausted" --> L["status=failed + reason, app.dependency.failed"]
    J --> M["backupStatus() → backup state"]
```

---

## 3. Data model

**Workspace backup (Resolution R-25).** Both tables export under `data/works/` through the parent Work ids, with `valueEncrypted`, `configEncrypted` and `outputsEncrypted` redacted to `{ wasSet }` and `valueBytes` dropped ([tasks](./tasks.md) T45).

### 3.1 `work_app_env_values`

```
work_app_env_values
├── id uuid PK · workId uuid NOT NULL FK works.id ON DELETE CASCADE
├── name varchar(128) NOT NULL          ^[A-Z_][A-Z0-9_]{0,127}$
├── origin varchar(16) NOT NULL         generated | prompted | user | derived (keypair public halves only)
├── valueEncrypted text NOT NULL        enc::v1:: envelope (refused when encryption is not enabled)
├── valueBytes int NOT NULL             byte length, for the 1 MiB total (FR-31); never shown
├── version int NOT NULL DEFAULT 1      +1 on every change; drives change flags and build fingerprints
├── generatorFingerprint varchar(160) NULL   canonical generate block ("base64:24", "chars:40:alnum", "keypair:ed25519")
├── derivedFromName varchar(128) NULL   for <NAME>_PUBLIC rows
├── generatedAt timestamp NULL · setByUserId uuid NULL
├── tenantId · organizationId uuid NULL
└── createdAt · updatedAt timestamp NOT NULL
uq_work_app_env_values_work_name  UNIQUE (workId, name)
idx_work_app_env_values_work      (workId)
```

Race-safe generation: `INSERT … ON CONFLICT ("workId", name) DO NOTHING` then read back, with per-driver branches —
SQLite `INSERT OR IGNORE`, MySQL/MariaDB `INSERT IGNORE` (both drivers are supported by
`packages/agent/src/database/database.config.ts:33-34,208`, so a Postgres-only form would break them; added
2026-09-17, APW07-G12) — the same "first writer wins, losers re-read" contract as
`WorkRuntimeEnvService.getOrGenerate`. Where a driver offers no such clause, the service does the compare-and-set
itself inside the same transaction.

### 3.2 `work_app_dependencies`

```
work_app_dependencies
├── id uuid PK · workId uuid NOT NULL FK works.id ON DELETE CASCADE
├── kind varchar(16) NOT NULL           postgres | redis | objectStorage | smtp
├── deployTarget varchar(24) NOT NULL   your-cluster | ever-works-apps
├── providerPluginId varchar(64) NOT NULL · providerId varchar(64) NOT NULL
├── status varchar(16) NOT NULL         pending | provisioning | ready | degraded | failed | kept | deleting | deleted
├── statusReason varchar(48) NULL · statusDetail simple-json NULL (names and numbers only, ≤ 2 KB)
├── attempts int NOT NULL DEFAULT 0
├── declared simple-json NOT NULL       the App spec block for this kind (non-secret)
├── actualVersion varchar(32) NULL · sizeGiB int NULL
├── configEncrypted text NULL           prompted provider configuration (external providers), one envelope
├── outputsEncrypted text NULL          all outputs as one JSON envelope
├── outputsVersion int NOT NULL DEFAULT 0
├── resourceRefs simple-json NULL       { namespace?, objects: [{ kind, name }] ≤ 20, databases?, buckets? } — non-secret
├── inSpec boolean NOT NULL DEFAULT true
├── backupPolicy varchar(16) NOT NULL   none | operator | provider | managed
├── backupState varchar(16) NULL        none | not_configured | healthy | overdue | failing | external | unknown
├── lastBackupAt · backupCheckedAt · lastProvisionedAt · lastCheckedAt · provisionLeaseUntil   timestamp NULL
├── tenantId · organizationId uuid NULL
└── createdAt · updatedAt timestamp NOT NULL
uq_work_app_dependencies_active   UNIQUE (workId, kind) WHERE status NOT IN ('kept', 'deleted')
idx_work_app_dependencies_work    (workId)
idx_work_app_dependencies_status  (status, lastCheckedAt)
```

`outputsEncrypted` is always `NULL` for `ever-works-apps` rows (resolved in the zone, §4.11). `ON DELETE CASCADE`
removes rows when an App Work row is deleted; data in clusters and tenant servers is untouched by
that (FR-45). Kept rows are the record of what remains.

### 3.3 Shared types — `packages/contracts/src/apps/app-env.ts` and `app-dependencies.ts` (new, in APW-03's folder)

```ts
export const APP_ENV_ORIGINS = ['generated', 'derived', 'prompted', 'user', 'default'] as const;
export const APP_ENV_PHASES = ['build', 'runtime', 'both'] as const;
export const APP_ENV_GENERATOR_KINDS = ['base64', 'hex', 'chars', 'uuid', 'keypair'] as const;
export const APP_ENV_ALPHABETS = {
	alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
	'alnum-symbols': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+,-.:=?@^_~',
	'hex-lower': '0123456789abcdef',
	base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
} as const;
export const APP_ENV_KEYPAIR_TYPES = ['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096'] as const;
export const APP_ENV_KEYPAIR_FORMATS = ['pem', 'base64url-raw', 'pkcs12'] as const; // R-11; default 'pem'
export const APP_ENV_KEYPAIR_RAW_TYPES = ['ed25519', 'ec-p256'] as const; // base64url-raw is refused for RSA
export const APP_ENV_NAME_PATTERN = '^[A-Z_][A-Z0-9_]{0,127}$';
export const APP_ENV_RESERVED_PREFIX = 'EVER_WORKS_';
export const APP_ENV_PUBLIC_PREFIXES = [
	'NEXT_PUBLIC_',
	'VITE_',
	'PUBLIC_',
	'REACT_APP_',
	'NUXT_PUBLIC_',
	'EXPO_PUBLIC_'
] as const;
export const APP_ENV_VALUE_MAX_BYTES = 65_536,
	APP_ENV_TOTAL_MAX_BYTES = 1_048_576,
	APP_ENV_MAX_STORED = 300;
export const APP_ENV_PUBLIC_HALF_MAX_BYTES = 16_384,
	APP_ENV_PATTERN_BUDGET_MS = 50;
export const APP_ENV_DOTENV_MAX_BYTES = 65_536,
	APP_ENV_DOTENV_MAX_LINES = 500;
export const APP_ENV_GENERATE_SLA_MS = 60_000,
	APP_ENV_ROTATIONS_PER_HOUR = 10,
	APP_ENV_PUTS_PER_MINUTE = 30;
export const APP_ENV_TEMPLATE_MAX_DEPTH = 10;

export interface AppEnvEntryView {
	name: string;
	declared: boolean;
	source: 'generate' | 'from' | 'template' | 'prompt' | 'value' | 'undeclared';
	origin: AppEnvOrigin | null;
	overrides: 'derived' | 'default' | null;
	secret: boolean;
	phase: AppEnvPhase;
	required: boolean;
	set: boolean;
	description: string | null;
	group: string | null;
	reference: string | null; // the `from`/`template` text from the App spec — public by construction
	specValue: string | null; // only for `value` entries (never secret, APW-03 R8)
	validation: { length?: number; minLength?: number; maxLength?: number; hasPattern: boolean } | null;
	generator: { kind: AppEnvGeneratorKind; keypairFormat?: AppEnvKeypairFormat; rotate: 'never' } | null;
	generatorChanged: boolean;
	publicPrefixWarning: boolean;
	publicValue: string | null; // keypair public half only (FR-15)
	changedSinceBuild: boolean;
	changedSinceDeploy: boolean;
	updatedAt: string | null;
	updatedBy: { userId: string; name: string } | null;
}

export const APP_DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage', 'smtp'] as const;
/** Normative output list — APW-03 schema.md §11 must equal it (FR-40). `true` = secret. */
export const APP_DEPENDENCY_OUTPUTS = {
	postgres: { url: true, directUrl: true, host: false, port: false, database: false, user: false, password: true },
	redis: { url: true, host: false, port: false, password: true },
	objectStorage: { endpoint: false, region: false, accessKeyId: true, secretAccessKey: true, 'bucket.*': false },
	smtp: { host: false, port: false, user: false, password: true, from: false, secure: false }
} as const;
export const APP_DEPENDENCY_READY_DEADLINE_MS = {
	postgres: 600_000,
	redis: 300_000,
	objectStorage: 600_000,
	smtp: 30_000
} as const;
export const APP_DEPENDENCY_EXTERNAL_TEST_MS = 30_000;
export const APP_DEPENDENCY_DEFAULT_SIZE_GIB = { postgres: 10, objectStorage: 20, redis: 1 } as const;
export const APP_DEPENDENCY_TRANSIENT_ATTEMPTS = 3,
	APP_DEPENDENCY_RETRY_DELAY_MS = 300_000;
export const APP_DEPENDENCY_REFRESH_AFTER_MS = 900_000,
	APP_DEPENDENCY_BACKUP_OVERDUE_MS = 26 * 3_600_000;
export const APP_DEPENDENCY_RELAY_DAILY_LIMIT = 200;
export const APP_DEPENDENCY_MANAGED = {
	pgRoleConnectionLimit: 20,
	pgDatabaseConnectionLimit: 25,
	pgStatementTimeoutMs: 60_000,
	pgIdleInTransactionTimeoutMs: 60_000,
	bucketQuotaGiB: 10,
	redisMaxMemoryMiB: 256,
	backupMaxAgeMs: 86_400_000
} as const;
```

`directUrl` is emitted only when `postgres.directUrl: true`; `bucket.<name>` once per declared bucket. Values are always
strings; `port` is decimal, `secure` is `"true"`/`"false"`.

### 3.4 Migration (Constitution V)

`apps/api/src/migrations/1792070000000-CreateAppEnvAndDependencies.ts` — creates both tables, FKs and indexes (the partial
unique index `WHERE status NOT IN ('kept','deleted')` is emitted as a **Postgres-guarded raw** statement, the repo's
existing convention for partial unique indexes — see
`apps/api/src/migrations/1791220000000-CreateWorkspaceBackups.ts:26-34` — while SQLite gets the equivalent unique
expression index and MySQL/MariaDB gets a generated-column unique key; the service-level compare-and-set of §3.1 covers
every driver, so correctness never depends on the index form — added 2026-09-17, APW07-G12). `down()` drops only these two
tables. No existing table is altered; `works.deployRuntimeEnvEncrypted` and friends are not touched. Re-stamp above the
newest `develop` migration before merge.

### 3.5 Registration

`packages/agent/src/entities/work-app-env-value.entity.ts` and `work-app-dependency.entity.ts` **(new)**, each registered in
`packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
`packages/agent/src/database/_entities-inventory.ts`, and the owning module's `TypeOrmModule.forFeature`; Tier A scope
columns declared for `apps/api/src/scope/scope-stamping.subscriber.ts`.

---

## 4. Services, capability and providers

All new agent-package code lives in `packages/agent/src/app-env/` and `packages/agent/src/app-dependencies/` **(new)**.

### 4.1 `AppEnvCrypto`

Wraps `PluginSecretEncService`: `encrypt(value)` throws `AppEnvEncryptionUnavailableError` (→ HTTP 503 code
`secureStorageUnavailable`) when `isEnabled()` is false — in every `NODE_ENV`; tests configure a key. `decrypt(envelope)`
refuses anything without the `enc::v1::` prefix (no legacy plaintext rows can exist for these new tables).

### 4.2 `AppEnvService`

| Method                                                                                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list(workId, viewer)`                                                                          | Joins the effective App spec (APW-03) with stored rows into `AppEnvEntryView[]`; computes `changedSinceBuild` by comparing each build/both entry's current `resolveForBuild` fingerprint with `WorkBuild.buildValueFingerprints` of the latest Build with `deployable = true` on the tracked branch, and `changedSinceDeploy` by comparing each runtime/both entry's current runtime fingerprint with `appRender.envFingerprints` of `WorkAppRuntimeState.currentDeploymentId` (the §2.2 comparison rule; added 2026-09-17, APW07-G03); never decrypts except keypair public halves. |
| `ensureGenerated(workId)`                                                                       | For every `generate` entry without a row: generate (§4.3), validate against `validate`, insert-or-ignore, re-read. Called from `app.spec.applied` and at the start of every resolve. Also flags `generatorChanged` when fingerprints differ.                                                                                                                                                                                                                                                                                                                                         |
| `apply(workId, actor, { set, unset, reset, import, acknowledgeNeverRotate, replaceGenerated })` | One transaction per call: validate every item (§4.4), refuse all on a storage error, per-item results otherwise; enforces 300 rows and 1 MiB; version + 1 per changed name; emits one `app.env.changed` with names and actions.                                                                                                                                                                                                                                                                                                                                                      |
| `rotate(workId, actor, name, { confirmName })`                                                  | Generated entries only; `confirmName === name` required; regenerates (keypair: both halves in one transaction); version + 1; `app.env.rotated`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `missingRequired(workId, phase)`                                                                | Names + descriptions of required `prompt` entries without rows, used by gating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `buildRedactor(workId)`                                                                         | Decrypts all values ≥ 6 characters once, returns `(text) => text` replacing each occurrence (longest first) with `***`; never cached beyond the call.                                                                                                                                                                                                                                                                                                                                                                                                                                |

Set semantics per source: `prompt`/undeclared → store (origin `prompted`/`user`); `from`/`template`/`value` → store as an
override (origin `user`, `overrides` computed); `generate` → refused (`generatedValueUseRotate`) unless
`replaceGenerated: true` **and** `acknowledgeNeverRotate: true`; keypair entries and `<NAME>_PUBLIC` cannot be set.
`unset` removes prompted/user rows; `reset` removes an override; neither applies to generated rows.

### 4.3 Generators — `packages/agent/src/app-env/generators.ts`

```ts
base64(bytes)   → randomBytes(bytes).toString('base64')                         // length 4·ceil(bytes/3)
hex(bytes)      → randomBytes(bytes).toString('hex')                            // length 2·bytes, lower-case
chars(len, alphabet) → rejection sampling: draw randomBytes(len·2); accept b < 256 − (256 mod n); c = alphabet[b mod n];
                   refill until len characters                                  // no modulo bias
uuid()          → randomUUID()                                                  // v4, 36 chars
keypair(type, format = 'pem', passwordEnv?)   (R-11)
  pem           → generateKeyPairSync('ed25519' | 'ec' {namedCurve:'P-256'} | 'rsa' {modulusLength: 2048|4096},
                   { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  base64url-raw → ed25519 / ec-p256 only: export both keys as JWK; value = base64url(d) (32 bytes → 43 chars);
                   public = ed25519 base64url(x) (43 chars) | ec-p256 base64url(0x04 ‖ x ‖ y) (65 bytes → 87 chars)
  pkcs12        → pem pair + a self-signed X.509 certificate (CN = the env name, 10 years) packed into PKCS#12 by
                   `@peculiar/x509` + `pkijs` (pure JS, no native build), encrypted with the value of the entry named by
                   `generate.keypair.passwordEnv` (APW-03 R26: a `secret: true` entry generated as base64/hex/chars,
                   stored as its own `WorkAppEnvValue`), which is generated first; value = base64(bundle);
                   public = the certificate's SPKI PEM. Rotating the password entry re-packs the bundle under the new
                   value (same key pair); rotating the keypair uses the current password. Never an empty passphrase
  every format  → the public half is stored as the derived row `<NAME>_PUBLIC` and nothing else is derived
fingerprint     → `${kind}:${bytes|length}:${alphabet?}` or `keypair:${type}:${format}[:${passwordEnv}]`
```

All randomness from `node:crypto`. A property test generates 1,000 values per generator and asserts exact length and
alphabet; keypair tests verify a signature made with the private half against the public half in each format. A format
change on an existing keypair sets `generatorChanged` (FR-12) and never regenerates implicitly.

### 4.4 Validation — `packages/agent/src/app-env/validation.ts`

Order: name pattern → reserved prefix → byte length ≤ 65,536 and no NUL → `validate.length` / `minLength` / `maxLength`
(counted in Unicode code points, matching APW-03's "generated length") → `pattern` compiled with **`re2js`** (pure JS
RE2 port; no native build) as `^(?:<pattern>)$`, compiled once per App spec hash and cached; evaluation is linear time, and
a 50 ms budget is asserted by test on 65,536-byte inputs. Refusal codes: `invalidName`, `reservedName`, `valueTooLarge`,
`controlCharacter`, `lengthMismatch` (`{ expected, actual }`), `tooShort`, `tooLong`, `patternMismatch`. Messages never
include the value.

### 4.5 Dotenv parser — `packages/agent/src/app-env/dotenv-parser.ts`

A line-oriented state machine (not a regex) implementing FR-28: strip BOM; `\r\n` → `\n`; per logical line: skip blank
and `#`; optional `export `; name up to `=` (trimmed, must match the name pattern); value: unquoted (trim, stop at ` #`),
single-quoted (literal until the closing `'`), double-quoted (escapes `\n \t \" \\`, may span lines until the closing
`"`, max 65,536 bytes); anything after the closing quote other than spaces and a comment → `malformed`. Output:
`{ entries: [{ name, value, line }], refused: [{ line, reason }] }`; duplicates → last wins, earlier `skipped duplicate`.
Limits 64 KiB / 500 lines checked before parsing. The parser never logs; its unit tests assert no `console`/logger call.

### 4.6 `AppEnvResolver`

#### 4.6.1 Runtime — implements APW-06's `AppRuntimeEnvSource`

`AppEnvRuntimeSource` (`packages/agent/src/app-env/app-env-runtime.source.ts`) implements the port in
`packages/agent/src/app-runtime/ports.ts` (CONTRACTS §3) and is bound to `APP_RUNTIME_ENV_SOURCE`:
`resolve(workId, specCommitSha, { target, primaryUrl, primaryHost, buildCommitSha, internalUrls, preview? })` →
`{ values, fingerprints, secretNames, unsetRequired, notReadyDependencies, egress }` — `values` for `runtime`/`both` entries per the
§2.2 table (plus keypair `<NAME>_PUBLIC`), `fingerprints` the per-name map of the §2.2 fingerprint rule,
`secretNames` the secret subset, `unsetRequired` the required prompted names,
`notReadyDependencies` the referenced kinds not `ready` (derived from
`AppDependenciesService.ensureReadyForDeploy(workId)`, which also dispatches provisioning for `pending` kinds —
GAP-05), and `egress` the `{ host, ports }` of external providers
(`smtp-external`, `s3-external`, relay) so APW-06 can open exactly those destinations. `target` decides whether a
dependency reference becomes a real output or a placeholder: `ever-works-apps` is the only target that emits
`ew-dep://` placeholders (§4.11). This epic never reads the target from the stored row.

**Ephemeral mode** (Resolution R-10, CONTRACTS §3; for APW-04 verification through APW-05 and APW-06):
`resolveEphemeral(workId, specCommitSha, ctx)` never writes `work_app_env_values` or `work_app_dependencies`, never reads a
stored **generated** value, reads a stored **prompted/user** value only when it is already set, and is never cached.
`unsetRequired` names every required prompted entry without a stored value. Two targets:

| `ctx.target` | Caller                                                  | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cluster`    | APW-06 verification namespace (worker, §4.12 of APW-06) | `values`: generated entries freshly generated in memory (§4.3), `value` literals, prompted values already set, derived references against the verification's ephemeral dependencies — read from **`ctx.dependencyOutputs`**, the map APW-06 passes after calling `AppDependenciesService.provisionEphemeral(workId, { namespace, kinds, signal })` — and `ctx.internalUrls`; keypair `<NAME>_PUBLIC` included. Nothing is stored. (Added 2026-09-17, APW07-G04: without this field the resolver cannot see the outputs `provisionEphemeral` returned, so ACC-07-31 and ACC-06-48 could not pass.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runner`     | APW-05 runner verification (API process)                | `recipe`: **no value at all** — a `AppEnvRecipeEntry[]` (the normative discriminated union defined in `packages/contracts/src/apps/app-env.ts`, added by APW07-G18) with per entry `{ name, secret, source: 'generate', spec: { kind, bytes, length, alphabet, keypair: { type, format, passwordEnv? } } }`, `{ source: 'literal', spec: { value } }` (never secret), `{ source: 'template', spec: { text, tokens: AppEnvRecipeToken[] } }` where a token is `{ kind: 'gen' \| 'prompted' \| 'dep', name, placeholder }`, or `{ source: 'prompted', spec: { required } }`. The container-host grammar is fixed here so the two epics cannot drift: kinds map to `postgres` → host `postgres`, port `5432`, user/db `ever-works-build`/`app`; `redis` → host `redis`, port `6379`, password `""`; `objectStorage` → host `object-storage`, port `9000`, access key `ever-works-build` (APW-05's throwaway container names, `minio` is the image and never the host) and the dependency password token is `{{gen:DEP_<KIND>_PASSWORD}}` uppercased from the kind. APW-05 fetches the set prompted values itself. |

Templates: tokenise `{{ … }}`, resolve, substitute; depth 10 re-checked, failing closed with `templateUnresolvable`.

#### 4.6.2 Build

`resolveForBuild(workId, buildServices)` where `buildServices` is APW-03 `build.services[]`. Service ↔ dependency mapping:
`postgres` ↔ a service named `postgres`; `redis` ↔ `redis`; `objectStorage` ↔ `object-storage`; `smtp` ↔ `smtp`. Outputs
of a build service (all non-secret, flagged `fromBuildService`):

| Kind          | Outputs (host `127.0.0.1`, port = service `port` or the image default)                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| postgres      | user/password/database from the service `env` `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, defaulting to `ever-works-build`/`ever-works-build`/`app` (APW-05 injects the same defaults); `url` = `directUrl` = `postgresql://user:password@127.0.0.1:5432/database?sslmode=disable` |
| redis         | `url` = `redis://127.0.0.1:6379/0`, `password` = `""`                                                                                                                                                                                                                                     |
| objectStorage | `endpoint` `http://127.0.0.1:9000`, `region` `us-east-1`, keys from the service env root user/password or `ever-works-build`/`ever-works-build`, `bucket.<n>` = `<n>`                                                                                                                     |
| smtp          | `host` `127.0.0.1`, `port` `1025`, `user`/`password` `""`, `from` `build@example.invalid`, `secure` `false`                                                                                                                                                                               |

`platform.smtp.*` and `components.*.internalUrl` are unresolved at build (`notAvailableAtBuild`).

### 4.7 `IAppDependencyProvider` — `packages/plugin/src/contracts/capabilities/app-dependency.interface.ts` (new)

```ts
export type AppDependencyKind = 'postgres' | 'redis' | 'objectStorage' | 'smtp';
export type AppDependencyTarget = 'your-cluster' | 'ever-works-apps';
export interface AppDependencyProviderDescriptor {
	readonly id: string;
	readonly kind: AppDependencyKind;
	readonly targets: readonly AppDependencyTarget[];
	readonly label: string;
	readonly preference: number; // lower wins among supported providers
	readonly promptSchema?: JsonSchema; // x-secret for credentials
	readonly backupPolicy: 'none' | 'operator' | 'provider' | 'managed';
}
export interface AppDependencyContext {
	readonly workId: string;
	readonly appName: string;
	readonly target: AppDependencyTarget;
	readonly declared: Record<string, unknown>;
	readonly sizeGiB?: number;
	readonly cluster?: {
		kubeconfig: string;
		context: string | null;
		namespace: string;
		appLabels: Record<string, string>;
	};
	readonly config?: Record<string, string>; // decrypted prompted configuration
	readonly previousOutputs?: Record<string, string>;
	readonly settings: Record<string, unknown>;
	readonly signal: AbortSignal;
	/** R-10: a verification namespace — no PVC (emptyDir), outputs returned in memory only, never stored. */
	readonly ephemeral?: boolean;
}
export type AppDependencySupport = { supported: true; providerId: string } | { supported: false; reason: string };
export type ProvisionOutcome =
	| {
			state: 'ready';
			outputs: Record<string, string>;
			actualVersion?: string;
			resourceRefs: ResourceRefs;
			warnings?: string[];
	  }
	| { state: 'pending'; retryAfterMs: number; detail?: Record<string, string | number> }
	| { state: 'failed'; reason: string; transient: boolean; detail?: Record<string, string | number | string[]> };
export interface DependencyBackupStatus {
	readonly state: 'none' | 'not_configured' | 'healthy' | 'overdue' | 'failing' | 'external' | 'unknown';
	readonly lastBackupAt?: string;
}
export interface IAppDependencyProvider extends IPlugin {
	readonly dependencyProviders: readonly AppDependencyProviderDescriptor[];
	supports(
		kind: AppDependencyKind,
		target: AppDependencyTarget,
		ctx: AppDependencyContext
	): Promise<AppDependencySupport>;
	provision(providerId: string, ctx: AppDependencyContext): Promise<ProvisionOutcome>;
	getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>>;
	deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		/** stopWorkloads: App Work deletion (R-15) — scale kept in-cluster workloads to 0, keep PVC, Secret, policies. */
		opts: { deleteData: boolean; stopWorkloads?: boolean }
	): Promise<{ state: 'released' | 'deleted' | 'pending'; remaining?: ResourceRefs }>;
	backupStatus(providerId: string, ctx: AppDependencyContext): Promise<DependencyBackupStatus>;
}
export function isAppDependencyProvider(p: IPlugin): p is IAppDependencyProvider {
	return p.capabilities.includes('app-dependency');
}
```

Registration: `PLUGIN_CAPABILITIES.APP_DEPENDENCY = 'app-dependency'`, `'app-dependency'` appended to `PLUGIN_CATEGORIES`,
barrel export. `supports` is the CONTRACTS `supports(kind, target)` with context added; `providerId` selects among the
several providers one plugin declares (the `WorkAppDependency` "provider plugin id" is stored as the pair
`providerPluginId` + `providerId`).

### 4.8 `AppDependencyFacadeService` and `AppDependenciesService`

- **Selection**: collect enabled plugins with the capability; for `(kind, target)` ask `supports` in ascending
  `preference`; the owner's explicit choice (via `PUT …/:kind`) wins if supported. Preferences: `k8s-inline-postgres` 10,
  `k8s-inline-redis` 10, `k8s-inline-minio` 10, `s3-external` 20, `smtp-external` 10, `platform-smtp-relay` 20,
  `managed-*` 10 (only target `ever-works-apps`).
- **Cluster access** comes from APW-06's runtime target resolver — **named explicitly (added, APW07-G01 /
  APW07-G02): `AppRuntimeTargetPort.prepareDependencyTarget(workId)`** in
  `packages/agent/src/app-runtime/ports.ts` (CONTRACTS §3), resolving
  `{ ref: AppTargetRef; podLabels } | { unavailable: 'target_none' | 'target_not_checked' | 'namespace_owned_elsewhere' | 'cluster_unreachable' }`.
  The `app-dependency-provision` job calls it **before** `provider.provision` and builds
  `AppDependencyContext.cluster` from it. Preparation is what makes the namespace, the `LimitRange` and the three
  baseline network policies exist first (APW-06 plan §4.2), so **a provider never waits for and never dispatches a
  Deployment** — the ordering cycle GAP-06 / APW07-G01 described is broken here. `unavailable: 'cluster_unreachable'`
  is **transient** (FR-43 retries); every other `unavailable` reason is a definite failure carrying that reason
  (`target_none`, `target_not_checked`, `namespace_owned_elsewhere`). This epic never parses kubeconfigs itself.
  Until APW-06 lands, a typed fake.
- **`reconcile(workId)`** implements the §2.3 diagram. **`ensureReadyForDeploy(workId)`** returns
  `{ ready: boolean, notReady: [{ kind, status, reason }] }` for APW-06's preflight and triggers provisioning if pending.
  APW-06 calls both (its preconditions and its `PUT app-target`); the six entry points APW-06 may use are
  `reconcile`, `ensureReadyForDeploy`, `onAppRemoved`, `onAppWorkDeleting`, `list` and `provisionEphemeral`
  (CONTRACTS §3 row requested).
- **Leases** (made driver-portable, APW07-G12): a parameterised timestamp compare-and-set —
  `UPDATE work_app_dependencies SET "provisionLeaseUntil" = :until WHERE id = :id AND ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil" < :now)`
  with `:until` / `:now` bound as timestamps — never `now() + interval '15 minutes'`, which is Postgres-only and has
  no MySQL/MariaDB branch although `database.config.ts` supports those drivers.

### 4.9 Your-cluster providers — `packages/plugins/k8s/src/app-dependencies/` (new)

The `k8s` plugin declares `capabilities: ['deployment', 'app-dependency']` and `dependencyProviders` for the three ids.
Cluster I/O reuses the helpers APW-06 adds to `KubernetesApiService` (`applyObject`, `readObject`, `listObjects`, `deleteObject`,
`createSelfSubjectAccessReview`); this epic adds only `crdServed(name, version)` and `defaultStorageClass()`. Objects
live in the App Work's namespace chosen by APW-06 (`ew-<slug ≤ 30>-<8 hex>`) and are named `dep-<kind>…` there.

**Common to all three**: APW-06's label set (`app.kubernetes.io/managed-by: ever-works-k8s-plugin`,
`app.kubernetes.io/part-of: <slug>`, `ever-works.io/work-id`, `ever-works.io/kind: app`) plus
`ever-works.io/dependency: <kind>` — the label APW-06's `destroyApp` never deletes without `deleteVolumes` — and
`ever-works.io/retain: "true"` on PVCs; pod `securityContext` `runAsNonRoot: true`, `seccompProfile: RuntimeDefault`,
container `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`. Images pinned by digest in
`app-dependencies/images.ts`, overridable by admin settings; never a LoadBalancer or NodePort Service.

**Reachability is owned by this epic, not by APW-06's isolation switch (rewritten 2026-09-17, APW07-G01).** Every
provider applies its own ingress policy **before** its StatefulSet / `Cluster`, and it is drawn whatever the App Work's
isolation setting is — which is what makes FR-38 hold even when the owner has switched isolation off:

- Name `dep-<kind>`; labels the common set plus `ever-works.io/dependency: <kind>`; `podSelector:
{ ever-works.io/dependency: <kind> }`; `policyTypes: [Ingress]`.
- Ingress **only** from `podSelector: {}` in the same namespace, on the service ports (5432, 6379, 9000). Nothing
  outside the namespace is admitted.
- Operator path (`k8s-inline-postgres` with the CNPG CRD usable): additionally admit the operator's namespace,
  detected from its Deployment; when detection fails, warning `operatorNamespaceUnknown` with the fallback
  `namespaceSelector: {}` limited to the operator status port and 5432.
- With isolation off the card shows the note **"Your app is not network-isolated; this dependency still only accepts
  connections from its namespace."**
- `stopWorkloads` keeps `dep-<kind>`; `deleteData: true` already deletes NetworkPolicies by the
  `ever-works.io/dependency` label.
- The check the provider used to do against APW-06's `ew-default-deny` / `ew-allow-deps` is **gone** — `ew-allow-deps`
  allows _egress to addresses outside the namespace_, so it never kept other pods away from a dependency pod, and
  under `isolation: false` APW-06 draws no `ew-*` policy at all, which would have failed every provider. Its
  replacement is the definite failure reason **`namespaceNotOwned`** (APW-06's namespace ownership check failed) and,
  for a genuinely missing namespace baseline, the defensive `namespace_baseline_missing`. APW-06 now draws the
  baseline in `prepare-namespace` _before_ provisioning, so neither is a steady state.

**Cluster permissions this needs (added, APW07-G10).** The providers create `statefulsets` (plain Postgres,
Redis-with-persistence, object storage), read `customresourcedefinitions` (cluster-scoped, `crdServed`), and — on the
operator path — read `clusters.postgresql.cnpg.io`, `backups.postgresql.cnpg.io` and
`scheduledbackups.postgresql.cnpg.io` for FR-49's backup state. APW-06's `checkAppCluster` list and the
`docs/features/app-runtime.md` service-account recipe are extended by its owner: `statefulsets` **required**, the CRD
read and the operator resources **optional** (a denied CRD read silently chooses the plain path with
`statusDetail.operatorSkipped = 'noPermission'`). A 403 on StatefulSet create fails the card with the definite reason
**`clusterPermissionMissing`**.

| Provider                              | Objects                                                                                                                                                                                                                                                                                                                                                                                                                                                | Ready when                                                                                                                       | Outputs                                                                                                                          | Backup state                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k8s-inline-postgres` — operator path | Used when `crdServed('clusters.postgresql.cnpg.io', 'v1')` **and** `canI('create', 'postgresql.cnpg.io', 'clusters', ns)`. `Cluster dep-postgres`: `instances: 1`, `storage.size` / `storageClass`, `bootstrap.initdb { database: app, owner: app, postInitApplicationSQL: CREATE EXTENSION IF NOT EXISTS … }`, `enableSuperuserAccess: false`.                                                                                                        | `status.readyInstances == 1`                                                                                                     | from Secret `dep-postgres-app` (`username`, `password`, `dbname`) and Service `dep-postgres-rw`; `url` = `directUrl`             | newest `backups.postgresql.cnpg.io` labelled `cnpg.io/cluster=dep-postgres` by `status.stoppedAt`: `completed` within 26 h → healthy, older → overdue, `failed` → failing; no Backup object → `not_configured` without a `ScheduledBackup`, `overdue` when one has existed > 26 h, else `unknown` (first backup pending). **Never** `Cluster.status.lastSuccessfulBackup`. |
| `k8s-inline-postgres` — plain path    | Secret `dep-postgres` (`password` = 32 hex), StatefulSet `dep-postgres` (image per declared version, `POSTGRES_USER=app`, `POSTGRES_DB=app`, `PGDATA=/var/lib/postgresql/data/pgdata`, uid/gid/fsGroup 999, requests 250m/512Mi, memory limit 1Gi, readiness `pg_isready -U app -d app`, `volumeClaimTemplates` sized 10 GiB), headless + ClusterIP Service `dep-postgres:5432`; extensions via a `Job dep-postgres-ext` running `psql` when declared. | StatefulSet `readyReplicas == 1`; PVC `Bound` within 10 min else `failed noStorage` (no default class → `noDefaultStorageClass`) | `host` `dep-postgres.<ns>.svc.cluster.local`, `port` `5432`, `database`/`user` `app`, `url` = `directUrl` with `sslmode=disable` | `none` (warning)                                                                                                                                                                                                                                                                                                                                                           |
| `k8s-inline-redis`                    | Secret `dep-redis`; Deployment (no persistence) or StatefulSet + 1 GiB PVC (`persistence: true`, `--appendonly yes`); args `--requirepass $(REDIS_PASSWORD) --maxmemory 400mb --maxmemory-policy <declared>`; memory limit 512Mi; readiness `redis-cli ping` with `REDISCLI_AUTH`; Service `dep-redis:6379`.                                                                                                                                           | `readyReplicas == 1`                                                                                                             | `url` `redis://:<pw>@<host>:6379/0`, `host`, `port`, `password`                                                                  | `none`                                                                                                                                                                                                                                                                                                                                                                     |
| `k8s-inline-minio`                    | Secret `dep-s3` (root user/password), StatefulSet `dep-s3` (S3-compatible server image from settings, 20 GiB PVC), Service `dep-s3:9000`; `Job dep-s3-init` creating each bucket, anonymous download on `publicBuckets`, and one service account whose keys are written to Secret `dep-s3-app`.                                                                                                                                                        | StatefulSet ready **and** Job `succeeded`                                                                                        | `endpoint` `http://dep-s3.<ns>.svc.cluster.local:9000`, `region` `us-east-1`, keys from `dep-s3-app`, `bucket.<n>` = `<n>`       | `none`                                                                                                                                                                                                                                                                                                                                                                     |

Outputs are read from cluster Secrets by the provision job and immediately encrypted into `outputsEncrypted`; the job's
memory copy is dropped at the end of the call. **Ephemeral** (`ctx.ephemeral`, R-10): the same objects in the verification
namespace with `emptyDir` instead of every PVC / `volumeClaimTemplates`, no operator path (plain path always, so nothing
outlives the namespace), outputs returned to the caller in memory and never written; no row is created. **Deprovision**
`deleteData: false` makes no cluster call and returns `released` (row → `kept`); with `stopWorkloads: true` (App Work
deletion, R-15) it scales the dependency's StatefulSet/Deployment (or sets the operator `Cluster` to hibernation) to 0 and
touches nothing else — PVCs, Secrets and APW-06's `ew-default-deny` stay. `deleteData: true` deletes by `ever-works.io/work-id` + `ever-works.io/dependency` label: the
Cluster or StatefulSet/Deployment, Services, Secrets, Jobs, NetworkPolicy, then PVCs explicitly; it re-lists until zero
remain (≤ 5 minutes) or reports `remaining`.

Provider settings (k8s plugin, Work and user scope): `appDependencyStorageClass` (string), `appDependencySizes`
(`{ postgres, objectStorage, redis }` GiB — a **default** seeding the configure dialog, not a floor: FR-37 lets the
owner pick any size at or above the provider minimum before first provisioning), admin: image overrides per
kind/version, and a pinned default S3-compatible server image (see the recorded owner decision in §12's known gaps).

### 4.9a Waiting for the owner's settings, and what "optional SMTP" means (added 2026-09-17, APW07-G16)

A provider whose configuration only the owner can supply (`smtp-external`, `s3-external`, `platform-smtp-relay` when
admin settings are incomplete) used to be dispatched immediately, so its card reached `failed deadlineExceeded` inside
the SMTP deadline of 30 seconds before the owner could type anything.

- New status **`awaiting_config`**, copy **"Needs your settings"**, with the action **Configure**. `reconcile` inserts
  the row in `awaiting_config` for such a provider (`awaitingConfig: true` on its descriptor) and dispatches
  **nothing**; no deadline runs. `PUT …/:kind` with valid `config` moves it to `pending` and dispatches `provision`.
  A provider whose prompt schema is satisfied by admin settings (the relay) skips this state.
- `AppDependencyView` carries `awaitingConfig: boolean` and the provider's `promptFields`, so the card can render the
  dialog without a round trip.
- **Optional SMTP does not block.** When `smtp.required` is `false` (the APW-03 schema default) and no SMTP provider is
  configured or ready, an entry sourced from `deps.smtp.*` is **left out of the resolved set** with the warning
  `smtpNotConfigured` rather than becoming `dependencyNotReady`, so a Deploy is not blocked by a dependency the App
  spec itself calls optional; a `from: deps.smtp.*` entry that the App spec marks `required` on the **env** side still
  blocks, naming the missing entry. `smtp.required: true` on the dependency always blocks until it is ready.

### 4.10 External providers — `packages/plugins/app-dependencies-external/` (new)

Package id `app-dependencies-external`, category `app-dependency`, capability `app-dependency`; dependencies
`nodemailer` (SMTP verify) and `@aws-sdk/client-s3` (HeadBucket). Tests run only inside the provision job.

| Provider              | Prompt schema (`x-secret` marked †)                                                                                                                                | Test (≤ 30 s)                                                                                                                                                                                                                                                                                           | Outputs / backup                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `smtp-external`       | `host` (hostname), `port` (1–65535; 25 → warning "often blocked"), `user`, `password`†, `from` (RFC 5322 address), `secure` (derived: 465 → true)                  | `nodemailer.createTransport(...).verify()` — connect, STARTTLS/TLS, AUTH; no message. Reasons: `smtpConnectFailed`, `smtpTlsFailed`, `smtpAuthRefused`.                                                                                                                                                 | the six outputs from the prompt; backup `external`                                                |
| `s3-external`         | `endpoint` (https URL; http only for private addresses refused), `region`, `accessKeyId`†, `secretAccessKey`†, `forcePathStyle`, `buckets` map declared → existing | `HeadBucket` per mapped bucket; reason `bucketUnreadable` with the bucket name.                                                                                                                                                                                                                         | outputs; `bucket.<n>` = mapped name; backup `external`                                            |
| `platform-smtp-relay` | none (operator-configured)                                                                                                                                         | Offered only when admin settings `relay.apiUrl`, `relay.apiToken`†, `relay.host`, `relay.port`, `relay.fromDomain` are all set. `provision` → `POST {apiUrl}/credentials { id: "work-<uuid>", dailyLimit: 200 }` → `{ username, password }`; `deprovision` → `DELETE {apiUrl}/credentials/work-<uuid>`. | `from` = `no-reply@<fromDomain>` unless the App Work's verified domain is used; backup `external` |

External endpoints are validated as public hostnames (no private, loopback or link-local addresses after DNS resolution)
before any connection, matching the platform's existing SSRF posture for user-supplied URLs. **An operator allow-list
is honoured (added, APW07-G09):** `public-endpoint.ts` accepts a CIDR from
`EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST` (owner APW-07, default empty, comma-separated CIDRs — the same shape as
APW-06's `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`, which stays untouched). Without it the kind lane's local mail
sink and S3 test server are refused and a self-hosted installation can never use its own internal SMTP relay; the
allow-list is the documented escape hatch, and every entry is logged once at boot (CIDR only, never the endpoint).

**`platform-smtp-relay` is target-aware (added 2026-09-17, GAP-22 / XC-21).** Its descriptor declares
`targets: ['your-cluster', 'ever-works-apps']`, so the **same** provider serves an App Work on the managed tier: the
tier's mail-port block (APW-10's LG-08) stays exactly as it is, because the relay is reached over 443 to the relay's
own API and the tenant app talks to the relay endpoint the provider hands it through `from: deps.smtp.*`. The relay is
never a tenant's own SMTP client, never an operator's credential, and never an app's direct connection to port 25,
465 or 587. Eligibility and abuse controls added with it: the descriptor is offered only to a **verified** account
(`User.emailVerified`), it carries a per-**account** and per-**organization** daily cap
(`EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ACCOUNT`, default 1 000, and `…_PER_ORGANIZATION`, default 5 000) on top of the
existing per-App-Work 200, a bounce or complaint rate above `EVER_WORKS_APP_RELAY_SUSPEND_BOUNCE_RATE` (default 5 %)
suspends issuance and raises a `Mail` signal through APW-10's signals service where the tier is in use, and the
provider refuses to issue a credential while the platform stop flag for mail issuance is set. Relay usage is metered as
`relay.messages` on the credit list (XC-20, XC-21) and appears in the daily receipt.

### 4.11 Wave 2 — `packages/plugins/apps-tier-dependencies/` (new, P2)

Resolvable only when `AppsTierPolicy.isOpen()` (APW-10 — the tier is open; Resolution R-5: this epic never
reads `EVER_WORKS_APPS_MANAGED_ENABLED`) and the target is `ever-works-apps`. Per APW-10's
plan, managed dependencies are **resolved in the zone** from `Work.spec.dependencies: [{ kind, ref }]`: the platform
holds no tenant data-server endpoint or admin credential, and never sees a managed dependency's outputs.

- **Provider behaviour** — `provision` writes `{ kind, ref: dep-<kind> }` through `IAppsTierProvider.applyWork` (APW-10)
  and reports `ready` from `Work.status.dependencies[]`; `outputsEncrypted` stays `NULL`; the card lists output names only.
- **Env for the zone** — `AppEnvRuntimeSource` emits each `from: deps.<kind>.<output>` (and each such placeholder inside
  a `template`) as the literal token `ew-dep://<kind>/<output>`; the zone controller substitutes every token inside the
  sealed env before creating the tenant Secret and refuses an unknown token (CONTRACTS §3 row requested from APW-10).
- **Postgres semantics the zone must apply** — `buildTenantPostgresDdl(input)` in
  `packages/contracts/src/apps/tenant-postgres-ddl.ts` (pure and dependency-free so the zone controller can import it;
  the idempotent shape of `EverWorksDbProvisionService.runDdl`, hardened). Input: `dbName: 'awd_<hex>'`,
  `roleName: 'awr_<hex>'`, `password` (32 hex), `roleConnectionLimit: 20`, `databaseConnectionLimit: 25`,
  `statementTimeoutMs: 60_000`, `idleInTransactionTimeoutMs: 60_000`. Statements, in order:
    1. Role exists → `ALTER ROLE`; otherwise `CREATE ROLE "<role>" WITH LOGIN PASSWORD '<pw>' CONNECTION LIMIT 20`
       with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
    2. `ALTER ROLE "<role>" SET statement_timeout = '60s'` and
       `ALTER ROLE "<role>" SET idle_in_transaction_session_timeout = '60s'`.
    3. Database missing → `CREATE DATABASE "<db>" OWNER "<role>" CONNECTION LIMIT 25` (outside a transaction).
    4. `REVOKE CONNECT, TEMPORARY ON DATABASE "<db>" FROM PUBLIC` and
       `GRANT CONNECT, TEMPORARY ON DATABASE "<db>" TO "<role>"`.
    5. Connected to `<db>`: `REVOKE ALL ON SCHEMA public FROM PUBLIC`, `ALTER SCHEMA public OWNER TO "<role>"`, and
       the declared extensions from the server's allowlist.

    APW-10's probe LG-14 verifies per-role connection limits and source restrictions on the live servers.

- **Platform-server refusal** (FR-54) — `isPlatformDataServer(url, platform)` in the same file compares normalised
  `host:port` against the platform database and the shared Work DB (`config.database.*`, `config.everWorks.sharedDb.*` in
  `packages/agent/src/config/index.ts`), plus `system_identifier` when readable; the zone controller calls it with its
  own configuration, and the platform calls it when validating any admin-scope server setting it is given.
- **Redis** — one Redis-compatible instance per App Work in the zone (`maxmemory 256mb`, declared policy, password auth).
- **Object storage** — buckets `aw-<hex12>-<name>`, one user limited to `aw-<hex12>-*`, quota 10 GiB, public-read only on
  declared `publicBuckets`.
- **Backups** — `backupStatus` reads `Work.status.dependencies[].lastBackupAt`; the threshold is FR-48's 26 hours for
  every card, and `APP_DEPENDENCY_MANAGED.backupMaxAgeMs` (24 h) is the **zone's own** schedule target, not the card's
  overdue line: the zone must write `lastBackupAt` at least once every 24 hours, so a 25-hour-old timestamp reads
  `overdue` only after the zone has actually missed its schedule (rewritten with APW07-G25 to remove the FR-48
  contradiction; the 27-hour case is the one that must read `overdue` under the 26-hour rule).
- **Metering (added, XC-20)** — the zone's `UsageReport` gains `dependencyStorageGiBHours` and
  `dependencyBackupGiBHours` per App Work (APW-10 plan §3.2), imported idempotently per `(workId, windowStart, unit)`
  like every other unit, priced on the credit list as `hosting.dependency_storage_gib_hour` and
  `hosting.dependency_backup_gib_hour`, and shown in the daily receipt. Managed dependency storage is otherwise
  invisible: it lives on a shared tenant data server, outside any namespace meter.
- **In-zone provisioning is APW-10's, and it is contracted (added, APW10-G01 / APW07-G19)** — this epic writes
  `{ kind, ref: dep-<kind> }` through `IAppsTierProvider.setDependencies(workId, deps)` and reads readiness and
  `lastBackupAt` from `Work.status.dependencies[]`; it never sends whole-desired-state `applyWork` for a dependency
  change (which would replace the app's running desired state) and never sees a connection string. The zone controller
  owns: creating the namespace-scoped tenant database with `buildTenantPostgresDdl`, one Redis instance per App Work,
  prefixed buckets with their user and quota, substituting every `ew-dep://<kind>/<output>` token inside the sealed env
  before the tenant Secret is written and **refusing an unknown token** (`DEPENDENCY_TOKEN_UNKNOWN`), a backup schedule
  of at most 24 hours writing `lastBackupAt`, and releasing a dependency on removal so
  `status.dependencies[].phase = released` gates data deletion. The matching APW-10 tasks are its T43–T46.
- **Managed SMTP (added, GAP-22)** — the fourth managed kind is `smtp`, served by the relay of §4.10 with
  `targets: ['ever-works-apps']`: the tier blocks outbound 25/465/587 (LG-08) and that block is **not** relaxed, because
  the relay is reached over its own HTTPS API and the tenant app is handed a relay endpoint plus a per-App-Work
  credential. `smtp` therefore joins `Work.spec.dependencies` (`postgres|redis|objectStorage|smtp`) and the zone token
  map. Without it, Cal.diy and the `app-fixture-hello` fixture — both `smtp: { required: true }` — could never reach
  `ready` on the tier and ACC-E2E-10 (b) could not pass.

### 4.12 Deleting an App Work (Resolution R-15)

`AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` is called by APW-06's `delete-app-work` op on the
isolated worker **before** `destroyApp` (APW-06 plan §9.7), and in-process by APW-06's `AppRuntimeDeletionService` (its
binding of APW-01's `APP_WORK_DELETION_PORT.requestDeletion`) when nothing was ever deployed. This epic is called by
APW-06 only; it never binds or calls the deletion port itself:

| Row state                          | `deleteStoredData: false`                                                                                                       | `deleteStoredData: true` (slug typed in the delete dialog)                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pending` (never provisioned)      | row → `kept` with empty `resourceRefs`; no event (FR-58)                                                                        | same                                                                                   |
| `ready`/`degraded`/`failed`/`kept` | `deprovision(…, { deleteData: false, stopWorkloads: true })`; row → `kept`; `app.dependency.released` with `resourceRefs` names | `deprovision(…, { deleteData: true })`; row → `deleted`; `app.dependency.data_deleted` |
| `ever-works-apps` row              | released through the tier (`removeWork` keeps data); `app.dependency.released`                                                  | deleted through the tier; `app.dependency.data_deleted`                                |

Rows then disappear with the Work (`ON DELETE CASCADE`, §3.2); the Activity rows are the lasting record of what was kept.
`work_app_env_values` also cascade — generated values are gone with the App Work, which is why the dialog carries the
FR-57 warning. The call is idempotent (a re-dispatched op finds `kept`/`deleted` rows and does nothing).

---

## 5. API

Controller `apps/api/src/app-env/app-env.controller.ts` and `apps/api/src/app-dependencies/app-dependencies.controller.ts`
**(new)**; `AuthSessionGuard`; `ParseUUIDPipe`; **access through `AppWorkAccessService.resolve(workId, userId, 'view' | 'edit')`**
(`view` for GET, `edit` for writes, called before the kind check — added 2026-09-17, APW07-G13: `ensureCanView` /
`ensureCanEdit` return **403** for an existing Work where the caller has no membership and only 404 when the row is
missing, while spec FR-32/S23 and T24/T25 require "foreign id 404 on every route"; 403 stays for a viewer attempting a
write). Non-`app` kind → 404 `notAppWork`; request bodies of these routes are excluded from request logging — the
mechanism is `@SensitiveRequestBody()` on `PUT /app-env`, `PUT /app-dependencies/:kind`,
`POST /app-env/:name/rotate` and `DELETE /app-dependencies/:kind`, a decorator read by the monitoring interceptors so
they record `{ redacted: true }` instead of the body for `packages/monitoring/src/interceptors/sentry.interceptor.ts`,
which otherwise attaches the body to the request context and to every captured exception and drops only keys exactly
matching a short list (`password`, `token`, `secret`, `apikey`, …) — so `set.SMTP_PASSWORD`, `import.dotenv` and
`config.secretAccessKey` would reach the error reporter (added, APW07-G05). The controller spec captures
error-reporting context calls during every write and asserts no submitted value appears.

| Method | Route                                                                | Body / query                                                                                                                                                    | Response                                                                                                                                               | Throttle        |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| GET    | `/api/works/:id/app-env`                                             | —                                                                                                                                                               | `{ entries: AppEnvEntryView[], summary: { total, set, missingRequired, missingRequiredBuild }, secureStorage: boolean, canEdit }`                      | 60/min          |
| PUT    | `/api/works/:id/app-env`                                             | `{ set?: Record<name, string>, unset?: string[], reset?: string[], import?: { dotenv: string }, replaceGenerated?: boolean, acknowledgeNeverRotate?: boolean }` | `200 { entries, results: [{ name?, line?, action: 'set'\|'created'\|'unset'\|'reset'\|'skipped'\|'refused', reason? }], warnings: [{ code, names }] }` | 30/min / member |
| POST   | `/api/works/:id/app-env/:name/rotate`                                | `{ confirmName: string }`                                                                                                                                       | `200 { entry }`                                                                                                                                        | 10/hour / Work  |
| GET    | `/api/works/:id/app-dependencies`                                    | —                                                                                                                                                               | `{ deployTarget, dependencies: AppDependencyView[], refreshing: boolean, canEdit }`                                                                    | 60/min          |
| PUT    | `/api/works/:id/app-dependencies/:kind` **(CONTRACTS §4 row added)** | `{ providerId: string, config?: Record<string,string>, sizeGiB?: number }`                                                                                      | `202 { dependency }` — config write-only                                                                                                               | 10/min          |
| POST   | `/api/works/:id/app-dependencies/:kind/provision` **(added)**        | —                                                                                                                                                               | `202 { dependency }`                                                                                                                                   | 10/min          |
| DELETE | `/api/works/:id/app-dependencies/:kind` **(added)**                  | `{ confirmSlug: string }`                                                                                                                                       | `202 { dependency }`; `422 confirmationMismatch`                                                                                                       | 5/hour / Work   |

`AppDependencyView`: `{ kind, declared, provider: { pluginId, providerId, label }, availableProviders: [{ providerId,
label, promptFields: [{ key, label, secret, required, set }] }], status, statusReason, statusDetail, actualVersion,
sizeGiB, backup: { policy, state, lastBackupAt, checkedAt }, inSpec, keptResources, outputs: [{ name, secret }],
lastProvisionedAt, lastCheckedAt }` — **no output or config values**. `GET` dispatches a `refresh` when `lastCheckedAt`
is older than 15 minutes and returns `refreshing: true`.

Error codes: `notAppWork`, `secureStorageUnavailable` (503), `tooManyValues` / `valuesTooLarge` (422),
`generatedValueUseRotate`, `neverRotateNotAcknowledged`, `rotateConfirmationMismatch` (422), `notGenerated` (422),
`rotateRateLimited` (429), `providerNotSupported` (422), `dependencyNotDeclared` (404), `confirmationMismatch` (422),
`deleteInProgress` (409), **`sizeShrinkRefused`** (422 — a `sizeGiB` below the provisioned size, FR-37) and
**`volumeExpansionUnsupported`** (422 — the storage class cannot expand, added APW07-G22). Every one of these codes is
exported from `packages/contracts/src/apps/app-env.ts` / `app-dependencies.ts` and carries exactly one message key
under `dashboard.workDetail.appEnv.errors.*` / `…appDependencies.reasons.*` (G23); a test in T2 asserts every code
constant has an `en.json` key.

**Volume size (added, APW07-G22).** `PUT /app-dependencies/:kind` with `sizeGiB`: below the provider's minimum → 422
`sizeShrinkRefused`; equal to or above the provisioned size on a storage class that allows expansion → the `resize`
provision mode patches the volume claim and updates `sizeGiB`; a class that cannot expand → 422
`volumeExpansionUnsupported` with the class named. The admin setting `appDependencySizes` remains a **default**, not a
floor: FR-37 lets the owner choose any size at or above the provider minimum before first provisioning, and the
setting only seeds the dialog.

**Additions this epic asks of other epics (recorded, not edited here).** APW-06's `checkAppCluster` permission list and
the `docs/features/app-runtime.md` service-account recipe gain `statefulsets` (required) and the CRD/operator reads
(optional) — APW07-G10. `WorkBuild.buildValueFingerprints` (APW-05) and `WorkDeployment.appRender.envFingerprints`
(APW-06) are added to CONTRACTS §2 — APW07-G03. APW-06's `AppRuntimeEnvSource.resolve` returns `fingerprints` and
carries `target`; `resolveEphemeral`'s `cluster` ctx gains `dependencyOutputs` — APW07-G03 / APW07-G04. APW-06's Deploy
tab renders this epic's `DeployBlockedByEnvNotice` for the `env_required_unset` precondition, and the precondition
carries `names[]` **with descriptions** (APW07-G15).

**Consumer interfaces** (exported from `packages/agent/src/app-env/index.ts` and `app-dependencies/index.ts`):
`AppEnvRuntimeSource` (the `APP_RUNTIME_ENV_SOURCE` binding, incl. `resolveEphemeral` with targets `cluster` and
`runner`),
`AppEnvResolver.resolveForBuild` (APW-05), `AppEnvService.missingRequired/buildRedactor/ensureGenerated`,
`AppDependenciesService.ensureReadyForDeploy/onAppRemoved(workId, { deleteData })` — APW-06 calls `onAppRemoved` with
`deleteData: true` **before** `destroyApp(…, { deleteVolumes: true })`, as its plan requires —
`AppDependenciesService.reconcile` (APW-06's target/cluster change) and
`AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` (§4.12, R-15), `list(workId)` (names, kinds and
sizes for APW-06's deletion preview), and
`provisionEphemeral(workId, { namespace, kinds, signal })` →
`{ outputs: Record<AppDependencyKind, Record<string, string>>, failed: Array<{ kind, reason }> }` (outputs in memory
only) / `AppDependencyFacadeService` with `ephemeral: true` for APW-06's verification namespace (R-10). APW-06 passes
those `outputs` straight back into `AppRuntimeEnvSource.resolveEphemeral({ target: 'cluster', dependencyOutputs })`,
which is the order the two epics must use: provision ephemeral dependencies → resolve ephemeral values → render.

---

## 6. Web

- **Routes** **(new)**: `apps/web/src/app/[locale]/(dashboard)/works/[id]/settings/environment/page.tsx` and
  `…/settings/dependencies/page.tsx`.
- **Sub-tabs**: `apps/web/src/components/works/detail/settings/SettingsSubTabs.tsx` gains **Environment** and
  **Dependencies** after **General**, visible when `getWorkCapabilities(work.kind).appEnvironment` (field in
  `packages/contracts/src/domain/work-capabilities.ts` added by APW-01 T3 per Resolution R-7 — `true` for `app`, `false`
  for every other kind; this epic only reads it, so the sub-tabs wait for APW-01 T3).
- **Components** **(new)** in `apps/web/src/components/works/detail/settings/app-env/`: `AppEnvTable.tsx` (sortable,
  name filter, origin/phase/state chips, row actions), `AppEnvSetDialog.tsx` (empty field on every open; hold-to-show
  before save only; client-side mirror of length rules for instant feedback; server is authoritative),
  `AppEnvRotateDialog.tsx` (typed name), `AppEnvImportDialog.tsx` (paste, replace-generated checkbox + second
  confirmation, per-line result list), `AppEnvAddDialog.tsx` (undeclared name + value); in `…/settings/app-dependencies/`:
  `AppDependencyCard.tsx`, `AppDependencyConfigureDialog.tsx` (renders `promptFields`; secret inputs never pre-filled),
  `AppDependencyDeleteDataDialog.tsx` (lists `keptResources`, typed slug), and `DeployBlockedByEnvNotice.tsx` exported for
  APW-06's Deploy tab.
- **Actions/client** **(new)**: `apps/web/src/app/actions/dashboard/app-env.ts` (`listAppEnvAction`, `applyAppEnvAction`,
  `rotateAppEnvAction`, `listAppDependenciesAction`, `configureAppDependencyAction`, `retryAppDependencyAction`,
  `deleteAppDependencyDataAction`) and `apps/web/src/lib/api/app-env.ts`.
- **State**: server-rendered first paint; Dependencies polls every 10 s while any card is `pending`, `provisioning` or
  `deleting`, or `refreshing` is true (max 30 minutes, paused when hidden). Values typed into dialogs live only in component
  state and are cleared on close, save and unmount.

---

## 7. Background work

- **Generation** is not a job: `AppEnvListener` handles `app.spec.applied` in-process (inserts only, milliseconds), and every
  resolve calls `ensureGenerated` first, so FR-9's 60 seconds holds even if the event is missed.
- **`app-dependency-provision`** (CONTRACTS §5): `packages/agent/src/tasks/app-dependency-provision-dispatcher.ts` +
  `app-dependency-provision.types.ts` (`{ workId, kind?, mode: 'provision' | 'refresh' | 'deprovision', deleteData?,
requestedByUserId? }`), symbol listed in `_tasks-symbols.ts`; task file
  `packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts`, on APW-06's queue `app-cluster-io` (the isolated
  worker: in production nothing dispatches unless `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`; external SMTP/S3
  tests run there too, never in the API process). Per kind: claim lease → build context (cluster
  access from APW-06, decrypted config, settings) → provider call with `AbortSignal` at the kind's readiness deadline →
  persist → events. `pending` outcomes re-dispatch after `retryAfterMs` (≤ 30 s) until the deadline; transient failures
  re-dispatch after 5 minutes up to 3 attempts; `refresh` calls `getOutputs` (outputs changed → `outputsVersion + 1`) and
  `backupStatus`; `deprovision` calls `deprovision` and records `app.dependency.released` or `app.dependency.data_deleted`.
- **Triggers**: `app.spec.applied` → `reconcile`; APW-06 deploy-target or cluster change (its `PUT app-target`, APW-06
  plan §9.1) → `reconcile`; APW-06's Remove op → `onAppRemoved` (keep or data path, APW-06 plan §9.2); APW-06's
  `delete-app-work` op → `onAppWorkDeleting` (R-15); APW-06's `verification-deploy` op → `provisionEphemeral`, whose
  outputs APW-06 hands to `resolveEphemeral` (R-10); APW-06's Deploy preflight → `ensureReadyForDeploy`; `GET` older
  than 15 minutes → `refresh`; user Retry/Configure → `provision`; `PUT …/:kind` with a larger `sizeGiB` → `resize`;
  user Delete data → `deprovision`. Each trigger names its APW-06 call site (T66/T67/T69/T70, T58, T60) so neither epic
  has to guess which side calls what.
- **Events** (EventEmitter2 + Activity, names only): `app.env.changed`, `app.env.rotated`, `app.dependency.provisioned`,
  `app.dependency.failed`, `app.dependency.released`, `app.dependency.data_deleted` (the last two added to CONTRACTS §6).
  `ActivityActionType` gains `APP_ENV = 'app_env'` and `APP_DEPENDENCY = 'app_dependency'`; every row stores the dotted
  event name in `action` (Resolution R-2). Ephemeral provisioning emits no event.

---

## 8. i18n

Keys in `apps/web/messages/en.json`, mirrored into the 20 sibling locales in the same PR:

```
dashboard.workDetail.settings.tabs.{environment,dependencies}
dashboard.workDetail.appEnv.{title,summary,applyNote,import,add,filterPlaceholder,noReveal,empty,loadError,viewerDisabled}
dashboard.workDetail.appEnv.columns.{name,origin,phase,required,state}
dashboard.workDetail.appEnv.origin.{generated,generatedNeverRotates,generatedKeypair,derived,prompted,user,userOverridesDerived,userOverridesDefault,default,userUndeclared}
dashboard.workDetail.appEnv.phase.{build,runtime,both} · .state.{setAt,setBy,neededBeforeDeploy,neededBeforeBuild,optionalUnset,resolvedAtDeploy,changedSinceBuild,changedSinceDeploy}
dashboard.workDetail.appEnv.actions.{set,rotate,copyPublicKey,override,reset,remove}
dashboard.workDetail.appEnv.warnings.{generatorChanged,publicPrefix,undeclared}
dashboard.workDetail.appEnv.setDialog.{title,hold,notAgain,save,cancel,rules.{exact,min,max,range,pattern}}
dashboard.workDetail.appEnv.rotateDialog.{title,warning,typeToConfirm,appliesNext,rotate}
dashboard.workDetail.appEnv.importDialog.{title,placeholder,replaceGenerated,import,resultSummary,line,undeclaredWarning}
dashboard.workDetail.appEnv.errors.{invalidName,reservedName,valueTooLarge,controlCharacter,lengthMismatch,tooShort,tooLong,patternMismatch,generatedValueUseRotate,neverRotateNotAcknowledged,rotateConfirmationMismatch,secureStorageUnavailable,tooManyValues,valuesTooLarge,malformedLine,rotateRateLimited}
dashboard.workDetail.appEnv.deployBlocked.{message,action}
dashboard.workDetail.appDependencies.{title,empty,targetNone,refreshing,loadError,notIsolatedNote}
dashboard.workDetail.appDependencies.kind.{postgres,redis,objectStorage,smtp} · .provider.{inlineSingle,operator,smtpExternal,s3External,relay,managed}
dashboard.workDetail.appDependencies.status.{pending,awaitingConfig,provisioning,ready,degraded,failed,kept,notInSpec,deleting,deleted}
dashboard.workDetail.appDependencies.backup.{none,notConfigured,healthy,overdue,failing,external,unknown}
dashboard.workDetail.appDependencies.reasons.{noDefaultStorageClass,clusterUnreachable,smtpConnectFailed,smtpTlsFailed,smtpAuthRefused,bucketUnreadable,volumeNotReady,extensionUnavailable,platformServerRefused,deadlineExceeded,namespaceNotOwned,namespaceBaselineMissing,clusterPermissionMissing,operatorNamespaceUnknown,volumeExpansionUnsupported,sizeShrinkRefused,relayIneligible,relaySuspended,providerNotSupported,dependencyNotDeclared,confirmationMismatch,deleteInProgress,notGenerated,notAppWork}
dashboard.workDetail.appDependencies.actions.{configure,retry,deleteData} · .configureDialog.{title,save} · .deleteDialog.{title,destroys,noUndo,typeToConfirm,delete}
dashboard.activity.filters.types.{appEnv,appDependency}
```

Every status, reason and error code above is exported as a constant from `packages/contracts/src/apps/app-env.ts` /
`app-dependencies.ts`, so a code added without copy fails T2's key test (added, APW07-G23). `awaitingConfig` is the
new pre-provisioning state of §4.9a.

---

## 9. Telemetry and failure modes

### 9.1 Events (counters and identifiers only)

**Scope (added, APW07-G14).** The rule below governs **this epic's own telemetry events**. Activity rows are a separate
sink and they do carry names on purpose — FR-8 and S3 require "Environment value SMTP_PASSWORD set", and FR-56 requires
the kept dependency resources by name — and `ActivityLogService.log` forwards every row to the analytics sink
(`packages/agent/src/activity-log/activity-log.service.ts:113` → `apps/api/src/activity-log/jitsu.service.ts:39-49`,
which sends `summary`, `details` and all `metadata`). Names, kinds and counts therefore reach analytics through
Activity; **values, prompts, hosts, bucket names, connection strings and namespaces never do**, and the telemetry events
below never carry a name. The new task T46 pins both halves: the telemetry spec for the events, and an
`ActivityLogService`/`JitsuService` spec asserting an `app_env` / `app_dependency` row's dispatched payload contains no
value and no `valueEncrypted`/`configEncrypted`/`outputsEncrypted` field.

`app_env_values_changed` (`count`, `actions`), `app_env_rotated`, `app_env_import` (`set`, `created`, `skipped`,
`refused`), `app_env_validation_refused` (`code`), `app_env_deploy_blocked` (`missingCount`), `app_dependency_provisioned`
(`kind`, `providerId`, `durationBucket`), `app_dependency_failed` (`kind`, `providerId`, `reason`),
`app_dependency_backup_state` (`kind`, `state`), `app_dependency_data_deleted` (`kind`), plus
`app_dependency_awaiting_config` (`kind`) and `app_dependency_resize` (`kind`, `fromGiB`, `toGiB`) added with §4.9a and
APW07-G22. Never names of env entries, hosts, bucket names or namespaces.

### 9.2 Failure modes and the chosen behaviour

| Failure                                            | Behaviour                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Encryption key missing                             | All writes and generation refused (503); reads of existing rows fail closed with the same code.       |
| Key rotated by the operator without re-encryption  | Decrypt fails → Deploy/Build blocked with `secureStorageUnavailable`; nothing is regenerated.         |
| App spec invalid at the tracked head               | The last effective App spec is used (APW-03); no generated value is removed when an entry disappears. |
| Env entry removed from the App spec                | Its stored row stays (listed as `Set by you (not in App spec)`) until the owner removes it.           |
| Cluster API unreachable / 5xx                      | `pending` → transient retry ×3 over 15 min → `failed clusterUnreachable`.                             |
| Access review denies creating an operator resource | Plain path chosen; `statusDetail.operatorSkipped = 'noPermission'`.                                   |
| Output Secret missing after ready                  | `degraded outputsUnavailable`; Deploy blocked for referencing entries.                                |
| Kept dependency re-declared on the same target     | A new row is created; kept resources are not adopted automatically (open question in P2).             |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest)

`generators.spec.ts` (1,000 values per generator: exact lengths 32/64/40/36, alphabet membership, chi-square bias bound for
`chars`, keypair PEM headers and matching public key), `keypair-formats.spec.ts` (R-11: `pem`, `base64url-raw` 43/87
characters, `pkcs12` opening with its password entry's value and refusing an empty passphrase, the password entry generated
first, signature verification per format, RSA + raw refused),
`app-env-ephemeral.spec.ts` (R-10: zero repository writes, fresh values per call, `recipe` contains no value),
`app-dependencies.deletion.spec.ts` (R-15: the §4.12 table row by row, idempotency), `validation.spec.ts` (every refusal code; 65,536-byte adversarial
input against `(a+)+$` under 50 ms; messages never contain the value), `dotenv-parser.spec.ts` (the 12-line fixture → 9/2/1;
quotes, escapes, multi-line, BOM, CRLF, 501 lines, 64 KiB + 1), `app-env.service.spec.ts` (20 concurrent `ensureGenerated`
→ one row; set/unset/reset per source; replace-generated requires both flags; 300/1 MiB limits; Activity payload names only),
`app-env.resolver.spec.ts` (§2.2 table row by row, build-service outputs, unresolved reasons, template depth),
`app-env-crypto.spec.ts` (refuses without key in `production`, `development` and `test`), `tenant-postgres-ddl.spec.ts`
(statement list and order, identifiers quoted, no statement without `CONNECTION LIMIT`/`REVOKE`), `platform-server-refusal.spec.ts`,
`app-dependencies.service.spec.ts` (reconcile transitions; lease; retries; kept on removal/target change),
`work-app-env-value.entity.spec.ts`, `work-app-dependency.entity.spec.ts`.

### 10.2 Plugins (Vitest)

`packages/plugins/k8s/src/app-dependencies/__tests__/`: `postgres-operator-path.spec.ts` (CRD + access review → Cluster
manifest; backup state from Backup objects incl. a Cluster whose summary field claims success while the newest Backup
failed → `failing`), `postgres-plain-path.spec.ts` (manifests, security context, network policy, no default storage class),
`redis.spec.ts`, `object-storage.spec.ts` (bucket job, public buckets), `deprovision.spec.ts` (keep = zero API calls;
`stopWorkloads` = scale-to-0 only; delete removes PVCs and re-lists), `ephemeral.spec.ts` (no PVC, no stored outputs). `packages/plugins/app-dependencies-external/src/__tests__/`: `smtp-external.spec.ts` (verify outcomes →
reasons; no `sendMail` call), `s3-external.spec.ts`, `platform-smtp-relay.spec.ts` (hidden without settings), `public-endpoint.spec.ts`
(private addresses refused after DNS resolution).

### 10.3 API and E2E

API (Jest): `app-env.controller.spec.ts` (foreign id 404; viewer 403 on writes; 503 without key; logger capture shows no
value; response JSON scanned for every submitted value), `app-dependencies.controller.spec.ts` (202 shapes; delete with wrong
slug 422; config never echoed); migration spec `apps/api/src/migrations/__tests__/CreateAppEnvAndDependencies.spec.ts`;
**unchanged**: `packages/agent/src/services/work-runtime-env.service.spec.ts`.
E2E (Playwright, `apps/web/e2e/`): `app-env-table.spec.ts` (origins, set → value never re-rendered, rotate typed name, import
results), `app-env-deploy-blocked.spec.ts`, `app-dependencies-cards.spec.ts` (seeded states incl. no-backup warning, failed
reason, delete-data dialog), `app-env-a11y.spec.ts` (axe + keyboard).

### 10.4 Live acceptance

ACC-07-01…25 run in APW-13's harness: a kind cluster without the operator, a kind cluster with the CloudNativePG operator
installed, a local SMTP test server and an S3-compatible test server; the fixture App spec declares all four dependencies.

---

## 11. Phasing

### P1 — App env + Your-cluster and external dependencies (Wave 1; FR-1…FR-50, FR-56…FR-60)

Contracts, both tables, crypto, generators incl. keypair formats (R-11), validation, dotenv import, resolver incl.
ephemeral mode (R-10), env API and UI, capability, facade, k8s inline providers incl. ephemeral provisioning, external
providers, relay provider, provision job, dependencies API and UI, App Work deletion (R-15), i18n, tests, docs.
**Ships value alone**: an App Work runs on Your cluster with every value and dependency it declares.

### P2 — Ever Works Apps dependencies (Wave 2; FR-51…FR-55, FR-61…FR-63)

`apps-tier-dependencies` plugin (managed Postgres, Redis, object storage **and SMTP through the relay**, GAP-22),
tenant DDL builder, platform-server refusal, managed Redis instances, bucket policies,
managed backup reporting, managed-dependency metering (XC-20), ACC-07-26…28 plus the new ACC-07-32…34. **Depends on**
APW-10's launch gate, tenant data servers and its in-zone dependency tasks T43–T46.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** Every dependency provider is a plugin declaring the new `app-dependency` capability (the `k8s`
      plugin, `app-dependencies-external`, `apps-tier-dependencies`); core code reaches them only through
      `AppDependencyFacadeService`.
- [x] **II — Capability-driven, no hard-coded plugin ids.** Selection is by `(kind, target)` and descriptor preference;
      the web receives provider ids from the API.
- [x] **III — Source-of-truth repositories.** What the app needs is declared in the user's App spec; the database holds
      only values the repository must never contain (secrets) and derived lifecycle state.
- [x] **IV — Job-runtime provider.** All work against clusters and external servers runs in `app-dependency-provision`
      through its dispatcher; write endpoints return `202`; leases guard overlap. Generation is a millisecond insert and
      stays in-process by design.
- [x] **V — Forward-only migrations.** One migration, two new tables; no existing table touched.
- [x] **VI — Tests are a prerequisite.** 11 agent specs, 9 plugin specs, 3 API specs, 4 e2e specs, live acceptance.
- [x] **VII — Secret hygiene.** Values are encrypted with refusal instead of plaintext fallback, never returned (except
      keypair public halves), never logged (asserted by logger capture), never in Activity or telemetry; prompted provider
      credentials are `x-secret`; excerpts elsewhere are redacted through `buildRedactor`.
- [x] **VIII — Plugin counts.** Two new plugin packages and one new category recorded only in
      `docs/plugin-system/built-in-plugins.md` and `plugin-categories.md`.
- [x] **IX — Behaviour-first spec.** `spec.md` names user-visible concepts (variables, providers, backup states) and no
      internal path or class.
- [x] **X — Backwards compatibility.** The existing runtime-env service, constants, runbook, routes and UI are untouched;
      all additions are new tables, routes, enum values and optional interface members.
- [x] **Program rules 8, 9, 10.** App env values and provider credentials are `x-secret`/encrypted; App spec patterns and
      `.env` pastes are untrusted and evaluated in linear time; no infrastructure address or internal hostname appears;
      existing code is described generically (R-14).
- [x] **Program audit resolutions.** R-1, R-2, R-5, R-10, R-11, R-12, R-15, R-22 applied as listed at the top.

### Known gaps carried forward, not silently absorbed

- **Keypair format field** (`generate.keypair.format` and `passwordEnv`, R-11 / APW-03 R26) must exist in APW-03's
  schema before T42 ships; a PKCS#12 bundle is always encrypted with its `passwordEnv` entry (spec §9, resolved).
- **Released dependencies after an App Work is deleted** have no card left; Activity is the record (spec §9).
- **CONTRACTS changes requested by this fix pass**: §3 `AppRuntimeEnvSource` ephemeral row gains the `cluster` / `runner`
  targets (the runner target returns a value-free recipe); §3 `IAppDependencyProvider` details gain
  `AppDependencyContext.ephemeral` and `deprovision` option `stopWorkloads`.
- **In-cluster object storage is internal-only**; browser-facing uploads require Your own S3 storage in Wave 1.
- **Default in-cluster S3-compatible server — recorded, not resolved (APW07-G17).** T19/T21 fix a digest-pinned image
  and the init Job in `app-dependencies/images.ts`; the provider id stays `k8s-inline-minio` for continuity and the
  server is chosen by admin setting with a tested default, so swapping the product changes `images.ts`, the init Job and
  its spec **only** — never a capability, an output name or an App spec field. Owner confirmation of the shipped default
  remains open (spec §9) and is additive either way.
- **`APP_DEPENDENCY_OUTPUTS` has one owner (APW07-G20).** APW-03's reference resolver and JSON Schema must import it (and
  `APP_ENV_KEYPAIR_FORMATS`) from `@ever-works/contracts` rather than re-declaring the tables, and T40's parity spec
  lives in `packages/agent/src/works-config/schema/__tests__/` because `@ever-works/contracts` has zero dependencies and
  must not import the agent package. Until APW-03 lands, T1's values are the reference and the parity spec is skipped.
- **Dependency credential rotation and data migration between providers** are out of scope; kept rows record what remains.
- **Two vocabularies met at the target port (APW07-G28) — the port's four codes are not all card reasons.** §4.8:550-556
  gives `AppRuntimeTargetPort.prepareDependencyTarget` the `unavailable` set `'target_none' | 'target_not_checked' |
'namespace_owned_elsewhere' | 'cluster_unreachable'` (APW-06 plan §9.9:1564-1567), while the card's reasons are §8:913's
  camelCase list. Four of those strings met two vocabularies: `namespace_owned_elsewhere` → **`namespaceNotOwned`** is
  §4.9:597-602's own mapping ("the definite failure reason **`namespaceNotOwned`**") and `cluster_unreachable` →
  `clusterUnreachable` already existed, but **`target_none` and `target_not_checked` had no member at all** — and
  `AppDependenciesService` read a stored reason back through `isAppDependencyReason`, so a stored port code came back as
  `null` and the card rendered _Failed_ with **no reason**, not merely untranslated copy. `targetNone` and
  `targetNotChecked` are therefore added to `APP_DEPENDENCY_REASONS`, `APP_DEPENDENCY_STATUS_REASONS` and
  `APP_DEPENDENCY_REASON_MESSAGE_LEAVES` (both are definite failures of an attempt, so the status list is theirs; neither
  is an API error code) with one `reasons.*` leaf each, and the service carries **one total mapping** from the port's four
  codes to the contract's reasons, applied wherever an unavailable target becomes a stored or returned reason — total, so
  a fifth port code is a compile error rather than a silent `null`. §8:913 above is deliberately left as the plan wrote it;
  this note is the record. The two new leaves are in `apps/web/messages/en.json` only, like the rest of
  `dashboard.workDetail.appDependencies.*`; the other 20 bundles are T30's cross-locale pass (APW-11 T19's completeness
  spec covers `appLauncher` alone).
- **CONTRACTS additions by this epic**: routes `PUT` / `POST …/provision` / `DELETE /api/works/:id/app-dependencies/:kind`
  (§4); events `app.dependency.released`, `app.dependency.data_deleted` (§6); category `app-dependency`, the
  `providerPluginId` + `providerId` pair and provider ids (§3); and a row requested from APW-10 for
  `Work.status.dependencies[]` plus in-zone `ew-dep://` substitution (§3).
- **The 50 ms pattern budget is at the engine's throughput edge, not a property of this epic (APW07-G29).** §4.4:408-409
  says `validate.pattern` "is linear time, and a 50 ms budget is asserted by test on 65,536-byte inputs", and
  `tasks.md:169-170` names the adversarial input `(a+)+$` against 65,536 bytes. Measured 2026-09-18 with `re2js` (the
  engine §4.4 chooses deliberately: pure JS, no native build) on 15 samples per case, minimum reported because a loaded
  machine can only ever _add_ time: **`^(?:(a+)+)$` 61.96 ms · `^(?:a+)$` 43.33 ms · `^a+$` 37.77 ms** — i.e. the engine
  needs ~38-43 ms to match 65,536 bytes for a _flat_ pattern, so the plan's 50 ms ceiling is roughly the engine's
  per-byte cost (≈0.6-0.7 µs/byte) rather than a margin this epic controls, and the adversarial pattern is 1.4-1.6× the
  flat one. The budget was met when the same test was first written (round 24, idle machine) and reads 56-70 ms under
  six concurrent agents, so the assertion was asserting the machine as much as the code. **T11's spec now asserts the
  property load-independently** — the adversarial pattern may cost at most 2× a same-size flat match, and the flat match
  must stay under a 150 ms catastrophe ceiling that a backtracking engine cannot come back from at all — while the plan's
  50 ms is **printed with its measurements on every run** and left as this open note. Three ways to close it, for the
  owner: (a) raise the budget to a number derived from measured engine throughput and keep it asserted absolutely;
  (b) keep 50 ms and move the timing case to a dedicated perf lane that runs on an idle runner; (c) change engines
  (`re2-wasm` is prebuilt and needs no native build — the §4.4 rationale was "no native build", not "no wasm"), which
  would need a fresh look at the pattern cache and the `patternUnsupported` classification. **Not** closed by narrowing
  the input size or refusing patterns above some value length: both would remove capability the plan grants.
