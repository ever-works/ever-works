# App Works — test estate (the Ever Works-side tenancy)

**Status:** `Created` · **Date:** 2026-09-17 · **Program:** [App Works](../specs/features/app-works/README.md)
**Implements:** the owner decision of 2026-09-17 recorded in [ACCEPTANCE.md §0.3](../specs/features/app-works/ACCEPTANCE.md) (_"WTF, you can just create a tenant in Ever Works and use it for testing etc etc."_)
**Companion documents:** [ACCEPTANCE.md §0](../specs/features/app-works/ACCEPTANCE.md) (lanes, secrets by name) · [CONFIGURATION.md](../specs/features/app-works/CONFIGURATION.md) (configuration inventory) · [GITHUB-PERMISSIONS.md](../specs/features/app-works/GITHUB-PERMISSIONS.md) (tokens and scopes)

> **Names only, never values.** Every identifier below is a UUID, a slug or a variable **name**. No token, key,
> password or connection string appears anywhere in this file — not even redacted-in-place, because the point of
> the table is that the reader fetches the value from `.config` themselves.
>
> **Additive only.** Nothing in this document removes, renames, disables or modifies anything that already
> existed on the platform. Two Organizations were created; nothing else was written, and the file itself is
> **not committed and not pushed** (five other agents are working this worktree).

---

## 1. What a "tenant" actually is here

The owner's phrase — _"create a tenant in Ever Works"_ — does **not** map onto a creatable object called a
`Tenant`. The platform separates an internal, non-creatable container from the user-facing scope the owner
means. Read together:

| #   | Fact                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A **Tenant** is a table-backed internal entity: `@Entity({ name: 'tenants' })`.                                                                                                                                                                      | [`packages/agent/src/entities/tenant.entity.ts:33`](../../packages/agent/src/entities/tenant.entity.ts)                                                                                                                           |
| 2   | **Cardinality is 1 User : 1 Tenant**, and the row is created **lazily**, never at signup.                                                                                                                                                            | [`packages/agent/src/entities/tenant.entity.ts:22-25`](../../packages/agent/src/entities/tenant.entity.ts) — _"Cardinality: 1 User : 1 Tenant. The Tenant row is created lazily the first time the user creates an Organization"_ |
| 3   | One Tenant per user is enforced at the DB level: `ownerUserId` is `UNIQUE`.                                                                                                                                                                          | [`packages/agent/src/entities/tenant.entity.ts:52-53`](../../packages/agent/src/entities/tenant.entity.ts)                                                                                                                        |
| 4   | A Tenant **never appears in the UI**. The user-facing concepts are `Organization` and `Company` — both are the _same_ `organizations` row.                                                                                                           | [`packages/agent/src/entities/tenant.entity.ts:17-20`](../../packages/agent/src/entities/tenant.entity.ts)                                                                                                                        |
| 5   | "Every user has at most one Tenant (1:1 via `tenants.ownerUserId UNIQUE`). Tenants are NOT created at user signup — they're created on demand the first time the user does something that requires one (today: creating their first Organization…)". | [`apps/api/src/scope/tenant-bootstrap.service.ts:10-14`](../../apps/api/src/scope/tenant-bootstrap.service.ts)                                                                                                                    |
| 6   | The bootstrap is reached **from Organization create**: `const tenant = await this.tenantBootstrap.ensureTenant(userId);`                                                                                                                             | [`apps/api/src/organizations/organization.service.ts:506`](../../apps/api/src/organizations/organization.service.ts)                                                                                                              |
| 7   | An **Organization** is the user-facing scope: `@Entity({ name: 'organizations' })`, `tenantId` FK, globally-unique `slug`.                                                                                                                           | [`packages/agent/src/entities/organization.entity.ts:76-78`](../../packages/agent/src/entities/organization.entity.ts), `:94-95`, `:104-105`                                                                                      |
| 8   | **Cardinality 1 Tenant : 0..N Organizations.**                                                                                                                                                                                                       | [`packages/agent/src/entities/organization.entity.ts:58`](../../packages/agent/src/entities/organization.entity.ts) — _"Cardinality: 1 Tenant : 0..N Organizations."_                                                             |
| 9   | The HTTP surface is `POST /api/organizations` — _"create + lazy Tenant bootstrap"_.                                                                                                                                                                  | [`apps/api/src/organizations/organizations.controller.ts:51`](../../apps/api/src/organizations/organizations.controller.ts), `:63-84`                                                                                             |
| 10  | Programme-level: _"EW-658 (Tenants & Organizations Phase 6) — Organization CRUD + lazy Tenant bootstrap + upgrade-from-account flow."_                                                                                                               | [`apps/api/src/api.module.ts:369-370`](../../apps/api/src/api.module.ts)                                                                                                                                                          |
| 11  | Spec: _"**Tenant** — fully internal concept. Never appears in the UI. One per user, created on demand the first time the user creates an Organization."_                                                                                             | [`docs/specs/features/tenants-and-organizations/spec.md:30`](../specs/features/tenants-and-organizations/spec.md)                                                                                                                 |
| 12  | Spec: _"**Organization** — user-facing. UI label varies by context … A Tenant can have zero, one, or many Organizations."_                                                                                                                           | [`docs/specs/features/tenants-and-organizations/spec.md:31`](../specs/features/tenants-and-organizations/spec.md)                                                                                                                 |

### 1.1 The consequence for "one test tenant per environment"

