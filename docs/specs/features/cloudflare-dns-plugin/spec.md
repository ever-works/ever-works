# Cloudflare DNS plugin + collision-safe managed subdomains

**Status:** Draft · **Author:** Claude (Opus 4.8) · **Date:** 2026-06-16
**Related:** EW-617 (managed `ever-works` subdomain), the Vercel→k8s Works migration

## 1. Problem

When a Work is deployed to our k8s cluster (`k8s-works`), the operator/user needs
a **live URL to view the generated site** — analogous to the auto-generated
`*.vercel.app` URL Vercel gives. Today:

- For `deployProvider = 'ever-works'` (managed) we *do* auto-create
  `${slug}.ever.works` (CNAME → LB) via `EverWorksDnsService` —
  `apps/api/src/plugins-capabilities/deploy/deploy.service.ts:483-524`,
  `packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts:213-285`.
- For `deployProvider = 'k8s'` (bring-your-own-cluster — the path the migration
  used) there is **no DNS automation at all**: the Ingress host is merely *derived*
  from `work.website` (`deriveIngressHostFromWebsite`, deploy.service.ts:532-546)
  and **no DNS record is created** — the user must point DNS at the LB by hand.

And the existing managed path has three real defects:

1. **No global uniqueness.** `work.slug` has **no unique constraint** (`work.entity.ts:83-84`;
   no migration adds one) — uniqueness is enforced only per-`(userId[,owner],slug)`
   (`work.repository.ts:32-41`). Two users with slug `ai-coding` both derive
   `ai-coding.ever.works` → the second deploy silently claims/overwrites the first's
   CNAME. There is **no "is this subdomain free" check** anywhere.
2. **Subdomain is not persisted.** It is re-derived from `slug` on every deploy and
   on delete (`work-lifecycle.service.ts:954-956`). A slug rename **orphans** the old
   CNAME; nothing records "this Work owns `ai-coding.ever.works`".
3. **No provider abstraction / not a plugin.** `CloudflareDnsProvider` is a concrete
   class wired into core, not a plugin. There is **no `dns` plugin category**
   (`packages/plugin/src/contracts/plugin-manifest.types.ts:5-30`). Operators who
   bring their own Cloudflare account have no path.

## 2. Goals

- **G1** — Every k8s/managed Work gets a **unique, persisted** `*.ever.works`
  subdomain, with the DNS record auto-created, for **both** `ever-works` and `k8s`
  deploy providers.
- **G2** — **Collision-safe slug→subdomain allocation**: derive from the Work
  slug, verify it's free (against persisted claims), append a short random suffix
  if taken, persist the chosen subdomain on the Work.
- **G3** — **Per-Work subdomain UI**: view the assigned subdomain and edit it
  (re-validate uniqueness → update DNS record → patch Ingress), in the Work Deploy
  tab. Make the live URL obvious and clickable.
