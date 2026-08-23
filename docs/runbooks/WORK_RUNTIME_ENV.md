# Per-Work runtime env — allow-listed env vars for deployed directories

> Companion to [`docs/features/k8s-deployment.md`](../features/k8s-deployment.md)
> (how a Work reaches the cluster) and
> [`docs/specs/features/work-db-storage-and-subdomains/design.md`](../specs/features/work-db-storage-and-subdomains/design.md)
> (the `DATABASE_URL` / shared-DB half of the same endpoint).
> Code: `packages/agent/src/services/work-runtime-env.service.ts`,
> `packages/agent/src/services/work-runtime-env.constants.ts`,
> `apps/api/src/plugins-capabilities/deploy/deploy.controller.ts`,
> `apps/api/src/plugins-capabilities/deploy/deploy.service.ts`.

## What this is

A deployed directory site (`directory-web-template`) reads a handful of
**per-site** settings from `process.env` that the platform cannot derive on its
own — today the Stripe payment configuration. This runbook covers the small,
**allow-listed** set of per-Work runtime env vars an operator (the Work owner
or a member with edit rights) can set from the dashboard or the API, how they
are stored, and how they reach the running site.

It does **not** cover the platform-managed keys (`AUTH_SECRET`,
`COOKIE_SECRET`, `DATABASE_URL`, `GH_TOKEN`, `DATA_REPOSITORY`, `TENANT_ID`,
`SITE_URL`, `PLATFORM_*`, …). Those are minted by `DeployService` /
`WorkRuntimeEnvService` on every deploy and are deliberately **not** settable
through this surface — the allow-list is the guard.

## The allow-list

Source of truth: `WORK_RUNTIME_ENV_ALLOWED_KEYS` in
`packages/agent/src/services/work-runtime-env.constants.ts`.