- **A second Tenant cannot be created inside an existing account.** `tenants.ownerUserId` is `UNIQUE`
  (`tenant.entity.ts:52-53`) and there is **no tenant-create endpoint** anywhere in the API. The only routes that
  touch `tenants` are operator-scoped reads/writes under an existing tenant id:
  `apps/api/src/operator/tenant-runtime-allowlist/operator-tenant-runtime-allowlist.controller.ts:59`
  (`api/operator/tenants/:tenantId/runtime-allowlist`) and
  `apps/api/src/operator/tenant-merge-policy/operator-tenant-merge-policy.controller.ts:53`
  (`api/operator/tenants/:tenantId/merge-policy`). Neither creates a Tenant.
- **The platform's own model for "a scope per environment" is one Organization per environment**, inside the one
  Tenant that the existing account already owns. That is what this estate creates.
- A genuinely separate Tenant would require a **separate user account** (`POST /api/auth/register`, `@Public()`,
  [`apps/api/src/auth/controllers/auth.controller.ts:107-108`](../../apps/api/src/auth/controllers/auth.controller.ts),
  DTO at [`apps/api/src/auth/dto/auth.dto.ts:54`](../../apps/api/src/auth/dto/auth.dto.ts)). **That was not done,
  and it would not work for this programme anyway** — see §4: the GitHub connection that owns the fork space is
  attached to the _user_, so a fresh account would have no GitHub connection without an interactive OAuth consent
  round-trip (which is exactly the "hand-made PAT" workaround the task forbids).

### 1.2 How a scope is selected at request time — `X-Scope-Slug`

The lanes pin their environment with a header, not with a path:

- `packages/contracts/src/api/active-scope.ts:9` — `export const ACTIVE_SCOPE_API_HEADER = 'x-scope-slug' as const;`
  (`:8` defines the reserved `@personal` sentinel; `:10` the browser-side `x-ever-workspace`).
- `apps/api/src/scope/scope-resolver.middleware.ts:98-121` — the slug is taken from the URL `:slug` param first,
  then from the `X-Scope-Slug` header; no hit is mapped to **404**.
- The MCP server's equivalent is its `EVER_WORKS_SCOPE_SLUG` setting, forwarded as the same header
  (`apps/mcp/README.md:32`, `apps/mcp/src/api-client/api-client.service.ts:63`).

---

## 2. What was created

All objects were created through `POST /api/organizations` on `api.ever.works`, authenticated with the host API
key from `.config/ever-works/ever-works-tenant.env` (variable `EVER_WORKS_API_KEY`, sent as `x-api-key`).

| Object       | Name                   | Slug              | id                                     | How it was created                  | Read-back proof                                    |
| ------------ | ---------------------- | ----------------- | -------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| Organization | `App Works Test Dev`   | `app-works-dev`   | `cf89c6bb-3cbd-46d9-b73e-db57466c804e` | `POST /api/organizations` → **201** | `GET /api/organizations/app-works-dev` → **200**   |
| Organization | `App Works Test Stage` | `app-works-stage` | `ef834760-935c-44f0-921f-103959f2644e` | `POST /api/organizations` → **201** | `GET /api/organizations/app-works-stage` → **200** |

**Pre-existing and deliberately untouched** (listed so the reader can tell created from inherited):

