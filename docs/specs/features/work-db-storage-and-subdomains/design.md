# Design — Work DB Storage (shared vs custom) + Subdomain fixes

Date: 2026-07-22
Owner: ever3@ever.co
Status: approved (design), implementation in progress

## 1. Problem

Two owner-reported issues on Ever Works:

1. **DB configuration.** Existing Works still show legacy **Neon** `DATABASE_URL`s. There is no way to
   create a database automatically, and no way for a user to choose between a platform-managed shared
   database and their own custom database. Goal: let users pick **"Ever Works DB" (shared/managed)** vs
   **"Custom DB"** — both in the onboarding wizard (new step) and on the Deploy page (new selector) — and
   move every existing Work off Neon onto the shared Ever Works Postgres so their sites work.

2. **Subdomains.** The Deploy page shows **"Failed to load subdomain"** and the existing Work sites
   (e.g. `chairs.ever.works`) **do not load**.

## 2. Current-state facts (verified: code + live, 2026-07-22)

### DB

- A Work's site DB is a **single value**, `works.deployDatabaseUrlEncrypted` (AES-256-GCM,
  `PLATFORM_ENCRYPTION_KEY`, 64-hex present in prod). Read/written only by `WorkRuntimeEnvService`
  (`packages/agent/src/services/work-runtime-env.service.ts`).
- **No seed / template default / hardcoded Neon** in code. The 7 legacy Works' Neon URLs were seeded
  out-of-band during the old Vercel→k8s migration and sit stale in the row.
- **No auto-provisioning of a database exists anywhere.** On deploy, `DeployService.ensureRuntimeEnv`
  (`apps/api/src/plugins-capabilities/deploy/deploy.service.ts:~1241-1273`) reads the stored URL and pushes
  it as a GitHub Actions `DATABASE_URL` secret; if null it just warns. `AUTH_SECRET`/`COOKIE_SECRET` use a
  race-safe `getOrGenerate` (`setDeployAuthSecretIfNull`) — the template for a future provision-if-null flow.
- Platform's own DB (Ever Works itself): `DATABASE_*` env → `pg-rw.databases.svc.cluster.local:5432/ever_works`
  (CNPG cluster `pg`, ns `databases`, on **ever-k8s**).
- Working reference `demo.ever.works` runs on **ever-k8s** (`ever-works-demo-prod`, ArgoCD-managed) using the
  **generic** image `ghcr.io/ever-works/directory-web-template` and connects **in-cluster** to
  `postgresql://…@pg-rw.databases.svc.cluster.local:5432/directory_web_demo?sslmode=require`. The directory
  template is **data-driven** — one image serves any directory; content lives in its DB.

### Subdomains — TWO independent problems

1. **"Failed to load subdomain" is a frontend/backend contract bug (platform-wide, false alarm).**
   `GET/PUT /api/deploy/works/:id/subdomain` return a bare `SubdomainState` with **no `status` field**
   (`deploy.controller.ts:~798-850`, `managed-subdomain.service.ts`), but the web action gates success on
   `response.status === 'success'` (`apps/web/src/app/actions/dashboard/deploy.ts:~260,316`). Every other
   deploy endpoint returns the `{status:'success',…}` envelope; these two were missed. So the banner shows on
   a healthy 200, and **saving a subdomain is also silently broken**. The address + "Live" badge render from
   the same successful payload — which is why you see the error and "Live" together. (The "Live" badge itself
   only checks "a DNS record exists" + "a Deployment was once Available"; it never fetches the URL.)
2. **The sites are genuinely dead.** All 7 legacy Work subdomains are stale Cloudflare **A-records →
   `157.230.74.11` (a dead DigitalOcean droplet; pings but refuses :80/:443 → Cloudflare HTTP 521)**. They
   were never migrated to homelab k8s. Both homelab Works clusters (`k8s-works` .210, `k8s-works-shared` .244)
   are empty. The platform's managed deploy provider has **no kubeconfig** (`EVER_WORKS_DEPLOY_KUBECONFIG` and
   `_PATH` empty; no shared-kubeconfig key) → it has never actually deployed a tenant Work.

### The 7 legacy Works (all `deployProvider=k8s`, `managedSubdomain` set, DB-SET=Neon)

`awesome-chairs`→chairs, `awesome`→dir, `awesome-mcp-servers`→mcpserver, `awesome-vector-databases`→vectordb,
`awesome-time-tracking`→timetrack, `awesome-startup-books`→startup-books,
`awesome-compliance-automation`→compliance-automation. Each has a per-work repo
(`ever-works/<slug>-website`, created 2026-07-19) holding its content/seed.

## 3. Decisions (owner, 2026-07-22)

1. **Isolation: database-per-Work** — `CREATE DATABASE ew_<work>` + scoped role on the shared cluster.
2. **Server: reuse the prod CNPG `pg` cluster now**; env vars structured so a later split to a dedicated
   customer cluster is a config change.