| Key                                  | Secret (masked `***`) | Purpose in the template                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_PAYMENT_PROVIDER`       | no                    | Selects the payment provider (`stripe`).                |
| `STRIPE_SECRET_KEY`                  | **yes**               | Server-side Stripe API key (`sk_live_…` / `sk_test_…`). |
| `STRIPE_PUBLISHABLE_KEY`             | no                    | Publishable key (server-side alias).                    |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | no                    | Publishable key exposed to the browser bundle.          |
| `STRIPE_WEBHOOK_SECRET`              | **yes**               | Signing secret for `/api/webhooks/stripe` (`whsec_…`).  |
| `NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING` | no                    | Feature toggle (`true` / `false`).                      |
| `STRIPE_SPONSOR_WEEKLY_PRICE_ID`     | no                    | Stripe Price id for the weekly sponsor slot.            |
| `STRIPE_SPONSOR_MONTHLY_PRICE_ID`    | no                    | Stripe Price id for the monthly sponsor slot.           |

Rules enforced by `WorkRuntimeEnvService.setRuntimeEnvVars`:

- Any key outside the list → **400** (`Unsupported runtime env key(s): …`);
  the whole call is rejected, nothing is written.
- Values are trimmed; empty / whitespace-only / `null` **removes** the key.
- Max 4096 characters per value; control characters are rejected.
- Merge-patch semantics: keys you do not mention are left untouched.

To add a key: extend `WORK_RUNTIME_ENV_ALLOWED_KEYS` (and
`WORK_RUNTIME_ENV_SECRET_KEYS` if it is a credential), run the agent spec
`work-runtime-env.service.spec.ts`, and update the table above. The dashboard
renders the form from the API's `allowedEnvKeys`, so no UI change is needed.

## Storage

All configured keys for a Work are stored as **one JSON map**, AES-256-GCM
encrypted with `PLATFORM_ENCRYPTION_KEY`, in `works.deployRuntimeEnvEncrypted`
(migration `1787423600000-AddWorkDeployRuntimeEnvVars`). Same envelope and
helper as the sibling `deployDatabaseUrlEncrypted` column. `NULL` means
nothing is configured.

Reads are defensive: keys no longer allow-listed (or non-string values) are
dropped when the map is decoded, so the allow-list remains authoritative even
over old rows.

## How the values reach the site

Nothing is applied live — **a redeploy is required** after any change.

1. **Server-side managed k8s deploys** (`k8s-works` / `k8s-works-shared`):
   `DeployService.collectServerSideRuntimeEnv` merges the map into the env the
   k8s plugin writes to the `${slug}-runtime-env` Secret (mounted via
   `envFrom`). The merge runs **after** every platform-managed key, so a
   managed key always wins on a collision. Applied key names (never values)
   are logged at `debug`.
2. **Workflow deploys** (GitHub Actions — custom kubeconfig and Vercel):
   `DeployService.pushWorkRuntimeEnvSecrets` pushes each configured key as a
   **GitHub Actions repo secret** on the Work's website repo, right after the
   managed runtime env. `deploy_k8s.yaml` forwards every non-CI repo secret
   into the cluster Secret; the Vercel workflows can read
   `secrets.STRIPE_SECRET_KEY` etc. the same way. Provider-agnostic and
   best-effort (a push failure logs and the deploy continues).

## API

Both endpoints require edit rights on the Work (`WorkOwnershipService.ensureCanEdit`).

### Read (masked)

```http
GET /api/deploy/works/{workId}/runtime-env
```

```json
{
	"status": "success",
	"mode": "shared",
	"sharedAvailable": true,
	"databaseUrl": { "configured": true, "masked": "postgresql://app:***@db.example.com/work_123" },
	"managed": ["AUTH_SECRET", "COOKIE_SECRET", "COOKIE_SECURE"],
	"allowedEnvKeys": [
		"NEXT_PUBLIC_PAYMENT_PROVIDER",
		"STRIPE_SECRET_KEY",
		"STRIPE_PUBLISHABLE_KEY",
		"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING",
		"STRIPE_SPONSOR_WEEKLY_PRICE_ID",
		"STRIPE_SPONSOR_MONTHLY_PRICE_ID"
	],
	"env": [
		{ "key": "NEXT_PUBLIC_PAYMENT_PROVIDER", "set": true, "masked": "stripe", "secret": false },
		{ "key": "STRIPE_SECRET_KEY", "set": true, "masked": "***", "secret": true },
		{ "key": "STRIPE_PUBLISHABLE_KEY", "set": false, "masked": null, "secret": false },
		{ "key": "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "set": true, "masked": "pk_live…", "secret": false },
		{ "key": "STRIPE_WEBHOOK_SECRET", "set": false, "masked": null, "secret": true },
		{ "key": "NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING", "set": false, "masked": null, "secret": false },
		{ "key": "STRIPE_SPONSOR_WEEKLY_PRICE_ID", "set": false, "masked": null, "secret": false },
		{ "key": "STRIPE_SPONSOR_MONTHLY_PRICE_ID", "set": false, "masked": null, "secret": false }
	]
}
```

`env` always lists **every** allow-listed key so a client can render the full
form; `masked` is `***` for secrets and a 7-character prefix + `…` otherwise
(short toggle/enum values such as `stripe` or `true` are shown verbatim).
Plaintext is never returned.

### Write (merge-patch)

```http
PUT /api/deploy/works/{workId}/runtime-env
Content-Type: application/json

{
    "env": {
        "NEXT_PUBLIC_PAYMENT_PROVIDER": "stripe",
        "STRIPE_SECRET_KEY": "sk_live_…",
        "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_live_…",
        "STRIPE_WEBHOOK_SECRET": null
    }
}
```

- A body with **only `env`** leaves the database mode/URL untouched.
- `mode` / `databaseUrl` keep their pre-existing behaviour and may be sent
  together with `env` in one call.
- Response: same shape as `GET` plus `message` (for example
  `"Environment variables updated. Redeploy to apply them to the live site."`).
- `400` for a non-allow-listed key, an over-long value, or a malformed body.

### Dashboard

**Work → Deploy → Database & environment → Environment variables**: one row
per allow-listed key with the masked current value, an input, **Save**, and
**Remove** (sends `null`). Secrets use a password field and are never echoed
back.

## Operational notes

- **Rotation**: save the new value, then redeploy. Server-side deploys
  re-apply the Secret on every deploy (server-side apply is idempotent); the
  workflow path overwrites the repo secret.
- **Removing a key** from the Work does not delete an already-pushed GitHub
  repo secret (GitHub has no "unset on next deploy" semantics for a value we
  no longer know about); delete it in the repo's _Settings → Secrets_ if the
  leftover matters. The server-side k8s path rebuilds the Secret from scratch
  each deploy, so removals take effect there on the next deploy.
- **`PLATFORM_ENCRYPTION_KEY` missing** on the API: writes fail with a clear
  error; deploys log `Runtime-env per-Work env lookup failed …` and proceed
  without the vars.
- **`PUT … {"mode":"shared"}` answers 503 `SHARED_DB_PROVISION_FAILED`**: the
  API switched the Work to the Ever Works DB mode but `ensureDatabaseForWork`
  (direct DDL over `DB_EVER_WORKS_SHARED_ADMIN_URL`: `CREATE ROLE` /
  `CREATE DATABASE`) threw. The body's `reason` is the sanitized errno /
  SQLSTATE class — `connection refused [ECONNREFUSED]`,
  `host not found [ENOTFOUND]`, `password authentication failed [28P01]`,
  `insufficient privilege … [42501]`, … — never the connection string (the
  full error is in the API log: `Shared DB provisioning failed for work …`).
  Fix the admin connection (reachability from the API pods, credentials,
  `CREATEDB` / `CREATEROLE` on the admin role) and re-send the same request;
  deploys also retry provisioning idempotently (warn-level
  `Shared DB provision failed for work …` when it keeps failing — the site then
  runs without `DATABASE_URL`). Before this the endpoint answered a bare 500.
- **Audit**: every write logs an Activity Feed entry
  (`work.runtime-env.updated`) with the changed key **names**; values are
  never logged anywhere.