- **G4** — A first-class **Cloudflare DNS plugin** with two modes:
  - **Managed/global** — the platform's `ever.works` Cloudflare zone, via
    operator-only env vars (today's `CLOUDFLARE_*`). Tenants cannot override it.
  - **Bring-your-own (BYO)** — a user/Work supplies their own Cloudflare API token
    (+ zone) via encrypted plugin settings, to manage a custom apex/domain.
- **G5** — Reconcile the managed subdomain with **custom domains**
  (`WorkCustomDomain` + `/works/:id/domains`) — managed subdomain is the default;
  custom domains are additive (never replace it — "extension not replacement").

### Non-goals
- Registering/transferring domains. We manage **records in existing zones** only.
- Replacing cert-manager. TLS for `*.ever.works` is via Cloudflare proxy
  (Universal SSL) today; out of scope here.
- Generic per-Work env management (covered by the runtime-env API, #1315).

## 3. Current state (authoritative references)

| Concern | Where | Behavior |
|---|---|---|
| Managed subdomain derive | `deploy.service.ts:483-524` | `ever-works` only; `${slug}.ever.works`; fire-and-forget DNS |
| Subdomain string | `cloudflare-dns.provider.ts:245-253` `ingressHostFor(slug)` | `${slug}.${EVER_WORKS_DOMAIN||'ever.works'}`; validates slug regex |
| Record create | `cloudflare-dns.provider.ts:78-112` `ensureWorkSubdomain` | CNAME `{slug}.ever.works → EVER_WORKS_DEPLOY_LB_HOSTNAME`, `proxied:false`; idempotent + drift-correcting |
| Record delete | `…:115-124`, `work-lifecycle.service.ts:954-956` | on Work delete, `ever-works` only |
| Env vars | `cloudflare-dns.provider.ts:222-225` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `EVER_WORKS_DEPLOY_LB_HOSTNAME`, `EVER_WORKS_DOMAIN` (zone-scoped; no account id) |
| k8s host (no DNS) | `deploy.service.ts:532-546` | derives Ingress host from `work.website`; **no record created** |
| Custom domains | `WorkCustomDomain` (`@Unique(['workId','domain'])`), `/works/:id/domains` (`deploy.controller.ts:563-728`), `DeployFacadeService.addDomain` | DB source of truth + provider sync |
| Plugin settings model | `json-schema.types.ts:16-24` (`x-secret`/`x-envVar`/`x-scope`), `plugin-settings.service.ts:582-642` | resolution **work > user > admin > env > default**; pure `x-envVar` rejected from user writes (`:886-916`) |
| Slug uniqueness | `work.repository.ts:32-41` | **per-user only**; no global unique index |

## 4. Design

### 4.1 New `dns` plugin capability
- Add `'dns'` to `PLUGIN_CATEGORIES` (`plugin-manifest.types.ts`), mirroring the
  EW-637 `storage` / EW-642 `vector-store` precedent.
- Extract an `IDnsProvider` capability interface (under
  `packages/plugin/src/contracts/capabilities/dns.interface.ts`) from the concrete
  `CloudflareDnsProvider`:
  ```ts
  interface IDnsProvider {
    // create/upsert a record mapping host → target; idempotent
    ensureRecord(input: { host: string; type: 'CNAME'|'A'; target: string; proxied?: boolean }): Promise<DnsRecordSnapshot>;
    removeRecord(input: { host: string; type?: 'CNAME'|'A' }): Promise<void>;
    // does any record already exist for this host (uniqueness probe)
    recordExists(host: string): Promise<boolean>;
    // the zone's root domain this provider manages (e.g. 'ever.works')
    rootDomain(): string;
  }
  ```
- Keep `EverWorksDnsService` as the **managed** consumer, but have it resolve its
  provider through the plugin/registry instead of hard-coding Cloudflare.

### 4.2 Cloudflare DNS plugin (`@ever-works/cloudflare-dns`)
A plugin in `packages/plugins/cloudflare-dns/` implementing `IDnsProvider` (wrapping
the existing `fetch`-based Cloudflare v4 client, which already does
list/create/update/delete + drift correction). `settingsSchema`:

```jsonc
{
  "apiToken":    { "type": "string", "x-secret": true,  "x-envVar": "CLOUDFLARE_API_TOKEN",            "x-scope": "user" },
  "zoneId":      { "type": "string",                    "x-envVar": "CLOUDFLARE_ZONE_ID",               "x-scope": "user" },
  "rootDomain":  { "type": "string", "default": "ever.works", "x-envVar": "EVER_WORKS_DOMAIN" },
  "targetHostname": { "type": "string", "x-envVar": "EVER_WORKS_DEPLOY_LB_HOSTNAME", "x-adminOnly": true },
  "proxied":     { "type": "boolean", "default": true }
}
```
- **Managed mode**: operator sets the env vars (`x-envVar`, no `x-secret` on
  `targetHostname`/`zoneId` when used as the platform default → cannot be overridden
  per-tenant per `filterEnvVarFields`, plugin-settings.service.ts:886-916).
- **BYO mode**: a user provides `apiToken` (`x-secret` + `x-scope:user` → stored
  encrypted, like the k8s `kubeconfig` field) + their `zoneId`/`rootDomain`. Used
  when a Work routes a custom domain in the user's own zone.

> **Proxied note:** the migration set `*.ever.works` records `proxied:true` (CF
> Universal SSL provides valid TLS; cluster has no cert-manager). Make `proxied`
> default **true** for managed mode (was `false` in the current provider) — see §7.

### 4.3 Collision-safe allocation + persistence (the core fix)
- **Persist the managed subdomain.** Add `managedSubdomain` (`varchar`, nullable,
  **globally unique** partial index) to the `works` table — the durable claim.
  (Alternative: a `WorkCustomDomain` row with `managed:true`; chosen against because
  the managed host is 1:1 with the Work and wants a simple unique column.)
- **Allocation algorithm** (`SubdomainAllocator`, new service):
  1. `base = slugify(work.slug)` (reuse `ingressHostFor`'s regex/normalization).
  2. Candidate = `base`. If `works.managedSubdomain` already has `${base}.ever.works`
     **for another Work**, OR `provider.recordExists()` returns true for a host we
     don't own → append `-${shortId}` (4 chars, base36 from the Work UUID — reuse the
     deterministic-suffix approach `EverWorksGitProvider.buildRepoName` uses for repo
     names, work-lifecycle.service.ts:271-311) and retry (bounded, e.g. 5 tries).
  3. Persist the winner on `work.managedSubdomain`; create the DNS record; set it as
     `K8S_INGRESS_HOST`.
- **Idempotency / re-deploy**: if `work.managedSubdomain` is already set, reuse it
  (no re-allocation) — only (re)ensure the record + Ingress.
- **Slug rename**: when `managedSubdomain` exists and the slug changes, keep the
  existing subdomain by default (it's the persisted claim); offer "regenerate from
  new slug" in the UI (which frees the old record and allocates a new one).

### 4.4 Apply to BOTH providers
Generalize `applyEverWorksSubdomain` → `applyManagedSubdomain(work, settings)`:
- Fire for `deployProvider ∈ {'ever-works','k8s'}` (today: `ever-works` only).
- For `k8s`, the managed subdomain becomes the Ingress host **unless** the user has
  set an explicit custom `work.website`/domain (then that wins, managed subdomain is
  an additional Ingress host + record).
- Record target: managed zone → `EVER_WORKS_DEPLOY_LB_HOSTNAME`; the k8s LB is an IP
  (`157.230.74.11`) so for an apex/CNAME-flattening case use A-record support in
  `ensureRecord` (the interface already takes `type`).

### 4.5 Per-Work subdomain UI (G3)
Extend the Work **Deploy** tab (next to `DomainManagement.tsx`) with a **"Site URL /
Subdomain"** card:
- Reads a new `GET /api/deploy/works/:id/subdomain` → `{ subdomain, fqdn, url, editable }`.
- Shows the live clickable URL (`https://<fqdn>`), status (DNS ok / propagating).
- Edit → `PUT /api/deploy/works/:id/subdomain { subdomain }` → validates format +
  global uniqueness → frees old record, creates new, patches Ingress, persists.
- Mirror the existing per-Work plugin-settings UI pattern (`WorkPluginSettingsModal.tsx`,
  `apps/web/src/lib/api/plugins.ts`, `app/actions/plugins.ts`).

### 4.6 Reconcile with custom domains (G5)
- Managed subdomain = **primary/default** (persisted, always present).
- Custom domains stay on the existing `WorkCustomDomain` + `/works/:id/domains` path,
  added as **additional** Ingress hosts; never remove the managed subdomain.
- In BYO mode, the Cloudflare plugin also creates the **custom domain's** records in
  the user's zone (today custom-domain DNS is guidance-only for k8s).

## 5. Data model & migration
- `works.managedSubdomain VARCHAR NULL` + **unique** index (partial, where not null).
- Backfill: for existing `ever-works`/`k8s` Works with a live `*.ever.works` record,
  set `managedSubdomain = <slug>` (one-off migration / script; the 7 migrated Works
  are `dir`, `mcpserver`, `vectordb`, `timetrack`, `chairs`, `startup-books`,
  `compliance-automation` — note these differ from slugs, so backfill from the live
  Cloudflare records, not the slug).

## 6. API
- `GET /api/deploy/works/:id/subdomain` — `{ subdomain, fqdn, url, recordOk, editable }`.
- `PUT /api/deploy/works/:id/subdomain` — `{ subdomain }` → allocate/validate/persist + DNS + Ingress.
- (BYO) plugin settings via existing `PATCH /works/:id/plugins/cloudflare-dns/settings`.

## 7. Security & edge cases
- **Token scoping**: managed token is operator-only (`x-envVar`, never returned to
  clients); BYO token `x-secret` (encrypted at rest, masked on read — reuse the
  runtime-env masking from #1315).
- **Subdomain validation**: strict `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, length cap,
  blocklist (`www`, `api`, `app`, `admin`, `mail`, …) to avoid hijacking platform hosts.
- **Race**: two concurrent deploys for new Works picking the same base — the unique
  index on `managedSubdomain` is the backstop (insert fails → retry with suffix).
- **proxied flag**: managed mode should be `proxied:true` (CF TLS). Existing provider
  defaults `false`; changing it affects only new records — backfill existing to
  proxied via the migration script.
- **Orphan cleanup**: on slug regenerate / Work delete, remove the *persisted* old
  record (fixes today's orphan-on-rename bug).

## 8. Rollout (→ JIRA)
1. Extract `IDnsProvider` + add `dns` category (no behavior change).
2. `works.managedSubdomain` column + unique index + backfill.
3. `SubdomainAllocator` (collision-safe) + persist; wire into a renamed
   `applyManagedSubdomain` for `ever-works` **and** `k8s`.
4. Cloudflare DNS plugin (`packages/plugins/cloudflare-dns`) — managed + BYO modes.
5. `GET/PUT /works/:id/subdomain` API.
6. Deploy-tab "Site URL / Subdomain" UI.
7. Custom-domain reconciliation in BYO mode.

## 9. Acceptance criteria
- Creating + deploying a new Work to k8s (either provider) yields a working
  `https://<unique-subdomain>.ever.works` with the DNS record auto-created, the
  subdomain persisted, and the URL shown + clickable in the Deploy tab.
- Two Works (any users) requesting the same base slug get distinct subdomains
  (suffix), both live.
- Editing the subdomain in the UI updates DNS + Ingress and frees the old host.
- An operator can run fully on the platform's `ever.works` zone (env vars); an
  advanced user can bring their own Cloudflare token/zone via the plugin.