3. **Legacy data: fresh DB + seed schema** (discard Neon data; sites are down/unused).
4. **Scope: everything this session** (code + live migration of the 7 Works + DNS repoint), confirming each
   destructive prod step.
5. **Two deploy targets, one shared DB (owner, 2026-07-22).** Works may run on **ever-k8s** (platform cluster,
   e.g. `demo`) OR on **`k8s-works-shared`** (the dedicated CUSTOMER cluster). Both use the shared "Ever Works
   DB" on the `pg` cluster:
    - ever-k8s Works reach `pg` **in-cluster** (`pg-rw.databases.svc.cluster.local:5432`, `sslmode=require`).
    - `k8s-works-shared` Works are on a **separate** cluster, so the shared DB is exposed to the LAN via a
      **CNPG Pooler (PgBouncer) + MetalLB LoadBalancer**; those Works connect to that LB endpoint.
      The DDL/provisioner path always goes **direct** to `pg-rw…svc` (transaction-pooled PgBouncer can't run
      `CREATE DATABASE`); the injected per-Work app URL uses the **Pooler LB** endpoint so it works from either
      cluster. `k8s-works-shared` must be **registered as a platform/ArgoCD deploy target** (its kubeconfig wired
      into the managed deploy provider). **Proof-of-work this session: deploy one Work to `k8s-works-shared`
      (not the old `k8s-works` .210) and verify it serves + reaches the shared DB cross-cluster.**

## 4. Design

### 4.1 Config contract (new env vars)

`DATABASE_*` (existing) stays = **Ever Works' own** platform DB. New group for the **shared customer DB**:

- `DB_EVER_WORKS_SHARED_ENABLED` (bool) — feature flag; gates the "Ever Works DB" card (wizard + deploy) and
  makes it the default when true.
- `DB_EVER_WORKS_SHARED_ADMIN_URL` (secret) — least-privilege provisioner (`CREATEDB`+`CREATEROLE`, **not**
  superuser) on `pg`, in-cluster (`pg-rw…svc`). Used to `CREATE DATABASE`/`CREATE ROLE` per Work.
- `DB_EVER_WORKS_SHARED_HOST` / `_PORT` / `_SSLMODE` — endpoint used to compose the per-Work `DATABASE_URL`
  injected into tenant sites. Set to the **Pooler LoadBalancer LAN endpoint** so it is reachable from BOTH
  ever-k8s and `k8s-works-shared`. (Split later by pointing these + `_ADMIN_URL` at a separate cluster; no code
  change.) `_ADMIN_URL` stays direct to `pg-rw…svc` for DDL.

Cross-cluster infra (this session):

- **CNPG Pooler + MetalLB LoadBalancer** on the `pg` cluster, added to `ever-co/k8s-gitops` `apps/databases`
  and manually synced (per the DB-config-in-Git rule — never hand-edit the `pg` spec). Allocate a free MetalLB
  IP on ever-k8s.
- **`k8s-works-shared` registered as a deploy target**: kubeconfig (least-priv deployer) wired into
  `ever-works-app-secrets` (`EVER_WORKS_DEPLOY_KUBECONFIG` / shared-kubeconfig key) and registered as an ArgoCD
  destination cluster for the proof Work.

Declared/validated in the api config layer alongside the existing `everWorks.*` / `DATABASE_*` config, and
surfaced to the frontend through the existing `OnboardingCatalogService` (`available` flag) + a small
deploy-capabilities addition so the Deploy-page selector knows whether "shared" is offered.

### 4.2 Backend

- **`EverWorksDbProvisionService`** (new, `packages/agent/src/ever-works-providers/`):
  `provisionForWork(work)` → connect with `DB_EVER_WORKS_SHARED_ADMIN_URL` (`pg` client), create role
  `ewr_<work>` (random password) + `CREATE DATABASE ew_<work> OWNER ewr_<work>`, **seed schema-only** from
  `directory_web_demo` for directory Works (empty DB → site 500s otherwise), compose the in-cluster
  connection string, and persist it encrypted via `WorkRuntimeEnvService.setDatabaseUrl`. Idempotent: new
  `WorkRepository.setDeployDatabaseUrlIfNull` (mirrors `setDeployAuthSecretIfNull`) so concurrent deploys
  don't double-provision. Guarded by `DB_EVER_WORKS_SHARED_ENABLED` + Work mode == shared.
- **Hook:** `DeployService.ensureRuntimeEnv` — before reading the stored URL, if mode == shared and none set,
  call the provision service.
- **Test-connection endpoint:** `POST /api/deploy/works/:id/db/test` (+ an onboarding-scoped variant) that
  attempts a short-timeout Postgres connection to a supplied string and returns `{status,ok,error}`.
  Postgres-only (matches the existing `postgres(ql)://` validation).