| Object                                 | Name                            | Slug     | id                                     |
| -------------------------------------- | ------------------------------- | -------- | -------------------------------------- |
| Tenant (owner's, **not** created here) | — (internal; never shown in UI) | `evereq` | `ba15122d-216b-4357-92a3-90b755efe8c8` |
| User (the tenant owner)                | `evereq`                        | `evereq` | `08a9e304-9f5c-4824-9dff-5695da59019f` |
| Organization                           | `Ever`                          | `ever`   | `d479e9c2-ffc0-4fc7-b548-3697c8792051` |
| Organization                           | `Yo, Inc.`                      | `yo-inc` | `87427a16-f09d-4b5c-a79d-b178a776ed87` |

### 2.1 Read-back output (real, identifiers kept, nothing else to redact)

`GET /api/organizations/app-works-dev` → **HTTP 200**:

```json
{
	"id": "cf89c6bb-3cbd-46d9-b73e-db57466c804e",
	"tenantId": "ba15122d-216b-4357-92a3-90b755efe8c8",
	"slug": "app-works-dev",
	"legalName": null,
	"displayName": "App Works Test Dev",
	"countryCode": null,
	"registrationProvider": null,
	"registrationStatus": "draft",
	"linkedWorkId": null,
	"vision": "Non-production test estate for the App Works acceptance lanes (DEV). Fixture-only. No real customer data.",
	"visionUpdatedAt": "2026-09-17T21:22:41.613Z",
	"mergePolicy": null,
	"connectionPolicy": null,
	"createdAt": "2026-09-17T21:22:41.611Z",
	"updatedAt": "2026-09-17T21:22:41.611Z"
}
```

`GET /api/organizations/app-works-stage` → **HTTP 200**:

```json
{
	"id": "ef834760-935c-44f0-921f-103959f2644e",
	"tenantId": "ba15122d-216b-4357-92a3-90b755efe8c8",
	"slug": "app-works-stage",
	"legalName": null,
	"displayName": "App Works Test Stage",
	"countryCode": null,
	"registrationProvider": null,
	"registrationStatus": "draft",
	"linkedWorkId": null,
	"vision": "Non-production test estate for the App Works acceptance lanes (STAGE). Fixture-only. No real customer data.",
	"visionUpdatedAt": "2026-09-17T21:22:41.925Z",
	"mergePolicy": null,
	"connectionPolicy": null,
	"createdAt": "2026-09-17T21:22:41.939Z",
	"updatedAt": "2026-09-17T21:22:41.939Z"
}
```

`GET /api/organizations` → **HTTP 200**, `4` rows in total (`app-works-stage`, `app-works-dev`, `ever`,
`yo-inc`) — the two `ever*` rows above are the pre-existing ones, both unchanged.

### 2.2 Proof the two scopes exist, are reachable, and are empty

A scope that resolves but is not actually a distinct partition would be worthless, so the header was tested
against a genuinely organization-scoped read, with a negative control. `GET /api/schedules`:

| `X-Scope-Slug`                                     | Result                   |
| -------------------------------------------------- | ------------------------ |
| _(header absent — the caller's own default scope)_ | **HTTP 200**, `count=29` |
| `app-works-dev`                                    | **HTTP 200**, `count=0`  |
| `app-works-stage`                                  | **HTTP 200**, `count=0`  |
| `ghost-not-real` (control)                         | **HTTP 404**             |

The 404 on the control is the important half: it proves the header is really being resolved rather than
ignored, so the two `200 / count=0` answers mean "an existing, empty partition", not "a header nobody read".
The two new scopes carry **no data at all** — no customer rows were copied, borrowed or exposed.

### 2.3 Nothing else moved

`GET /api/users/me/scope` was read before and after the creates and is byte-identical both times:

```json
{
	"tenantId": "ba15122d-216b-4357-92a3-90b755efe8c8",
	"organizationId": "d479e9c2-ffc0-4fc7-b548-3697c8792051",
	"organizationSlug": "ever"
}
```

`createOrganization` only re-points `users.lastScopeOrganizationId` when it is still `null`
([`organization.service.ts:559-571`](../../apps/api/src/organizations/organization.service.ts)); it was already
set, so the branch did not fire and the owner's (and every other agent's) active scope is still `ever`.

**One side effect worth knowing about, reported rather than hidden.** `createOrganization` runs an
_unconditional, NULL-only_ `tenantId` backfill across every user-owned table as step (e) of the documented flow
([`organization.service.ts:412-415`](../../apps/api/src/organizations/organization.service.ts) and
`:573-592`). It is idempotent — `UPDATE … SET "tenantId" = $1 WHERE … AND "tenantId" IS NULL` — and for this
account it is a no-op, because the user already had a Tenant and a first Organization since 2026-07-20. It is
recorded here because it is the one write this call performs outside `organizations`, and a future reader should
not be surprised by it. No API surface reports the affected row counts, so this could not be measured from
outside; it is inferred from the code path plus the pre-existing `tenantId` values visible in `GET /api/works`.

---

## 3. The GitHub account that owns the fork space

| Question                                  | Answer                                                                                                                                                                                  | Evidence                                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is a GitHub account connected?            | **Yes.**                                                                                                                                                                                | `GET /api/git-providers/github/connection` → `"connected":true`                                                                                                                                        |
| Which account?                            | **`evereq`** (GitHub user id `118497`), connected by **OAuth**, not by a PAT.                                                                                                           | `GET /api/oauth/github/connection` → `{"id":"github","connected":true,"username":"evereq","connectionSource":"plugin"}` ; `GET /api/git-providers/github/user` → `{"id":"118497","login":"evereq", …}` |
| What fork space does it own?              | The `evereq` personal account, plus the organizations that account can reach.                                                                                                           | `GET /api/git-providers/github/organizations` → `success=true`, **2** organizations: `ever-works`, `ever-works-cloud`                                                                                  |
| Is a GitHub **App** installed?            | **No.**                                                                                                                                                                                 | `GET /api/github-app/installations` → `[]`                                                                                                                                                             |
| Does the fork flow need the App?          | **No.** Token resolution is explicit token → managed PAT → App installation → **the user's OAuth account** → plugin-settings PAT. OAuth is present at step 4.                           | [`packages/agent/src/facades/git.facade.ts:1644-1647`](../../packages/agent/src/facades/git.facade.ts); [GITHUB-PERMISSIONS.md:33-36](../specs/features/app-works/GITHUB-PERMISSIONS.md)               |
| So what does `<e2e-fork-org>` resolve to? | **`evereq`** — the connected account's own space. `<e2e-upstream-org>` resolves to **`ever-works`** as [ACCEPTANCE.md §0.3](../specs/features/app-works/ACCEPTANCE.md) already records. | this read-back + `ACCEPTANCE.md:94-95`                                                                                                                                                                 |

**Nothing was connected or disconnected.** The connection already existed; the `connect` endpoint is
`GET /api/oauth/:providerId/connect/url`
([`apps/api/src/plugins-capabilities/oauth/oauth.controller.ts:106-144`](../../apps/api/src/plugins-capabilities/oauth/oauth.controller.ts)),
and completing it requires an interactive browser consent plus the server-minted `state` cookie
(`:119-130`) — it cannot be driven head-lessly, and it was not needed.

### 3.1 ⚠️ The GitHub connection is per **User**, not per Organization

This is the single most important caveat in this document for the programme:

- `git-provider.service.ts` takes a **`userId`** for every connection question —
  [`apps/api/src/plugins-capabilities/git-provider/git-provider.service.ts:33`](../../apps/api/src/plugins-capabilities/git-provider/git-provider.service.ts)
  (`checkConnection(userId, providerId)`), `:53`
  (`!!oauthAccount || hasValidCredentials({ userId, providerId })`), `:79-93` (`getUser`/`getOrganizations`/`getRepositories`, all `(userId, …)`).
- The OAuth connection endpoint is the same:
  [`oauth.controller.ts:102-104`](../../apps/api/src/plugins-capabilities/oauth/oauth.controller.ts) (`req.user.userId`).
- Token resolution resolves against `options.userId`:
  [`git.facade.ts:1644-1690`](../../packages/agent/src/facades/git.facade.ts).

**Consequence:** `app-works-dev` and `app-works-stage` are two isolated _data_ scopes, but they share **one**
GitHub identity — `evereq`. They are not two independent GitHub accounts, and `ACC-E2E-02`'s assertion that
the fork "was created with the user's connection" holds for both lanes with the same actor. If the programme
needs `<e2e-user>` to be a _different_ identity per environment, or an identity that is "never an administrator
of the upstream owner" ([ACCEPTANCE.md:96](../specs/features/app-works/ACCEPTANCE.md)), **the platform cannot
express that today** — see §6.

---

## 4. Environment variables and secrets the lanes need — by name, and where each value comes from

Nothing here is a value. `.config` paths are on the operator workstation (`E:\Coding\_LOCAL\.config\`), git-ignored.

### 4.1 Which scope a lane runs in (the new estate)

| Name                                              | Value to use                                                                                                                    | Source                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `X-Scope-Slug` (HTTP header, **not** an env var)  | `app-works-dev` on the nightly/dev lane · `app-works-stage` on the golden-path/stage lane                                       | created here, §2                                                                    |
| `EVER_WORKS_SCOPE_SLUG` (MCP server only)         | same slugs                                                                                                                      | `apps/mcp/README.md:32`                                                             |
| `EVER_WORKS_ORGANIZATION_SLUG` (operator tooling) | currently `ever` in `.config/ever-works/ever-works-tenant.env`; point it at `app-works-dev` / `app-works-stage` for estate work | `.config/ever-works/ever-works-tenant.env`, variable `EVER_WORKS_ORGANIZATION_SLUG` |

### 4.2 Existing platform credentials the lanes reuse

| Name                                                              | Where the value comes from                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `API_URL`                                                         | `.config/ever-works/ever-works-tenant.env` → `EVER_WORKS_API_URL` (host `api.ever.works`; `/api/health` → 200)          |
| `EVER_WORKS_API_KEY` (if a lane talks to the API as this account) | `.config/ever-works/ever-works-tenant.env` → `EVER_WORKS_API_KEY` (`ew_live_…`, 72 chars)                               |
| `PLAYWRIGHT_BASE_URL`                                             | the dev / stage web origin (an operator fact; not present in `.config`)                                                 |
| `APW_E2E_ALLOWED_BASE_URLS`                                       | must list that same dev/stage origin (ACC-NEG-16) — **not present in `.config`**, compose it from the two origins above |

### 4.3 Lane secrets and variables that must be **created** (no source exists yet)

These are the names [ACCEPTANCE.md §0.4](../specs/features/app-works/ACCEPTANCE.md) (lines 109-133) and
[CONFIGURATION.md §4.5](../specs/features/app-works/CONFIGURATION.md) (lines 224-246) already fix. The right-hand
column is what this survey actually found — where it says _none_, the value has to be minted, and the row is a
real open item, not a formatting gap.

| Name                                                             | Secret       | What this survey found as a source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APW_E2E_LIVE`, `APW_E2E_LANE`, `APW_E2E_RUN_ID`                 | no           | none — harness-generated per run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `APW_E2E_GITHUB_USER`                                            | no           | **`evereq`** (the connected account, §3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `APW_E2E_UPSTREAM_ORG`                                           | no           | **`ever-works`** (fixtures verified present, §6.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `APW_E2E_FORK_ORG`                                               | no           | **`evereq`** (the connected account, §3) — see the §3.1 caveat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `APW_E2E_GITHUB_USER_TOKEN`                                      | **yes**      | **no `.config` variable currently holds a token with the required scope set.** Closest candidates: (a) `.config/ever-works/ever-works.env` → `EVER_WORKS_GITHUB_PAT_CLASSIC`, verified as classic PAT for user `evereq` with scopes `repo, workflow, write:packages` — **missing `read:org`**, which APW-01's fork-target picker needs ([GITHUB-PERMISSIONS.md](../specs/features/app-works/GITHUB-PERMISSIONS.md) row 3); (b) the local `gh` CLI keyring token for `evereq`, verified scopes `admin:org, gist, repo, workflow, write:packages` |
| `APW_E2E_GITHUB_ESTATE_TOKEN`                                    | **yes**      | same two candidates as above; harness-only, must never be given to the platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `APW_E2E_UMAMI_REPO`, `APW_E2E_CALDIY_REPO`                      | no           | the repositories do **not** exist yet in the fork space. Only the _Blueprints_ exist (`ever-works/umami-template`, `ever-works/cal-diy-template`, both private, default branch `main`). ACCEPTANCE.md:101 requires them to be created **once by a person** — not a machine                                                                                                                                                                                                                                                                      |
| `APW_E2E_USER_CLUSTER_KUBECONFIG`                                | **yes**      | `.config/kubeconfig` — verified: `kubectl config get-contexts -o name` with `KUBECONFIG` pointed at it returns exactly **`ever-k8s`**                                                                                                                                                                                                                                                                                                                                                                                                           |
| `APW_E2E_USER_CLUSTER_CONTEXT`                                   | no           | **`ever-k8s`** (same file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `APW_E2E_USER_CLUSTER_DOMAIN`                                    | no           | none in `.config` — the wildcard ingress domain must be chosen and its DNS record created                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `APW_E2E_DNS_ZONE`, `APW_E2E_DNS_API_TOKEN`                      | no / **yes** | `.config/ever-works/cloudflare.env` → `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`); `.config/ever/cloudflare.env` also carries `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_TOKEN` / `CLOUDFLARE_API_KEY` / `CLOUDFLARE_EMAIL`                                                                                                                                                                                                                                                                                                            |
| `MAILHOG_URL`                                                    | no           | **none — `grep` for `MAILHOG`/`mailhog` across the whole of `.config/` returns zero matches.** The sink itself would have to be deployed; note the kubeconfig above is the `ever-k8s` cluster, so a sink in a test namespace is reachable                                                                                                                                                                                                                                                                                                       |
| `APW_E2E_APPS_TIER_READ_KUBECONFIG`, `APW_E2E_APPS_TIER_CONTEXT` | **yes** / no | none — Wave 2, and `<e2e-apps-tier>` does not exist yet (APW-10 is not shipped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `APW_E2E_CANARY_SINK_URL`, `APW_E2E_CANARY_SINK_READ_TOKEN`      | no / **yes** | none — needs a deployed HTTPS sink                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `APW_E2E_HONEYTOKEN`                                             | **yes**      | synthetic — generate a unique credential-shaped string per run; must not match any real credential                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `APW_E2E_MANAGED_AGENT_API_KEY`                                  | **yes**      | none in `.config` — APW-04 T4's sandbox-isolation live spec credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `APW_E2E_TOKEN_BUDGET`, `APW_E2E_ACTIONS_MINUTES_BUDGET`         | no           | policy values from ACCEPTANCE.md §0.1 (`1 200 000` / lane budgets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EVER_WORKS_E2E_FAKES`, `APW_E2E_GITHUB_FAKE_URL`                | no           | PR lanes only — no external value needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `APW_E2E_KIND_KUBECONFIG_PATH`                                   | no           | PR-cluster lane only — generated locally, mirrors `KUBECONFIG_E2E_PATH`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Update, 2026-09-26.** The Blueprints named in the `APW_E2E_UMAMI_REPO` / `APW_E2E_CALDIY_REPO` row have changed
since this survey: the Cal Blueprint is now `ever-works/cal-template` (renamed from `cal-diy-template`), and it and
`ever-works/umami-template` are **public** with the topic `ever-works-app-blueprint`. The two variable names are
unchanged (they are ACCEPTANCE.md's), and the long-lived fork-space repositories they name still have to be
created once by a person.

### 4.4 Platform-side switches the lanes depend on (deployment configuration, not lane secrets)

The lanes cannot pass without these on the **dev** and **stage** deployments. They are process environment /
PostHog flags, not GitHub Actions secrets — listed here so nobody looks for them in `.config`:
`EVER_WORKS_APP_WORKS_ENABLED`, `EVER_WORKS_APP_LAUNCHER_ENABLED`, `EVER_WORKS_APPS_CATALOG_REPO`,
`EVER_WORKS_APPS_CATALOG_REF`, `EVER_WORKS_AGENTS_REF`, `EVER_WORKS_APPS_MANAGED_ENABLED`,
`EVER_WORKS_APPS_MAX_SCOPE`, `EVER_WORKS_DOMAIN`, `EVER_WORKS_APPS_DOMAIN`, `EVER_WORKS_APPS_DNS_ZONE_ID`,
`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`, and the PostHog flags `works-app`, `app-launcher`, `ever-id`
(per-environment table: [CONFIGURATION.md §4](../specs/features/app-works/CONFIGURATION.md), lines 144-222).

---

## 5. What could not be created, with the real error text

### 5.1 The API exposes no OpenAPI/Swagger document on this host

Every documented discovery path was tried before any write. All four returned a real 404 whose body is quoted
verbatim:

| Request                                         | Result                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api-json`                                 | HTTP 404                                                                                     |
| `GET /api/docs`                                 | HTTP 404                                                                                     |
| `GET /openapi.json`                             | HTTP 404                                                                                     |
| `GET /api/openapi.json`                         | HTTP 404 — `{"message":"Cannot GET /api/openapi.json","error":"Not Found","statusCode":404}` |
| `GET /api/swagger`                              | HTTP 404                                                                                     |
| `GET /api/docs-json`, `GET /api`, `GET /api/v1` | HTTP 404                                                                                     |

**This is by design, not a fault.** The document is served only outside production:

```ts
// apps/api/src/main.ts:151
const docsEnabled = process.env.NODE_ENV !== 'production';
// apps/api/src/main.ts:211-215
// C-09: never expose Swagger UI, the Scalar reference, or the OpenAPI JSON spec
// in production. …
if (docsEnabled) { … }
```

`api.ever.works` therefore runs with `NODE_ENV=production` and the discovery surface is closed. The model in
§1 was established from the repository source instead (and the built-time equivalent,
`apps/api/src/openapi/generate-openapi.ts`, confirms the same gate). **Not worked around** — per the
"if a capability is missing, stop and report" rule.

### 5.2 A real 400 hit while probing — wrong query-parameter name

`GET /api/organizations/check-slug?slug=app-works-dev` → **HTTP 400**, verbatim:

```json
{
	"message": [
		"property slug should not exist",
		"value contains unsupported characters; allowed: letters, digits, dot, underscore, at-sign, apostrophe, hyphen, space",
		"value must be longer than or equal to 1 characters",
		"value must be a string"
	],
	"error": "Bad Request",
	"statusCode": 400
}
```

The DTO names the parameter `value`, not `slug`
([`apps/api/src/organizations/dto/check-slug.dto.ts:23`](../../apps/api/src/organizations/dto/check-slug.dto.ts)),
and `forbidNonWhitelisted` turns the unknown parameter into a hard 400 rather than ignoring it. Recorded because
the message is genuinely confusing (it complains about a _missing_ `value` with four errors while naming
`slug`), and the next person will hit it. Correct call:
`GET /api/organizations/check-slug?value=app-works-dev` → **200**
`{"available":true,"normalized":"app-works-dev"}`.

### 5.3 No GitHub App installation, and no API-reachable way to create one

`GET /api/github-app/installations` → **HTTP 200**, body `[]`. Installing the App is an interactive GitHub
consent flow (`GET /api/github-app/setup?installation_id=…`, `@Public()`,
[`github-app.controller.ts:31-39`](../../apps/api/src/integrations/github-app/github-app.controller.ts)), not
something an agent may drive. Reported as a gap; **not** worked around, and no PAT was hand-installed to fake it.
It is not currently blocking: the fork path resolves the user's OAuth connection instead (§3).

### 5.4 The `e2e` catalog branch does not exist

[ACCEPTANCE.md §0.3](../specs/features/app-works/ACCEPTANCE.md) line 102 requires
`EVER_WORKS_APPS_CATALOG_REF` on dev/stage to _"pin a commit on the `e2e` branch of `ever-works/templates`"_.
Observed:

```text
$ gh api repos/ever-works/templates/branches --jq '.[].name'
main
```

Only `main` exists. The dev and stage catalog pin therefore has nothing to point at yet. Also verified and
**not** created here (out of scope, and creating catalog branches is a reviewed-PR action):
`ever-works/templates` `private=false`, `ever-works/platforms` `private=true`, `ever-works/app-fixture-hello`
`private=true`, `ever-works/app-fixture-hello-template` `private=true`, `ever-works/cal-diy-template`
`private=true`, `ever-works/umami-template` `private=true` — all with default branch `main`, all matching the
"already exists, do not re-create" table.

Re-measured 2026-09-26: `ever-works/templates` still has only `main`. `ever-works/platforms`,
`ever-works/umami-template` and `ever-works/cal-template` (the renamed `cal-diy-template`) are now **public**;
`ever-works/app-fixture-hello-template` is still private and is not part of the catalog. `ever-works/templates` is
now a pure listing (`manifest.json`, schemas, `licenses.yml` and a validator) with no per-template folders.

### 5.5 The connected account's token cannot do every step in the permission matrix

Two credentials were inspected read-only against `https://api.github.com/user` and the `x-oauth-scopes`
response header (values never printed):

| Credential                                                                  | Identity               | Scopes observed                                   | Steps it cannot do                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.config/ever-works/ever-works.env` → `EVER_WORKS_GITHUB_PAT_CLASSIC`       | `evereq` (id `118497`) | `repo, workflow, write:packages`                  | `read:org` → the fork-target organization picker (matrix row 3); `write:repo_hook` → installing the `workflow_run` webhook (row 20); `delete_repo` → deleting a fork/private copy on request (row 26) |
| local `gh` CLI keyring (an OAuth token, shown redacted by `gh auth status`) | `evereq`               | `admin:org, gist, repo, workflow, write:packages` | `delete_repo` (row 26)                                                                                                                                                                                |

This is a **gap to close before the nightly lane can run**, and it is deliberately not closed here — minting a
broader token is an owner decision, and the platform's own connected OAuth account (which does list
`ever-works` and `ever-works-cloud`) is what the live lane should use.

### 5.6 Not attempted, on purpose

- No user account was registered (`POST /api/auth/register`), so no second Tenant exists — §1.1 explains why.
- No repository, branch, tag, webhook, secret, workflow or DNS record was created anywhere on GitHub or
  Cloudflare. This task is Ever Works-side tenancy only.
- Nothing was deleted, renamed, disabled or edited. The two pre-existing Organizations and the pre-existing
  Tenant were only read.

---

## 6. How to re-create this from scratch

Everything below is additive and idempotent-by-inspection (check first, then create). Substitute the operator's
own `.config` path. **Never echo the key.**

### 6.1 Prerequisites

1. `E:\Coding\_LOCAL\.config\ever-works\ever-works-tenant.env` present with `EVER_WORKS_API_URL`,
   `EVER_WORKS_API_KEY`, `EVER_WORKS_ORGANIZATION_SLUG`.
2. The host answers: `GET $EVER_WORKS_API_URL/api/health` → `200 {"status":"success","message":"API is up and running"}`.
3. The key is a personal API key (`ew_live_…`), which the session guard accepts via `x-api-key` or
   `Authorization: Bearer`
   ([`apps/api/src/auth/guards/auth-session.guard.ts:13,34,219-234`](../../apps/api/src/auth/guards/auth-session.guard.ts)).
4. A GitHub account with a fork-capable connection for the estate's fork space (§3). If none is connected,
   the only supported path is the interactive `GET /api/oauth/github/connect/url` consent flow — **do not**
   substitute a hand-made PAT.

### 6.2 Confirm who you are and which Tenant you are about to write into

```bash
set -a; . /e/Coding/_LOCAL/.config/ever-works/ever-works-tenant.env; set +a
H=(-H "x-api-key: $EVER_WORKS_API_KEY")

curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/auth/profile"     # → your userId, username, email
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/users/me/scope"   # → { tenantId, organizationId, organizationSlug }
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/organizations"    # → every Organization you already own
```

Note the `tenantId` — everything you create lands inside it. At the time of writing it is
`ba15122d-216b-4357-92a3-90b755efe8c8`, but read it, do not assume it.

### 6.3 Check the slugs are free, then create the two Organizations

```bash
# Availability (the query parameter is `value`, NOT `slug` — see §5.2)
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/organizations/check-slug?value=app-works-dev"
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/organizations/check-slug?value=app-works-stage"

# Create (one call each; `vision` is optional and makes the purpose obvious in the switcher)
curl -sS -X POST "${H[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"App Works Test Dev","slug":"app-works-dev","vision":"Non-production test estate for the App Works acceptance lanes (DEV). Fixture-only. No real customer data."}' \
  "$EVER_WORKS_API_URL/api/organizations"

curl -sS -X POST "${H[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"App Works Test Stage","slug":"app-works-stage","vision":"Non-production test estate for the App Works acceptance lanes (STAGE). Fixture-only. No real customer data."}' \
  "$EVER_WORKS_API_URL/api/organizations"
```

`201` carries the new `id`. The endpoint accepts exactly three body fields — `name`, `slug`, `vision`
([`create-organization.dto.ts:8-42`](../../apps/api/src/organizations/dto/create-organization.dto.ts)); anything
else is a 400, because `forbidNonWhitelisted` is on
([`main.ts:199-205`](../../apps/api/src/main.ts)).

### 6.4 Read back — never trust the POST response

```bash
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/organizations/app-works-dev"
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/organizations/app-works-stage"
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/users/me/scope"   # must be UNCHANGED
```

### 6.5 Prove the scopes are real and empty (with the control)

```bash
for slug in "" app-works-dev app-works-stage ghost-not-real; do
  if [ -z "$slug" ]; then S=(); else S=(-H "X-Scope-Slug: $slug"); fi
  printf '%-18s -> ' "${slug:-<none>}"
  curl -sS -o /dev/null -w '%{http_code}\n' "${H[@]}" "${S[@]}" "$EVER_WORKS_API_URL/api/schedules"
done
```

Expected: `200`, `200`, `200`, **`404`** — the last one is the control that proves the header is being read.

### 6.6 Record the GitHub identity that owns the fork space

```bash
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/oauth/github/connection"
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/git-providers/github/organizations"
curl -sS "${H[@]}" "$EVER_WORKS_API_URL/api/github-app/installations"
```

Then update §3 of this document if the account changed. **Do not** try to create a GitHub App installation or
mint a token from a script.

### 6.7 Roll-back (if the estate ever has to go)

There is no delete-Organization endpoint in the surface surveyed, and none is needed: the scopes are empty and
inert, so they cost nothing and can simply be left in place. If the owner ever wants them gone, that is a
manual, per-Organization action inside the product — **not** a script, and not something this document
authorises. (Removal is the owner's call under the programme's additive-only rule R-26.)

---

## 7. The exact commands that were run, secrets redacted

Run from PowerShell on the operator workstation. `$EVER_WORKS_API_KEY` was sourced from
`.config/ever-works/ever-works-tenant.env` and **never** echoed; no secret appears in any command below.

```powershell
# Load the env file into the process environment without printing values
$envFile = "E:\Coding\_LOCAL\.config\ever-works\ever-works-tenant.env"
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    Set-Item -Path "env:$($matches[1])" -Value $matches[2].Trim().Trim('"')
  }
}
$base = $env:EVER_WORKS_API_URL.TrimEnd('/')
$h    = @{ 'x-api-key' = $env:EVER_WORKS_API_KEY }     # value never printed
```

**Discovery (all read-only):**

```powershell
Invoke-WebRequest "$base/api/health" -UseBasicParsing                       # → 200
foreach ($p in @('/api-json','/api/docs','/openapi.json','/docs','/api',
                 '/api/docs-json','/swagger','/api/v1','/api/openapi.json','/api/swagger')) {
  try   { Invoke-WebRequest "$base$p" -UseBasicParsing -ErrorAction Stop }
  catch { "$p -> HTTP $([int]$_.Exception.Response.StatusCode)" }           # → all 404
}
Invoke-WebRequest "$base/api/auth/profile"         -Headers $h              # → 200
Invoke-WebRequest "$base/api/organizations"        -Headers $h              # → 200, 2 rows
Invoke-WebRequest "$base/api/users/me/scope"       -Headers $h              # → 200
Invoke-WebRequest "$base/api/git-providers"        -Headers $h              # → 200 configured=true
Invoke-WebRequest "$base/api/git-providers/github/connection"    -Headers $h # → 200 connected=true, evereq
Invoke-WebRequest "$base/api/git-providers/github/user"          -Headers $h # → 200 id=118497
Invoke-WebRequest "$base/api/git-providers/github/organizations" -Headers $h # → 200 ever-works, ever-works-cloud
Invoke-WebRequest "$base/api/oauth/github/connection"            -Headers $h # → 200
Invoke-WebRequest "$base/api/github-app/installations"           -Headers $h # → 200 []
Invoke-WebRequest "$base/api/organizations/check-slug?slug=app-works-dev"  -Headers $h # → 400 (§5.2)
Invoke-WebRequest "$base/api/organizations/check-slug?value=app-works-dev" -Headers $h # → 200 available
Invoke-WebRequest "$base/api/organizations/check-slug?value=app-works-stage" -Headers $h # → 200 available
```

**The two creates (the only writes):**

```powershell
$dev   = @{ name='App Works Test Dev';   slug='app-works-dev';
            vision='Non-production test estate for the App Works acceptance lanes (DEV). Fixture-only. No real customer data.' } | ConvertTo-Json -Compress
$stage = @{ name='App Works Test Stage'; slug='app-works-stage';
            vision='Non-production test estate for the App Works acceptance lanes (STAGE). Fixture-only. No real customer data.' } | ConvertTo-Json -Compress

Invoke-WebRequest "$base/api/organizations" -Method POST -Headers ($h + @{'Content-Type'='application/json'}) -Body $dev   # → 201
Invoke-WebRequest "$base/api/organizations" -Method POST -Headers ($h + @{'Content-Type'='application/json'}) -Body $stage # → 201
```

**Read-back and isolation proof:**

```powershell
Invoke-WebRequest "$base/api/organizations/app-works-dev"   -Headers $h   # → 200
Invoke-WebRequest "$base/api/organizations/app-works-stage" -Headers $h   # → 200
Invoke-WebRequest "$base/api/organizations"                 -Headers $h   # → 200, 4 rows
Invoke-WebRequest "$base/api/users/me/scope"                -Headers $h   # → 200, unchanged
foreach ($s in @($null,'app-works-dev','app-works-stage','ghost-not-real')) {
  $hh = @{ 'x-api-key' = $env:EVER_WORKS_API_KEY }
  if ($s) { $hh['X-Scope-Slug'] = $s }
  try   { $r = Invoke-WebRequest "$base/api/schedules" -Headers $hh -UseBasicParsing -ErrorAction Stop
          "scope=$s -> $($r.StatusCode) total=$(($r.Content | ConvertFrom-Json).total)" }
  catch { "scope=$s -> HTTP $([int]$_.Exception.Response.StatusCode)" }
}   # → 200/29, 200/0, 200/0, 404
```

**Read-only GitHub checks (no writes anywhere):**

```powershell
foreach ($r in @('ever-works/templates','ever-works/app-fixture-hello','ever-works/app-fixture-hello-template',
                 'ever-works/platforms','ever-works/cal-diy-template','ever-works/umami-template')) {
  gh repo view $r --json nameWithOwner,isPrivate,isFork,defaultBranchRef
}
gh api repos/ever-works/templates/branches --jq '.[].name'   # → main   (no `e2e` branch)
gh auth status                                               # → evereq keyring, scopes: admin:org gist repo workflow write:packages
$env:KUBECONFIG="E:\Coding\_LOCAL\.config\kubeconfig"; kubectl config get-contexts -o name   # → ever-k8s
```

**Read-only token inspection** (value never printed, only identity and the `x-oauth-scopes` response header):

```powershell
$r = Invoke-WebRequest 'https://api.github.com/user' -Headers @{ Authorization = "token $env:EVER_WORKS_GITHUB_PAT_CLASSIC" } -UseBasicParsing
($r.Content | ConvertFrom-Json).login ; $r.Headers['x-oauth-scopes']   # → evereq ; repo, workflow, write-packages
```

---

## 8. Broken or surprising — reported, not fixed

1. **The word "tenant" in the owner's decision names an object that cannot be created.** A Tenant is 1:1 with a
   user and has no create endpoint (`tenant.entity.ts:52-53`; `tenant-bootstrap.service.ts:10-14`). What the
   owner means by "a tenant for testing" is an **Organization**. Anyone reading the decision literally will look
   for a create-Tenant API that does not exist. **Not** renamed or worked around — recorded.
2. **The GitHub connection is account-wide, not per Organization** (§3.1). Two environment scopes share one
   GitHub identity. If the programme needs `<e2e-user>` to be a non-admin, environment-specific identity, the
   platform has no mechanism for it today. Reported, not fixed.
3. **`GET /api/organizations/check-slug` rejects the natural parameter name with a four-error 400** while
   naming a parameter (`slug`) that its own DTO does not define (§5.2). Confusing enough to cost the next
   person time.
4. **The OpenAPI document is 404 on `api.ever.works`** by design (C-09, `main.ts:151`). Any agent asked to
   "read the Swagger" on this host will find nothing and must read the source instead. Worth stating in the
   programme docs.
5. **`ever-works/templates` has no `e2e` branch**, although ACCEPTANCE.md:102 requires the dev/stage catalog pin
   to be a commit on it (§5.4). The dev and stage lanes cannot be configured as written until it exists.
6. **`MAILHOG_URL` has no source anywhere in `.config`** (§4.3) — the mail sink APW-07 depends on does not
   appear to be deployed.
7. **`EVER_WORKS_GITHUB_PAT_CLASSIC` lacks `read:org`**, which GITHUB-PERMISSIONS row 3 needs for the
   fork-target picker (§5.5). The platform's connected OAuth account _does_ list organizations successfully, so
   the live lane is fine — but the PAT is not a drop-in substitute for `APW_E2E_GITHUB_USER_TOKEN`.
8. **`createOrganization` writes outside `organizations`.** Step (e) of the documented flow runs an
   unconditional NULL-only `tenantId` backfill over every user-owned table (`organization.service.ts:412-415`,
   `:573-592`). It is idempotent and was a no-op here, but "POST one Organization" is not a single-table write
   and no API response says so. Flagged for the programme's blast-radius notes.

---

## 9. Changelog

| Date       | Change                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-17 | Created. Two Organizations (`app-works-dev`, `app-works-stage`) provisioned under the pre-existing Tenant; GitHub fork space identified as the connected `evereq` OAuth account; gaps recorded in §5. Not committed, not pushed. |
| 2026-09-26 | Repository names and visibility re-measured (§4.3 note, §5.4): `cal-template` (was `cal-diy-template`), `umami-template` and `platforms` public; the fixture template private.                                                   |