- **Runtime-env `mode`:** extend `SetRuntimeEnvDto` + GET/PUT `runtime-env` with `mode: 'shared' | 'custom'`,
  persisted on the Work (new nullable column `deployDatabaseMode`, default null→treated as custom when a URL
  exists, shared when the flag is on and no custom URL). At deploy time the injected URL is the provisioned
  shared URL (shared) or the stored value (custom).
- **Subdomain status-bug fix:** wrap the two subdomain handler responses in `{status:'success',…}` (update
  `SubdomainResponseDto`) so the API matches the web contract. Fixes the banner and the broken save.
- **Copy fix:** managed-secrets "Auto-generated and rotated" → "Auto-generated" (code generates once, never
  rotates).

### 4.3 Onboarding wizard (`apps/web` + `packages/contracts` + `apps/api/onboarding`)

- Rename **"Your storage" → "Your Git Storage"** (title `EverWorksOnboardingWizard.tsx:~420` + label
  `labelForStep()` `~615`).
- Insert **"Your DB Storage"** step immediately after the Git-storage step in `computeStepList`
  (`useOnboardingFlow.ts`): cards **"Ever Works DB"** (managed, default, env-gated `available`) vs
  **"Custom DB"**. Custom reveals a connection-string field + **Test connection** button.
- New `db` bucket across: `wizard-state.ts` (type + default), reducer `setDbChoice` + `stripVersion`,
  `StepBody`/`labelForStep`/`DB_ICONS`, server `OnboardingCatalogService` (db cards), `onboarding-state.dto.ts`
  (`DB_CHOICES` + `DbChoicePatchDto` allow-list), `onboarding-state.service.ts` (normalise/merge).
- **Custom connection string is NOT persisted in `onboarding_state` JSONB** (plaintext-secret smell). It is
  captured transiently and written to the Work's encrypted column at create time (via the existing runtime-env
  set path), mirroring how BYOK creds avoid the state blob.

### 4.4 Deploy page (`RuntimeEnvManagement.tsx`)

- Add a **shared/custom selector** at the top of the "Database & environment" block. **Custom** = today's UI
  (masked current value + input + Save). **Shared** = read-only "Managed by Ever Works" note. `mode` threaded
  through the server action → runtime-env API. Selector only offered when `DB_EVER_WORKS_SHARED_ENABLED`.

### 4.5 Live ops — revive the 7 Works (this session, gated)

Reliable, fleet-standard path = mirror `demo` (ArgoCD app on ever-k8s, in-cluster DB, data-driven generic
image). **Pilot `chairs` end-to-end first, verify 200, then replicate to the other 6.** 0. **Verify pg backups healthy** (Backups-first rule) before any DB work; record restore point.

1. Provision `ew_<work>` DB + role on `pg` (in-cluster) and seed schema; import the Work's content from its
   `<slug>-website` repo seed.
2. Deploy the Work on ever-k8s (ArgoCD app mirroring `ever-works-demo-prod`) with in-cluster `DATABASE_URL`,
   ns-isolated, ingress host `<subdomain>.ever.works`, TLS via the cluster issuer.
3. **Repoint DNS**: replace stale `A→157.230.74.11` with the record shape a working managed Work uses (mirror
   a live-good record; proxied CNAME → CF tunnel / the ever-k8s ingress path). Confirm before each change.
4. Verify each site returns 200 before moving on.

Also: set each Work's `deployDatabaseUrlEncrypted` (encrypted) to the new in-cluster shared URL and clear its
Neon value so the Deploy page no longer shows Neon.

## 5. Sequencing (PRs)

- **Code** = one feature branch → `develop` → cascade `stage` → `main` (no cherry-pick). Logical commits:
  (1) subdomain status fix + copy fix; (2) config contract + provision service + runtime-env mode +
  test-connection; (3) wizard step + rename; (4) deploy-page selector; (5) tests.
- **Live ops** runs in parallel by hand (SQL + Cloudflare API + ArgoCD/kubectl) — the sites don't need the new
  code to come up; the code automates this for future Works and fixes the banner.

## 6. Testing

Unit: provision service (mocked `pg`), test-connection, wizard state machine + DTO allow-list, runtime-env
`mode`, subdomain envelope. Update onboarding-wizard e2e specs that assert step order/titles. Manual: deploy-
page selector both modes; one legacy site verified end-to-end before all 7.

## 7. Risks / rollback

- Shared DB on the prod `pg` cluster shares blast radius with Gauzy prod → least-privilege provisioner role,
  per-Work DB isolation, `sslmode=require`, no LAN exposure. Backups cover new DBs (whole-cluster WAL).
- DNS repoint is prod + outward-facing → confirm each; keep the old A-record value noted for rollback.
- Fresh DBs discard Neon data (owner-approved).
- Empty DB → 500 gotcha handled by schema seed + repo-seed import.
- Enabling managed provider / running tenant Works on ever-k8s co-locates customer sites with the platform →
  namespace isolation; acceptable for WIP.
