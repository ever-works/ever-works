# App Works — configuration inventory

**Status:** `Draft` · **Created:** 2026-09-17 · **Program:** [App Works](./README.md)
**Closes:** `EXT-23` (no per-environment configuration inventory; Ever ID env names and PostHog flags missing
from CONTRACTS) · `EXT-24` (catalog branches, tags and per-environment pins undefined)
**Owner:** programme level — every epic contributes its own rows; no epic may add a setting without a row here.
**Companion documents:** [CONTRACTS.md](./CONTRACTS.md) §7 (flags and environment variables — normative for
names and defaults) · §8 (catalog repositories) · [ACCEPTANCE.md](./ACCEPTANCE.md) §0 (lanes, per-lane flags,
secrets by name only) · [README.md](./README.md) §7 (the rules every epic follows) ·
[data-model.md](./data-model.md) · [quickstart.md](./quickstart.md) ·
[`contracts/README.md`](./contracts/README.md) · [`contracts/agent-surfaces.md`](./contracts/agent-surfaces.md)

---

## 0. How to read this document

**Names only, never values.** This repository is public (README §7 rule 10). Every table below carries a
name, a purpose, a **default as the specs state it** and a `secret` column — never a real value, never a
hostname, never a credential. Real values live in the private operations repository and in the GitHub
Actions environments of the lane's workflow ([ACCEPTANCE.md](./ACCEPTANCE.md) §0.4).

**Three layers of configuration exist, and they are not interchangeable.**

| Layer                        | What it is                                                                                                                                                                                                                         | Set where                                                                 | Normative list                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| **Operator environment**     | Process environment of `apps/api`, `apps/web` and the workers. `EVER_WORKS_*` names.                                                                                                                                               | the deployment configuration of the installation (dev, stage, production) | [CONTRACTS.md](./CONTRACTS.md) §7 · §3 below |
| **Feature flags**            | PostHog flags the web evaluates at render time (`works-app`, `app-launcher`, `ever-id`, `works-app-previews`).                                                                                                                     | the PostHog project of the environment                                    | §2 below                                     |
| **Database-backed settings** | Runtime settings with a fail-closed row: extension instance settings, plugin settings (`PATCH /api/works/:workId/plugins/:pluginId/settings`), APW-10's tier state and quota profiles, APW-12's identity-provider plugin settings. | the product's own admin surfaces                                          | [CONTRACTS.md](./CONTRACTS.md) §2 · §5 below |

A variable that appears in the API's process environment has **no effect on the web** and vice versa; the
web's flag evaluation is a separate read of PostHog. Where a setting has both an env twin and a flag, both
are listed and the epic that owns the pair names them together (for example `EVER_WORKS_APP_WORKS_ENABLED`
and `works-app`, [CONTRACTS.md](./CONTRACTS.md):472-473).

**Adding a setting.** Add the row to [CONTRACTS.md](./CONTRACTS.md) §7 **and** here, in the same PR, with an
owner epic — README §7 rule 2's "no duplicate nouns" applies to settings as well. A setting with no reader
is a defect, not configuration; `BUILD-READINESS.md` §3 records two such cases already closed
(`upstreamPullRequests.maxOpen`, `upstreamSync.enabled`).

**Reserved prefix.** `EVER_WORKS_` is reserved for platform-injected values inside an App Work: an App spec
entry whose name starts with that prefix is an error (`reserved_env_name`, [CONTRACTS.md](./CONTRACTS.md)
C2 · [APW-03 `schema.md`](./APW-03-app-spec-and-catalog/schema.md)). The `EVER_WORKS_*` **operator**
variables below are the platform's own process environment and are a different namespace in practice — they
are never rendered into a tenant pod except the four §6 injects deliberately.

**Read this before you set anything: none of it is implemented yet (2026-09-17).** A grep for
`process.env.EVER_WORKS_APP_WORKS_ENABLED`, `EVER_WORKS_APP_LAUNCHER_ENABLED`, `EVER_WORKS_APPS_*`,
`EVER_WORKS_PLATFORM_CATALOG_*` and `EVER_WORKS_E2E_FAKES` across every `*.ts` in the repository returns
**nothing**, and `apps/api/.env.example` contains no App Works variable. Every name below is
**specification**, not shipped configuration; APW-01's own acceptance criterion —
_"`apps/api/.env.example` contains `EVER_WORKS_APP_WORKS_ENABLED=false`"_
([`APW-01/tasks.md`](./APW-01-app-work-kind/tasks.md) T7) — is **not met today**. The reader will be
`packages/agent/src/config/index.ts`'s `everWorks` block (`:1044`), extended with an `everWorks.apps`
sub-block ([`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §8.3), which is the same pattern the existing
`everWorks.deploy` gate uses.

**Update (2026-09-26) — the paragraph above is stale.** The same grep now finds readers for every one of its
patterns: `EVER_WORKS_APP_WORKS_ENABLED` (`packages/agent/src/config/index.ts:1065`, the `everWorks.apps` block at
`:1063`; `apps/web/src/lib/feature-flags/work-kinds.ts:88`), `EVER_WORKS_APP_LAUNCHER_ENABLED`
(`packages/agent/src/config/index.ts:2406`), `EVER_WORKS_PLATFORM_CATALOG_*`
(`apps/api/src/app-launcher/platform-catalog.service.ts`, `apps/api/src/app-launcher/app-launcher.controller.ts:387`,
`packages/agent/src/app-launcher/app-launcher.service.ts`), `EVER_WORKS_APPS_*` (`packages/agent/src/config/index.ts`
`:1171`–`:1334`; `packages/agent/src/app-runtime/app-hosts.service.ts:662`; `EVER_WORKS_APPS_CATALOG_TOKEN` in
`packages/agent/src/apps-catalog/app-blueprint-resolver.service.ts:434`; `EVER_WORKS_APPS_LOCAL_WORKER_PORT` in
`packages/tasks/src/tasks/trigger/app-runtime-local-worker.ts:392`) and `EVER_WORKS_E2E_FAKES`
(`apps/api/src/app-launcher/platform-catalog.service.ts:396`). `APP_WORKS_CLOUD_PUSH_ENABLED`, outside that grep, is
read at `packages/agent/src/config/index.ts:1091`. `apps/api/.env.example` now carries
`EVER_WORKS_APP_WORKS_ENABLED=false` (`:366`), `APP_WORKS_CLOUD_PUSH_ENABLED=false` (`:375`),
`EVER_WORKS_APP_LAUNCHER_ENABLED=false` (`:381`) and `EVER_WORKS_PLATFORM_CATALOG_{REPO,REF,ENV,SELF_ID}`
(`:391`–`:394`), so APW-01 T7's criterion is met. The rows below were not re-audited one by one: a row that cites a
file and line names its reader; any other row's Source column is the specification that defines the name.

---

## 1. Where each setting is read from in the real codebase

| Surface                                   | Reader                                                                                                                                                              | Evidence                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API process environment                   | `packages/agent/src/config/index.ts` — one `config` object literal of plain getters reading `process.env` directly; there is **no Joi/zod env schema** in this repo | `packages/agent/src/config/index.ts:110` (`export const config = {`) · `:1047` (`everWorks: {`) · `apps/api/src/config/` holds no `index.ts`            |
| Plugin settings (incl. `x-envVar` fields) | each plugin's `src/settings.schema.ts`, surfaced through `PATCH /api/works/:workId/plugins/:pluginId/settings`                                                      | [CONTRACTS.md](./CONTRACTS.md) §4 (APW-05 row) · APW-12 `plan.md` §4.2 (`EVER_ID_*` are `x-envVar` on the `oidc-identity` plugin, `:416-418`)           |
| Web flags                                 | `apps/web/src/lib/feature-flags/work-kinds.ts` for `works-<kind>` chips; the `app-launcher` and `ever-id` flags are evaluated fail-closed by their own call sites   | `work-kinds.ts:13`, `:23` (`workKindFlagKey`), `:36-50` (PostHog client: `POSTHOG_API_KEY`, `POSTHOG_HOST`), `:72` · [CONTRACTS.md](./CONTRACTS.md) R-6 |
| Machine-readable contracts                | `apps/api/src/openapi/generate-openapi.ts` → `apps/api/openapi.json` (**git-ignored**), consumed by `apps/mcp`                                                      | `.gitignore:80-81` · [`contracts/README.md`](./contracts/README.md) §1                                                                                  |
| Database-backed settings                  | the product's own admin surfaces (see §5)                                                                                                                           | [CONTRACTS.md](./CONTRACTS.md) §2 · §7A                                                                                                                 |

---

## 2. Feature flags (PostHog) — per environment

The four flags below must **exist** in every PostHog project an environment reads, including `local`. A
missing flag is a refusal, not a default: `works-app` in particular is evaluated **fail-closed** for the
`app` kind (R-6, [CONTRACTS.md](./CONTRACTS.md):49), unlike every other `works-<kind>` chip, which is
fail-open today.

| Flag                 | Default                                            | Purpose                                                            | Owner  | Local                                                          | dev | stage               | production                                        | Source                                                                      |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | ------ | -------------------------------------------------------------- | --- | ------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| `works-app`          | off in production until Wave 1 acceptance is green | the **App** chip in the create-Work UI; fail-closed for kind `app` | APW-01 | on                                                             | on  | on                  | off until Wave 1 acceptance is green              | [CONTRACTS.md](./CONTRACTS.md):472 · [ACCEPTANCE.md](./ACCEPTANCE.md):68    |
| `app-launcher`       | off                                                | the App Launcher panel in the dashboard shell                      | APW-11 | on                                                             | on  | on                  | per release; off until Wave 1 acceptance is green | [CONTRACTS.md](./CONTRACTS.md):488 · [ACCEPTANCE.md](./ACCEPTANCE.md):70    |
| `ever-id`            | off                                                | Ever ID sign-in entry points; fail-closed                          | APW-12 | on (against the fake OpenID Connect provider in the PR suites) | on  | on (for ACC-E2E-13) | off                                               | [CONTRACTS.md](./CONTRACTS.md):498 · [ACCEPTANCE.md](./ACCEPTANCE.md):71-73 |
| `works-app-previews` | off — Wave 3                                       | preview Deployments per pull request                               | APW-06 | off                                                            | off | off                 | off (Wave 3)                                      | [CONTRACTS.md](./CONTRACTS.md):485                                          |

**The web flag is never the only gate.** The API refuses kind `app` on the instance setting
`EVER_WORKS_APP_WORKS_ENABLED` from every client — web, chat, MCP **and** CLI (R-6). Turning the PostHog flag
on without the env variable produces a chip that always refuses.

---

## 3. Operator environment variables — master inventory

Names, defaults, ownership and the `file:line` of the normative row. `secret` = the specs mark the value
`x-secret`/encrypted; **no value is reproduced here**.

| Name                                                | Kind                        | Default (as specified)                                                                                                                                                             | Secret  | Owner                 | Source                                                                                                                            |
| --------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_APP_WORKS_ENABLED`                      | env                         | `false` — API-side twin of `works-app`; chat and MCP bypass the chip, so this is the real gate                                                                                     | no      | APW-01                | [CONTRACTS.md](./CONTRACTS.md):473                                                                                                |
| `APP_WORKS_CLOUD_PUSH_ENABLED`                      | env                         | `false` — on only for exactly `'true'`. Off: `finalizeRun`, `commitToRepo` and `openPullRequest` publish nothing for an App Work until APW-08 T12; on, each judges it first (T-03) | no      | APW-08                | `packages/agent/src/config/index.ts:1097` · gate `app-work-cloud-push.ts` · [`APW-08/plan.md`](./APW-08-evolve-loop/plan.md) §2.5 |
| `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`          | env                         | unset — honoured only when `NODE_ENV` ≠ production, clamped 5 000–900 000 (FR-18a)                                                                                                 | no      | APW-02                | [CONTRACTS.md](./CONTRACTS.md):474                                                                                                |
| `EVER_WORKS_APPS_CATALOG_REPO`                      | env                         | `ever-works/templates` (the listing repository; the earlier drafts said `ever-works/apps` and an installation carrying that value keeps working)                                   | no      | APW-03                | [CONTRACTS.md](./CONTRACTS.md):475                                                                                                |
| `EVER_WORKS_APPS_CATALOG_REF`                       | env                         | `main` — **pin a SHA or tag in production**                                                                                                                                        | no      | APW-03                | [CONTRACTS.md](./CONTRACTS.md):476                                                                                                |
| `EVER_WORKS_APPS_CATALOG_TOKEN`                     | env                         | unset — optional token for the catalog fallback read, and the Blueprint resolver's second credential (after the `ever-works` App installation, before `GITHUB_TOKEN`)              | **yes** | APW-03                | [CONTRACTS.md](./CONTRACTS.md):477                                                                                                |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                   | env                         | `false` — the installation **ceiling** for the managed tier; only APW-10's launch gate may flip it, and product code asks `AppsTierPolicy.isOpen()` instead of reading it (R-5)    | no      | APW-10                | [CONTRACTS.md](./CONTRACTS.md):478                                                                                                |
| `EVER_WORKS_APPS_DOMAIN`                            | env                         | **defaults to `EVER_WORKS_DOMAIN`** — `<slug>.ever.works` works out of the box; set it to a dedicated PSL-listed apex and that apex keeps the full validation + PSL checks (LG-15) | no      | APW-06                | [CONTRACTS.md](./CONTRACTS.md):479 · [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §8.3                                        |
| `EVER_WORKS_DOMAIN`                                 | env                         | the platform's own apex (the default of `EVER_WORKS_APPS_DOMAIN`)                                                                                                                  | no      | APW-06                | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §8.3                                                                             |
| `EVER_WORKS_APPS_MAX_PER_USER`                      | env                         | `3`                                                                                                                                                                                | no      | APW-06                | [CONTRACTS.md](./CONTRACTS.md):480                                                                                                |
| `EVER_WORKS_APPS_DNS_ZONE_ID`                       | env                         | unset — no managed subdomains without it; on the shared default this is the platform domain's own zone                                                                             | no      | APW-06                | [CONTRACTS.md](./CONTRACTS.md):481                                                                                                |
| `EVER_WORKS_APPS_DNS_API_TOKEN`                     | env                         | unset                                                                                                                                                                              | **yes** | APW-06                | [CONTRACTS.md](./CONTRACTS.md):482                                                                                                |
| `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`           | env                         | `false` — production refuses App Work cluster jobs until the operator declares the isolated worker                                                                                 | no      | APW-06                | [CONTRACTS.md](./CONTRACTS.md):483                                                                                                |
| `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`         | env                         | empty — CIDRs exempt from the public-address rule for self-hosted installations and e2e                                                                                            | no      | APW-06                | [CONTRACTS.md](./CONTRACTS.md):484                                                                                                |
| `EVER_WORKS_APPS_LOCAL_WORKER`                      | env                         | `false` — runs the isolated worker in-process; **refused in production**                                                                                                           | no      | APW-06                | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) (env table, GAP entry `EVER_WORKS_APPS_LOCAL_WORKER`)                            |
| `EVER_WORKS_APP_PROVISION_TOKEN_CAP`                | env                         | `3000000` — per-provisioning token cap, clamped 500000–10000000                                                                                                                    | no      | APW-04                | [CONTRACTS.md](./CONTRACTS.md):486                                                                                                |
| `EVER_WORKS_APP_PROVISION_RUNNER_MINUTE_CAP`        | env                         | `240` — per-provisioning runner-minute cap, clamped 60–600                                                                                                                         | no      | APW-04                | [CONTRACTS.md](./CONTRACTS.md):487                                                                                                |
| `EVER_WORKS_AGENTS_REF`                             | env                         | the ref the agent-template catalog reads; APW-04 T30/T31 pin it per environment                                                                                                    | no      | APW-04                | [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T33 · [`APW-04/plan.md`](./APW-04-app-provisioner/plan.md) (Templates row) |
| `EVER_WORKS_APP_LAUNCHER_ENABLED`                   | env                         | `false` — API master switch; the web also honours flag `app-launcher`, fail-closed                                                                                                 | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):489                                                                                                |
| `EVER_WORKS_PLATFORM_CATALOG_REPO`                  | env                         | `ever-works/platforms` (validated `^ever-works\/[a-z0-9-]+$`)                                                                                                                      | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):490 · [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §5.2                                       |
| `EVER_WORKS_PLATFORM_CATALOG_REF`                   | env                         | `main` — warn when not a tag or 40-char SHA; pinned per environment (§7)                                                                                                           | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):490 · [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §5.2                                       |
| `EVER_WORKS_PLATFORM_CATALOG_ENV`                   | env                         | `production` (one of `production` \| `stage` \| `develop`) — selects the URL column of the catalog                                                                                 | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):490 · [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §5.2                                       |
| `EVER_WORKS_PLATFORM_CATALOG_SELF_ID`               | env                         | `ever-works` — the catalog id that means "this platform"                                                                                                                           | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):490                                                                                                |
| `EVER_WORKS_APP_LAUNCHER_ORIGINS`                   | env                         | unset — ≤ 50 exact `https` origins for P2 delegated reads, no credentials                                                                                                          | no      | APW-11                | [CONTRACTS.md](./CONTRACTS.md):491                                                                                                |
| `EVER_WORKS_APPS_MAX_SCOPE`                         | env                         | `verified-blueprints` (`any` allowed in Wave 3)                                                                                                                                    | no      | APW-10                | [CONTRACTS.md](./CONTRACTS.md):492                                                                                                |
| `EVER_WORKS_APPS_CONTROL_KUBECONFIG`                | env                         | unset — control-namespace-only credential for the `ever-works-apps` plugin                                                                                                         | **yes** | APW-10                | [CONTRACTS.md](./CONTRACTS.md):493                                                                                                |
| `EVER_WORKS_APPS_CONTROL_NAMESPACE`                 | env                         | `ever-works-apps-control`                                                                                                                                                          | no      | APW-10                | [CONTRACTS.md](./CONTRACTS.md):494                                                                                                |
| `EVER_WORKS_APPS_GATE_MAX_AGE_HOURS`                | env                         | `24` — may be lowered, never raised above 24                                                                                                                                       | no      | APW-10                | [CONTRACTS.md](./CONTRACTS.md):495                                                                                                |
| `EVER_WORKS_APPS_CONTROLLER_MIN_VERSION`            | env                         | unset = no minimum                                                                                                                                                                 | no      | APW-10                | [CONTRACTS.md](./CONTRACTS.md):496                                                                                                |
| `EVER_ID_ISSUER_URL`                                | plugin setting (`x-envVar`) | — **required** (no default)                                                                                                                                                        | no      | APW-12                | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §4.2                                                                                 |
| `EVER_ID_CLIENT_ID`                                 | plugin setting (`x-envVar`) | — **required** (no default)                                                                                                                                                        | no      | APW-12                | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §4.2                                                                                 |
| `EVER_ID_CLIENT_SECRET`                             | plugin setting (`x-envVar`) | — **required**, `client_secret_basic`                                                                                                                                              | **yes** | APW-12                | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §4.2                                                                                 |
| `EVER_WORKS_OPENAPI_SPEC_PATH`                      | env (MCP)                   | unset — absolute path of the OpenAPI document bundled into the MCP image; production cannot fetch the live spec (C-09), so this is the only source there                           | no      | existing (`apps/mcp`) | `apps/mcp/src/config/mcp-config.service.ts:50`                                                                                    |
| `EVER_WORKS_API_URL`                                | env (MCP)                   | `http://localhost:3100` — where the MCP server fetches `/openapi.json` when no bundled spec is present                                                                             | no      | existing (`apps/mcp`) | `apps/mcp/src/config/mcp-config.service.ts:65`                                                                                    |
| `EVER_WORKS_AGENTS_REF`                             | env                         | **no default stated** — the ref the agent-template catalog reads; APW-04 T33 pins it per environment                                                                               | no      | APW-04                | [`APW-04/plan.md`](./APW-04-app-provisioner/plan.md) (Templates row) · [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T33 |
| `EVER_WORKS_APPS_LOCAL_WORKER`                      | env                         | `false` — runs the App runtime worker in-process; **refused when `NODE_ENV=production`**                                                                                           | no      | APW-06                | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §6.2/§8.3 (env table)                                                            |
| `EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST`       | env                         | empty — comma-separated CIDRs exempt from the public-address rule for dependency endpoints                                                                                         | no      | APW-07                | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §7                                                                  |
| `EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ACCOUNT`      | env                         | `1000` — per-account daily cap on the platform SMTP relay                                                                                                                          | no      | APW-07                | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §7                                                                  |
| `EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ORGANIZATION` | env                         | `5000` — per-organization daily cap on the same relay                                                                                                                              | no      | APW-07                | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §7                                                                  |
| `EVER_WORKS_APP_RELAY_SUSPEND_BOUNCE_RATE`          | env                         | `5%` — a bounce or complaint rate above this suspends the relay for that App Work                                                                                                  | no      | APW-07                | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §7                                                                  |
| `EVER_WORKS_DB_PROVISION_IT_URL`                    | env (**test only**)         | unset — the kind lane sets it to a throwaway Postgres so ACC-REG-10's integration spec runs instead of self-skipping                                                               | no      | APW-13                | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T35                                                                           |
| `POSTHOG_API_KEY` / `POSTHOG_HOST`                  | env (web)                   | unset / `https://app.posthog.com` — the client `work-kinds.ts` uses to evaluate the chip flags; **not named in the programme's own spec text**                                     | no      | existing (web)        | `apps/web/src/lib/feature-flags/work-kinds.ts:41,47`                                                                              |

### 3A. The R-30 operator kill switches

Resolution **R-30** adds one operator switch per App Works **background family**, read by that family's **job
dispatcher** and **failing closed**:

> *"**'App Works off' is defined, not implied**: with every switch off, App Works stop *changing anything* —
> jobs pause (no new dispatches, running jobs finish their current step and park), the UI is read-only with a
> banner, existing Deployments keep running, sign-in and data reads keep working. Turning a switch back on
> resumes; nothing is deleted and no state is lost.* — [CONTRACTS.md](./CONTRACTS.md) §0, R-30

| Switch                                | Guards                                                      | Owner  | Default (fail-closed) |
| ------------------------------------- | ----------------------------------------------------------- | ------ | --------------------- |
| `EVER_WORKS_APP_SYNC_ENABLED`         | APW-02 upstream sync + Actions-hygiene writes to user forks | APW-02 | off                   |
| `EVER_WORKS_APP_PROVISION_ENABLED`    | APW-04 provisioning                                         | APW-04 | off                   |
| `EVER_WORKS_APP_BUILDS_ENABLED`       | APW-05 build-workflow writes and Actions-secret sync        | APW-05 | off                   |
| `EVER_WORKS_APP_DEPS_ENABLED`         | APW-07 dependency provisioning and the mail relay           | APW-07 | off                   |
| `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED`  | APW-08 auto-delivery and APW-06 auto-deploy                 | APW-08 | off                   |
| `EVER_WORKS_APP_UPSTREAM_PRS_ENABLED` | APW-09 open/push (Wave 2 has no other switch)               | APW-09 | off                   |
| `EVER_WORKS_APP_MAIL_RELAY_ENABLED`   | APW-07's platform SMTP relay                                | APW-07 | off                   |

`EVER_WORKS_APP_WORKS_ENABLED` (R-6) keeps its separate meaning for create and inspect. **These seven are
not yet in [CONTRACTS.md](./CONTRACTS.md) §7's table** — §0 R-30 is their normative source; see §9 item 6.

### 3B. Quotas and caps (R-31)

Resolution **R-31** gives every unbounded App Works action a documented per-member and per-organization cap,
each with an environment override, a refusal code and user copy; the normative table is
[CONTRACTS.md](./CONTRACTS.md) **§7A "Quotas and caps"**. That section — not this one — is where the cap
values live, because a cap is a product limit rather than an environment variable; this document records only
that the overrides exist and that **raising a cap is an operator action**. Filling a cap is a refusal with
copy, never a silent drop and never a data deletion.

**Ever ID cross-platform variables** (other repositories — listed here so one inventory names them all; the
normative text is [`APW-12/cross-platform.md`](./APW-12-ever-id/cross-platform.md)):

| Name                                                      | Repository           | Purpose                                                                                                       | Secret                    | Source                                                         |
| --------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `EVER_ID_ISSUER`                                          | `ever-co/ever-teams` | Auth.js OIDC provider issuer                                                                                  | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.2 |
| `EVER_ID_CLIENT_ID` / `EVER_ID_CLIENT_SECRET`             | `ever-co/ever-teams` | Teams' relying-party client                                                                                   | secret (`_CLIENT_SECRET`) | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.2 |
| `NEXT_PUBLIC_EVER_ID_APP_NAME`                            | `ever-co/ever-teams` | advertises the provider so the button renders                                                                 | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.2 |
| `FEATURE_EVER_ID_API`                                     | `ever-co/ever-gauzy` | Gauzy API flag, evaluated as `process.env.FEATURE_EVER_ID_API === 'true'` (**not** `featureEnabled`)          | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.1 |
| `EVER_ID_ISSUERS`                                         | `ever-co/ever-gauzy` | 1–3 exact accepted issuer strings (P2 token verification)                                                     | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.1 |
| `EVER_ID_GAUZY_AUDIENCE`                                  | `ever-co/ever-gauzy` | expected `aud`, default `gauzy`                                                                               | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.1 |
| `EVER_ID_TRUSTED_CLIENT_IDS`                              | `ever-co/ever-gauzy` | trusted `azp` values, ≤ 5                                                                                     | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §4.1 |
| `EVER_ID_ISSUER` (**singular**)                           | `ever-co/ever-gauzy` | the P3 login plugin's Passport strategy issuer — a **different variable** from the plural above               | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §5.1 |
| `EVER_ID_GAUZY_CLIENT_ID` / `EVER_ID_GAUZY_CLIENT_SECRET` | `ever-co/ever-gauzy` | Gauzy's client at Ever ID (P3)                                                                                | secret (`_CLIENT_SECRET`) | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §5.1 |
| `FEATURE_EVER_ID_LOGIN`                                   | `ever-co/ever-gauzy` | Gauzy UI flag for the Ever ID button                                                                          | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §5.1 |
| `EVER_ID_ENABLED`                                         | `ever-co/ever-gauzy` | evaluated `=== 'true'` **inside the plugin**, which fails closed — stricter than the flag above               | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §5.1 |
| `MCP_AUTH_EVER_ID_ENABLED`                                | `ever-co/ever-gauzy` | federated Ever ID login on the MCP authorization server (a **different** subsystem from the MCP tool surface) | no                        | [`cross-platform.md`](./APW-12-ever-id/cross-platform.md) §7   |

> **Name divergence is deliberate and recorded, not a defect to "unify".** Ever Works' plugin setting is
> `EVER_ID_ISSUER_URL` (one issuer, one client — [APW-12 `plan.md`](./APW-12-ever-id/plan.md) §4.2); Teams
> uses `EVER_ID_ISSUER`; Gauzy uses the plural `EVER_ID_ISSUERS` for token verification **and** the singular
> `EVER_ID_ISSUER` for its login plugin — two distinct variables in one repository. Each platform keeps its
> own authentication and its own user database (owner decision, 2026-09-17, [README](./README.md) §8 Q6 ·
> [`idp-options.md`](./APW-12-ever-id/idp-options.md) §7 · Resolution **R-28**); renaming one to match another
> would be a removal under R-26 and is not authorised.

### 3C. Platform plugin-system switches App Works relies on (EW-693, added 2026-09-26)

Not App Works names — they belong to the plugin system (dynamic plugin distribution, EW-693) — but APW-04's App
Provisioner opens its sandbox sessions through them, so the inventory names them. The first three are read by the API
process (`apps/api/src/config/constants.ts`); `PLUGIN_EAGER_BUILTINS` and `PLUGIN_LAZY_LOAD` are read by the shared
`PluginBootstrapService`, so they apply in every process that bootstraps plugins, the Trigger.dev worker included
(`packages/tasks/src/trigger/worker/services/trigger-plugin-hydrator.service.ts` calls `bootstrap`), and
`PLUGIN_LOAD_CONCURRENCY` is read by the registry's loading helpers in the same processes. The user-facing reference is
[`docs/features/plugins.md`](../../../features/plugins.md); the first-load contract is in
[`docs/plugin-system/architecture.md`](../../../plugin-system/architecture.md#lazy-loading-and-the-first-load).

| Name                                      | Default      | Purpose                                                                                                                                                                                                                                                                                                                                                                             | Reader                                                                                                                     |
| ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN_SANDBOX_SESSIONS_VIA_JOB_RUNTIME` | `false`      | Where a restricted-network sandbox session runs: in the API process (`false`), or in the `run-plugin-operation` worker task with the Work's tenant (`true`). The session's caller passes the pipeline plugin it selected by `enforcesRuntimeNetworking` (APW-04 T48); no plugin id is named in core                                                                                 | `apps/api/src/config/constants.ts` (`sandboxSessionsViaJobRuntime`)                                                        |
| `PLUGIN_FACADE_INSTALL_ON_USE`            | `false`      | Dynamic mode only (FR-15): a facade that resolves a plugin the platform installed but this replica has not registered asks the installer for it first — the pinned version into this replica's own store, never writing the shared install row — and registers it                                                                                                                   | `apps/api/src/config/constants.ts` (`facadeInstallOnUse`)                                                                  |
| `PLUGIN_WARMUP_TIMEOUT_MS`                | `60000`      | Dynamic mode only: the longest the startup warmup waits for one plugin to be fetched; plugins warm in parallel, so it also bounds the whole wait. `0` = no bound. A slower plugin keeps fetching in the background                                                                                                                                                                  | `apps/api/src/config/constants.ts` (`warmupTimeoutMs`) · `packages/agent/src/plugins/services/plugin-installer.service.ts` |
| `PLUGIN_EAGER_BUILTINS`                   | `false`      | Landed 2026-09-26 (`60916d328`). Lazy mode only (`PLUGIN_LAZY_LOAD` not `false`): exactly `true` (case-sensitive) materialises the builtIn plugins discovered on disk at boot instead of on first use — the runtime switch back to the earlier boot. Measured over the real `packages/plugins`: eager 4.8–5.0 s and 323–357 MB RSS, lazy 56–69 ms and 108–114 MB RSS                | `packages/agent/src/plugins/services/plugin-bootstrap.service.ts` (API and worker)                                         |
| `PLUGIN_LAZY_LOAD`                        | unset (lazy) | Exactly `false` (case-sensitive) is the eager kill switch: every plugin discovered on disk is imported, registered as a real instance and runs `onLoad` at boot; any other value keeps lazy mode. A plugin registered at runtime in dynamic mode (`registerFromPath`, lazy by default) stays a proxy, and with no first-materialise hook wired its `onLoad` never runs              | `packages/agent/src/plugins/services/plugin-bootstrap.service.ts` (`bootstrap`; API and worker)                            |
| `PLUGIN_LOAD_CONCURRENCY`                 | `6`          | Added 2026-09-26 with the lazy-builtins follow-up. How many plugins one loading fan-out (`loadRegisteredPlugins`, `loadPluginSchemas`, `loadPluginsForListing`) imports at a time; a positive integer overrides `DEFAULT_PLUGIN_LOAD_CONCURRENCY`, anything else keeps it. Per fan-out, not process-wide (a process-wide pool would deadlock an `onLoad` that loads another plugin) | `packages/agent/src/plugins/services/plugin-registry.service.ts` (`pluginLoadConcurrency`; API and worker)                 |

The worker (`packages/tasks`) reads `PLUGIN_DISTRIBUTION_MODE`, `PLUGIN_REGISTRY_*` and `PLUGIN_INSTALL_DIR` as the
API does; in dynamic mode it installs a plugin its image does not carry into its own store (`run-plugin-operation`
only) and runs allowlisted third-party packages (owner decision 2026-09-25: core-only image plus third-party).

---

## 4. Per-environment state

`dev` / `stage` / `production` follow the three long-lived branches `develop` → `stage` → `main`
([README](./README.md) §7 rule 6 for the migration corollary; [TRACKER.md](./TRACKER.md) for the wave each
epic lands in). `local` is the author's workstation — [quickstart.md](./quickstart.md) is the runnable
version of this section.

Legend: **on** = the documented value for that environment · **off/unset** = the documented default ·
**pin** = a tag or 40-char SHA is expected, not a branch.

### 4.1 `local`

| Setting                                                         | State                                                                                                                                                     | Where it is set                               | Source                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `works-app`                                                     | **on**                                                                                                                                                    | PostHog project the local web points at       | [ACCEPTANCE.md](./ACCEPTANCE.md):68                                       |
| `EVER_WORKS_APP_WORKS_ENABLED`                                  | **`true`**                                                                                                                                                | `apps/api/.env`                               | [ACCEPTANCE.md](./ACCEPTANCE.md):68                                       |
| `app-launcher` / `EVER_WORKS_APP_LAUNCHER_ENABLED`              | **on** / `true` (off only inside `app-launcher-flag-off.spec.ts`)                                                                                         | PostHog + `apps/api/.env`                     | [ACCEPTANCE.md](./ACCEPTANCE.md):70                                       |
| `ever-id`                                                       | **on** against the **fake** OpenID Connect provider (the `oidc-identity` plugin) for APW-12's PR suites; `ever-id-disabled.spec.ts` turns it off per test | PostHog + plugin settings                     | [ACCEPTANCE.md](./ACCEPTANCE.md):71-73                                    |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                               | **`false`**, except one PR case in ACC-NEG-03 that sets it `true` with the tier **Closed**                                                                | `apps/api/.env`                               | [ACCEPTANCE.md](./ACCEPTANCE.md):74-79                                    |
| `EVER_WORKS_APPS_MAX_SCOPE`                                     | `verified-blueprints`                                                                                                                                     | `apps/api/.env`                               | [ACCEPTANCE.md](./ACCEPTANCE.md):79                                       |
| `EVER_WORKS_E2E_FAKES`                                          | **`1`** in the PR lanes                                                                                                                                   | the API's environment, beside the fake GitHub | [ACCEPTANCE.md](./ACCEPTANCE.md):80 · [quickstart.md](./quickstart.md) §5 |
| `EVER_WORKS_APPS_DOMAIN`                                        | **unset** — the shared default (`EVER_WORKS_DOMAIN`) applies                                                                                              | —                                             | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T34                   |
| `EVER_WORKS_APPS_DNS_ZONE_ID` / `EVER_WORKS_APPS_DNS_API_TOKEN` | **unset** — no real DNS zone is written                                                                                                                   | —                                             | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T34                   |
| `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`                     | may be set so a loopback/private kind ingress is exempt from the public-address rule                                                                      | `apps/api/.env`                               | [CONTRACTS.md](./CONTRACTS.md):484                                        |
| `EVER_WORKS_APPS_LOCAL_WORKER`                                  | `true` when the author wants the isolated worker in-process; **refused when `NODE_ENV=production`**                                                       | `apps/api/.env`                               | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) env table                |
| `EVER_ID_ISSUER_URL`                                            | points at the **fake** OIDC provider (a localhost `http://` issuer is accepted only when `NODE_ENV !== 'production'`)                                     | plugin settings                               | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §4.2                         |
| `EVER_WORKS_OPENAPI_SPEC_PATH`                                  | unset — the MCP server fetches the live `/api/openapi.json`, which is served outside production                                                           | `apps/mcp` environment                        | `apps/mcp/src/config/mcp-config.service.ts:50`                            |

### 4.2 `dev` (`develop`)

| Setting                                            | State                                                                                     | Where it is set                            | Source                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `works-app` + `EVER_WORKS_APP_WORKS_ENABLED`       | **on / `true`**                                                                           | PostHog + the dev deployment configuration | [ACCEPTANCE.md](./ACCEPTANCE.md):68-69                                                          |
| `app-launcher` + `EVER_WORKS_APP_LAUNCHER_ENABLED` | **on / `true`**                                                                           | PostHog + dev deployment configuration     | [ACCEPTANCE.md](./ACCEPTANCE.md):70                                                             |
| `ever-id`                                          | off (only the APW-12 PR suites turn it on, against the fake provider)                     | PostHog                                    | [ACCEPTANCE.md](./ACCEPTANCE.md):73                                                             |
| `EVER_WORKS_APPS_CATALOG_REF`                      | **pin** to a commit of the catalog's `e2e` branch, whose manifest adds the test upstreams | dev deployment configuration               | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T29 · [ACCEPTANCE.md](./ACCEPTANCE.md) §0.3 |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                  | `false` — the managed target is not open on dev                                           | dev deployment configuration               | [ACCEPTANCE.md](./ACCEPTANCE.md):74-79                                                          |
| `EVER_WORKS_APPS_MAX_SCOPE`                        | `verified-blueprints`                                                                     | dev deployment configuration               | [ACCEPTANCE.md](./ACCEPTANCE.md):79                                                             |
| `EVER_WORKS_E2E_FAKES`                             | **unset** — the fake is a PR-lane/local switch only                                       | —                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):80                                                             |
| `EVER_WORKS_AGENTS_REF` / the skills catalog ref   | **pin** for the environment (APW-04 T33 is the ship gate that does it)                    | dev deployment configuration               | [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T33                                      |
| `EVER_WORKS_APPS_DNS_ZONE_ID` / `_DNS_API_TOKEN`   | required only if managed subdomains are wanted on dev; unset means none are created       | dev deployment configuration               | [CONTRACTS.md](./CONTRACTS.md):481-482                                                          |
| `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`          | `false` until an operator declares the isolated worker                                    | dev deployment configuration               | [CONTRACTS.md](./CONTRACTS.md):483                                                              |

### 4.3 `stage`

| Setting                                            | State                                                                                                                                                                                                        | Where it is set                          | Source                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| `works-app` + `EVER_WORKS_APP_WORKS_ENABLED`       | **on / `true`**                                                                                                                                                                                              | PostHog + stage deployment configuration | [ACCEPTANCE.md](./ACCEPTANCE.md):68-69                     |
| `app-launcher` + `EVER_WORKS_APP_LAUNCHER_ENABLED` | **on / `true`**                                                                                                                                                                                              | PostHog + stage deployment configuration | [ACCEPTANCE.md](./ACCEPTANCE.md):70                        |
| `ever-id`                                          | **on** for ACC-E2E-13 (the only environment where it is on outside the PR suites)                                                                                                                            | PostHog + plugin settings                | [ACCEPTANCE.md](./ACCEPTANCE.md):71-73                     |
| `EVER_WORKS_APPS_CATALOG_REF`                      | **pin** to a commit of the catalog's `e2e` branch                                                                                                                                                            | stage deployment configuration           | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T29    |
| `EVER_WORKS_PLATFORM_CATALOG_REF`                  | **`v1.0.0`** — APW-11 T18's ship gate is the first tag of `ever-works/platforms`                                                                                                                             | stage deployment configuration           | [`APW-11/tasks.md`](./APW-11-app-launcher/tasks.md) T18    |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                  | the **only** environment where an operator sets `true`, and only when APW-10's P2 ship gate starts; the managed target is usable only while the tier is **opened** against a green self-check under 24 h old | stage deployment configuration           | [ACCEPTANCE.md](./ACCEPTANCE.md):74-79                     |
| `EVER_WORKS_APPS_MAX_SCOPE`                        | `verified-blueprints` until Wave 3, then `any` **on stage only**                                                                                                                                             | stage deployment configuration           | [ACCEPTANCE.md](./ACCEPTANCE.md):79                        |
| `EVER_WORKS_APPS_CONTROL_KUBECONFIG`               | required while the tier is open — control-namespace-only credential                                                                                                                                          | stage deployment configuration (secret)  | [CONTRACTS.md](./CONTRACTS.md):493                         |
| `EVER_WORKS_AGENTS_REF` / skills catalog ref       | **pin** for stage                                                                                                                                                                                            | stage deployment configuration           | [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T33 |
| `EVER_WORKS_E2E_FAKES`                             | **unset**                                                                                                                                                                                                    | —                                        | [ACCEPTANCE.md](./ACCEPTANCE.md):80                        |

### 4.4 `production` (`main`)

| Setting                                            | State                                                                                                                                                 | Where it is set                               | Source                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `works-app`                                        | **off until Wave 1 acceptance is green**                                                                                                              | PostHog                                       | [CONTRACTS.md](./CONTRACTS.md):472                                                                                                   |
| `EVER_WORKS_APP_WORKS_ENABLED`                     | `false` by default; flipped only as part of the Wave 1 release                                                                                        | production deployment configuration           | [CONTRACTS.md](./CONTRACTS.md):473                                                                                                   |
| `app-launcher` + `EVER_WORKS_APP_LAUNCHER_ENABLED` | `false` until the Wave 1 release decision                                                                                                             | PostHog + production deployment configuration | [CONTRACTS.md](./CONTRACTS.md):488-489                                                                                               |
| `ever-id`                                          | **off**                                                                                                                                               | PostHog                                       | [ACCEPTANCE.md](./ACCEPTANCE.md):73                                                                                                  |
| `EVER_WORKS_APPS_CATALOG_REF`                      | **pin to a tag or a commit SHA** — the production catalog read must be immutable; the platform logs a warning on every uncached read of a mutable ref | production deployment configuration           | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 · [`APW-03/tasks.md`](./APW-03-app-spec-and-catalog/tasks.md) T36 |
| `EVER_WORKS_APPS_CATALOG_TOKEN`                    | set when the listing is read through the authenticated fallback; also the Blueprint resolver's credential after the `ever-works` App installation     | production deployment configuration (secret)  | [CONTRACTS.md](./CONTRACTS.md):477                                                                                                   |
| `EVER_WORKS_PLATFORM_CATALOG_REF`                  | **pin** (a tag or 40-char SHA; a branch logs a warning)                                                                                               | production deployment configuration           | [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §5.2                                                                               |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                  | `false` until APW-10's P3 gate; even `true` only sets the **ceiling**, and the tier must still be **opened**                                          | production deployment configuration           | [CONTRACTS.md](./CONTRACTS.md):478 · [ACCEPTANCE.md](./ACCEPTANCE.md):74-79                                                          |
| `EVER_WORKS_APPS_MAX_SCOPE`                        | `verified-blueprints` (Wave 3 may allow `any`, never on production first)                                                                             | production deployment configuration           | [CONTRACTS.md](./CONTRACTS.md):492                                                                                                   |
| `EVER_WORKS_APPS_GATE_MAX_AGE_HOURS`               | `24` — may be lowered, **never raised above 24**                                                                                                      | production deployment configuration           | [CONTRACTS.md](./CONTRACTS.md):495                                                                                                   |
| `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`          | must be `true` before production accepts App Work cluster jobs                                                                                        | production deployment configuration           | [CONTRACTS.md](./CONTRACTS.md):483                                                                                                   |
| `APP_WORKS_CLOUD_PUSH_ENABLED`                     | `false` until APW-08 T12 (FR-12 isolated-run admission) lands — cloud runs have no admission yet                                                      | production deployment configuration           | `packages/agent/src/config/index.ts:1090` · [CONTRACTS.md](./CONTRACTS.md) §7                                                        |
| `EVER_WORKS_APPS_DNS_ZONE_ID` / `_DNS_API_TOKEN`   | required while managed subdomains are served                                                                                                          | production deployment configuration (secret)  | [CONTRACTS.md](./CONTRACTS.md):481-482                                                                                               |
| `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`         | **ignored** — honoured only when `NODE_ENV` ≠ production                                                                                              | —                                             | [CONTRACTS.md](./CONTRACTS.md):474                                                                                                   |
| `EVER_WORKS_APPS_LOCAL_WORKER`                     | **refused**                                                                                                                                           | —                                             | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) env table                                                                           |
| `EVER_WORKS_E2E_FAKES`                             | **ignored** — the fake-GitHub switch is refused when `NODE_ENV === 'production'`                                                                      | —                                             | [`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §8.3                                                                               |
| `EVER_ID_ISSUER_URL`                               | an `http://` issuer is refused (only `https://` outside non-production)                                                                               | plugin settings                               | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §4.2                                                                                    |
| `EVER_WORKS_OPENAPI_SPEC_PATH`                     | **set** — the live `/api/openapi.json` endpoint is disabled in production (C-09), so the bundled spec is the only source                              | MCP image build                               | `apps/mcp/src/config/openapi-loader.service.ts:70-77`                                                                                |

### 4.5 Lane-only variables (test harness, never a product setting)

These are read by the acceptance harness, not by product code. They are listed by **name only**, exactly as
[ACCEPTANCE.md](./ACCEPTANCE.md) §0.4 does; values live in the lanes' GitHub Actions environments.

| Name                                                              | Secret       | Lanes                                                         | Source                                                  |
| ----------------------------------------------------------------- | ------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| `APW_E2E_LIVE`, `APW_E2E_LANE`, `APW_E2E_RUN_ID`                  | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):116                    |
| `APW_E2E_ALLOWED_BASE_URLS`                                       | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):118                    |
| `APW_E2E_GITHUB_USER`, `APW_E2E_UPSTREAM_ORG`, `APW_E2E_FORK_ORG` | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):119                    |
| `APW_E2E_GITHUB_USER_TOKEN`, `APW_E2E_GITHUB_ESTATE_TOKEN`        | **yes**      | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):120-121                |
| `APW_E2E_UMAMI_REPO`, `APW_E2E_CALDIY_REPO`                       | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):122                    |
| `APW_E2E_USER_CLUSTER_KUBECONFIG`                                 | **yes**      | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):123                    |
| `APW_E2E_USER_CLUSTER_CONTEXT`, `APW_E2E_USER_CLUSTER_DOMAIN`     | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):124                    |
| `APW_E2E_APPS_TIER_READ_KUBECONFIG` / `APW_E2E_APPS_TIER_CONTEXT` | **yes** / no | golden path (Wave 2)                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):125                    |
| `APW_E2E_DNS_ZONE`, `APW_E2E_DNS_API_TOKEN`                       | no / **yes** | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):126                    |
| `APW_E2E_CANARY_SINK_URL`, `APW_E2E_CANARY_SINK_READ_TOKEN`       | no / **yes** | nightly                                                       | [ACCEPTANCE.md](./ACCEPTANCE.md):128                    |
| `APW_E2E_HONEYTOKEN`                                              | **yes**      | nightly                                                       | [ACCEPTANCE.md](./ACCEPTANCE.md):129                    |
| `APW_E2E_MANAGED_AGENT_API_KEY`                                   | **yes**      | nightly                                                       | [ACCEPTANCE.md](./ACCEPTANCE.md):130                    |
| `APW_E2E_TOKEN_BUDGET`, `APW_E2E_ACTIONS_MINUTES_BUDGET`          | no           | nightly, golden path                                          | [ACCEPTANCE.md](./ACCEPTANCE.md):131                    |
| `EVER_WORKS_E2E_FAKES`, `APW_E2E_GITHUB_FAKE_URL`                 | no           | PR, PR — cluster                                              | [ACCEPTANCE.md](./ACCEPTANCE.md):132                    |
| `APW_E2E_KIND_KUBECONFIG_PATH`                                    | no           | PR — cluster                                                  | [ACCEPTANCE.md](./ACCEPTANCE.md):133                    |
| `EVER_WORKS_DB_PROVISION_IT_URL`                                  | no           | PR — cluster (kind lane only; the spec self-skips without it) | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T35 |
| `APW_E2E_FLAGS_ON_LANE`                                           | no           | PR — flags-on job only                                        | `.github/workflows/e2e.yml` (`e2e-app-works-flags-on`)  |
| `APW_E2E_PLATFORM_CATALOG_PORT`                                   | no           | PR — flags-on job (default `4084`)                            | `apps/web/e2e/fakes/platform-catalog/server.mjs`        |

---

## 5. Database-backed settings introduced by the programme

Runtime state that is **not** an env variable and must not be duplicated as one. Each has a fail-closed
posture recorded in its epic.

| Setting                                                                             | Table / surface                                                                         | Posture                                                                                                           | Owner                    | Source                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Tier state (`closed` \| `open-verified-blueprints` \| `open-any`)                   | `apps_tier_state_events` (append-only)                                                  | "no row" can only mean "migration not applied" and is read as **closed** — the migration seeds one `closed` event | APW-10                   | [data-model.md](./data-model.md) §2 · [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4  |
| Lane gate items `LG-01`…`LG-25` attestations                                        | `apps_tier_attestations`                                                                | expires; a stale attestation closes the gate                                                                      | APW-10                   | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                                        |
| Quota profiles (`starter`, `standard`, …)                                           | `apps_tier_quota_profiles` + `works.appsTierQuotaProfile`                               | seeded by the migration; `NULL` = `starter`                                                                       | APW-10                   | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                                        |
| Per-Organization provisioner caps                                                   | `organizations.appProvisionCaps`                                                        | nullable; resolution order **Organization → instance env → default**                                              | APW-04                   | [data-model.md](./data-model.md) §3 · [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T41 |
| Plugin settings (build plugin id, `oidc-identity` settings, deploy target settings) | `Work`-scoped plugin settings via `PATCH /api/works/:workId/plugins/:pluginId/settings` | each plugin owns its schema; `x-envVar` fields fall back to the variables in §3                                   | APW-05 · APW-12 · APW-06 | [CONTRACTS.md](./CONTRACTS.md) §4                                                                |
| App env values (per App Work)                                                       | `work_app_env_values`                                                                   | encrypted; generated **once**, never rotated implicitly                                                           | APW-07                   | [data-model.md](./data-model.md) §3                                                              |

---

## 6. Names injected into a tenant App Work

These are the only `EVER_WORKS_*` names that ever reach an App Work's pods, plus the repository-side names
APW-05 writes. The platform ConfigMap is **not** secret; the env Secret holds only APW-07's resolved values.

| Name                       | Where                                 | Purpose                                                                                                                      | Secret                    | Source                                                                                |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `EVER_WORKS_APP_URL`       | platform ConfigMap                    | the App Work's published primary URL                                                                                         | no                        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §4.7                                 |
| `EVER_WORKS_APP_HOST`      | platform ConfigMap                    | the published host                                                                                                           | no                        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §4.7                                 |
| `EVER_WORKS_APP_COMMIT`    | platform ConfigMap                    | the commit the running image was built from                                                                                  | no                        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §4.7                                 |
| `EVER_WORKS_SOURCE_URL`    | platform ConfigMap                    | the Source link, injected only when the spec carries a `network-source-offer` obligation                                     | no                        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §4.7                                 |
| `EVER_WORKS_DEPLOYMENT_ID` | **not injected**                      | explicitly excluded — a per-Deployment value cannot live in a checksum-named immutable ConfigMap                             | no                        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §4.7 (GAP entry `APW06-G07`)         |
| `EW_<ENV NAME>`            | the Work Repository's Actions secrets | build-time values for `build.args[].fromEnv`; the platform removes only `EW_` secrets it wrote                               | **yes** (Actions secrets) | [CONTRACTS.md](./CONTRACTS.md) §9                                                     |
| `EW_VERIFY__PROMPTED`      | the Work Repository's Actions secrets | per-verification-run JSON of already-set prompted values; deleted when the run ends; a reserved name an App spec may not use | **yes**                   | [CONTRACTS.md](./CONTRACTS.md) §9 · [`APW-05/plan.md`](./APW-05-builds/plan.md) §4.10 |

---

## 7. Catalog repositories — branches, promotion, tags and per-environment pins

**Owner note (binding, 2026-09-17).** The platform catalog repository **is `ever-works/platforms`, and it
exists**; `EVER_WORKS_PLATFORM_CATALOG_REPO` defaults to it. The Apps catalog listing repository is
`ever-works/templates` (renamed from `ever-works/apps` on 2026-09-17 — the noun "Apps catalog" is unchanged,
[README](./README.md) §1 · D4). Some epic text still says `ever-works/apps`
([`APW-03/plan.md`](./APW-03-app-spec-and-catalog/plan.md):209 · [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T29);
[CONTRACTS.md](./CONTRACTS.md) §7 and §8 are normative and say `ever-works/templates`, and
`EVER_WORKS_APPS_CATALOG_REPO` accepts either name.

### 7.1 Branch and promotion model

Every catalog repository uses the **same one-way promotion** as the platform: work lands on `develop`, is
promoted to `stage`, and production reads `main` ([README](./README.md) §7 rule 6's environment model;
[TRACKER.md](./TRACKER.md) merge order). A catalog change is never cherry-picked onto a later branch, and no
production platform ever pins a mutable branch.

| Repository                                                                                        | Role                                                                                              | Working branch                                     | Promotion                                                                          | Release tag                          | Production reads                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `ever-works/templates`                                                                            | the **Apps catalog listing** (`manifest.json`, `schema/app-spec.schema.json`, `licenses.yml`, CI) | `main`                                             | content PRs reviewed by maintainers; `licenses.yml` review by legal (`CODEOWNERS`) | `vYYYY.MM.DD[.N]`                    | a **tag or 40-char SHA** — a mutable ref logs a warning on every uncached read |
| `ever-works/<app>-template` (e.g. `cal-template`, `umami-template`, `app-fixture-hello-template`) | one **App Blueprint**: `.works/works.yml` + overlay + smoke tests                                 | `main` (required default branch)                   | PR; a **tag `v<version>` must resolve to the `sha` the manifest pins**             | `v<semver>` per Blueprint version    | the pinned `blueprint.sha`                                                     |
| `ever-works/platforms`                                                                            | APW-11's launcher catalog (`platforms.json`, `icons/`, `schema/platforms.schema.json`, CI)        | `main`                                             | PR + `validate.yml`                                                                | `v1.0.0` (first release; APW-11 T18) | a **tag or 40-char SHA**                                                       |
| `ever-works/agents`                                                                               | the agent-template catalog (`manifest.json` — the only path the platform reads today)             | `develop` today (the repository's current default) | PR                                                                                 | **no tags yet**                      | `EVER_WORKS_AGENTS_REF`, **pin per environment**                               |
| `ever-works/skills`                                                                               | Skill catalog (`SKILL.md`)                                                                        | `main`                                             | PR                                                                                 | **no tags yet**                      | the skills catalog ref, **pin per environment**                                |
| `ever-works/missions`                                                                             | Mission template (`build-on-open-source-app`)                                                     | `develop` / `stage` / `main`                       | PR                                                                                 | none stated                          | the ref the seed job reads                                                     |
| `ever-works/app-fixture-hello`                                                                    | the acceptance fixture **application source** (no `.works/`)                                      | `main`                                             | PR                                                                                 | none                                 | pinned by the fixture Blueprint                                                |
| `<e2e-upstream-org>/*` (test)                                                                     | per-run test upstreams, prompt-injection and licence-variant fixtures                             | disposable                                         | generated per run                                                                  | none                                 | never listed in the production catalog                                         |

Sources: [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 (tags, the `e2e` branch) ·
[`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §5 (required Blueprint repository settings) ·
[`APW-03/tasks.md`](./APW-03-app-spec-and-catalog/tasks.md) T33 (T33) ·
[`APW-11/tasks.md`](./APW-11-app-launcher/tasks.md) T18 (T18) ·
[`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T30 (T30) · :419 (T31) ·
[`APW-08/tasks.md`](./APW-08-evolve-loop/tasks.md) T41 (T41) · [CONTRACTS.md](./CONTRACTS.md) §8.

### 7.2 Per-environment refs

| Environment  | `EVER_WORKS_APPS_CATALOG_REF`                                                            | `EVER_WORKS_PLATFORM_CATALOG_REF` | `EVER_WORKS_AGENTS_REF` / skills ref                                   | Source                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `local`      | the working copy or a local commit of the listing                                        | unset → `main`                    | unset → the repository default                                         | §4.1 · [quickstart.md](./quickstart.md) §4                                                                                 |
| `dev`        | **a commit of the listing's `e2e` branch** whose `manifest.json` adds the test upstreams | `main`, **pin recommended**       | **pin** for the environment                                            | [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T29 · [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T33       |
| `stage`      | a commit of the `e2e` branch                                                             | **`v1.0.0`**                      | **pin** for the environment                                            | [`APW-11/tasks.md`](./APW-11-app-launcher/tasks.md) T18                                                                    |
| `production` | **a tag or 40-char SHA of `main`** — never the `e2e` branch                              | **a tag or 40-char SHA**          | **pin**; the pin moves only by a reviewed PR that records what changed | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 · [`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §12 |

**When production moves its pin** (the answer EXT-24 asks for): a maintainer merges the reviewed pull
request that adds the verified Blueprint, and the production `EVER_WORKS_APPS_CATALOG_REF` moves **to the
tagged catalog commit** created by that merge — never to a branch tip
([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §12, step 3). Blueprint verification evidence is written
to `evidence/<blueprint-id>/<runId>.json` only through reviewed pull requests, and the entry's
`verification` object is computed by the catalog repository's own CI
([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §3.1).

### 7.3 Catalog and Blueprint CI settings

| Workflow                         | Repository             | Trigger                         | What it guards                                                                                                                     | Source                                                                                      |
| -------------------------------- | ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `validate.yml`                   | `ever-works/templates` | `pull_request` + push to `main` | C1–C4: manifest schema, ≤ 1,000 entries, launcher/tag pins, Blueprint repository + topic + `v<version>` → `sha`                    | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 · :310                   |
| `schema-sync.yml`                | `ever-works/templates` | weekly                          | opens a PR when the platform's App spec schema changed                                                                             | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2                          |
| `verify-expiry.yml`              | `ever-works/templates` | daily                           | opens an issue 14 days before a verification expires                                                                               | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2                          |
| `CODEOWNERS`                     | `ever-works/templates` | —                               | `licenses.yml` → legal reviewers; `manifest.json` → maintainers                                                                    | [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2                          |
| `validate.yml`                   | `ever-works/platforms` | push / PR                       | platforms catalog schema, ≤ 24 entries, icons ≤ 16 KB                                                                              | [`APW-11/tasks.md`](./APW-11-app-launcher/tasks.md) T18 · [CONTRACTS.md](./CONTRACTS.md) §8 |
| `publish-app-spec-validator.yml` | this monorepo          | on a tag                        | publishes the App-spec validator package with `EVER_WORKS_APP_SPEC_VALIDATOR_VERSION` recorded in the catalog's `package.json` pin | [`APW-03/tasks.md`](./APW-03-app-spec-and-catalog/tasks.md) T33                             |

The catalog repositories' workflow **secrets and settings** (the schema-sync pull-request token, the
verify-expiry issue token) are not yet named in any epic — recorded as an open item in §9 rather than
invented here.

---

## 8. What is deliberately _not_ in this document

- **Values.** No hostname, token, connection string or credential appears here, per README §7 rule 10 and
  [ACCEPTANCE.md](./ACCEPTANCE.md) §0.4.
- **Infrastructure addresses.** Cluster names, regions and node pools live in the private operations
  repository ([README](./README.md) D15).
- **The PostHog project key / API key.** Already documented by the platform's own
  `apps/web/.env.example`; the programme adds no new PostHog variable, only the four flags in §2.

---

## 9. Open items (honest list)

1. **Ever ID's domain.** The identity provider is decided (ZITADEL, self-hosted as-is, OIDC only —
   [README](./README.md) §8 Q6), and `idp-options.md` D2 records `auth.ever.co` as free; the **domain is
   still an open question** and no environment value is stated. `EVER_ID_ISSUER_URL` therefore has **no
   documented default** in any environment (§3).
2. **Catalog CI credentials.** The schema-sync PR token and the verify-expiry issue token are unnamed
   ([`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 describe the workflows; no epic
   names the secret). They belong to the catalog repositories' own GitHub settings, not to this platform's
   environment.
3. **`ever-works/agents` and `ever-works/skills` have no tags**, and `EVER_WORKS_AGENTS_REF` has no stated
   default in [CONTRACTS.md](./CONTRACTS.md) §7 — only APW-04's tasks require a per-environment pin. Until
   the tags exist there is nothing to pin (§7.1).
4. **`ever-works/apps` vs `ever-works/templates`.** [CONTRACTS.md](./CONTRACTS.md) §7/§8 and Resolution
   **R-29** say `ever-works/templates`; [`APW-03/plan.md`](./APW-03-app-spec-and-catalog/plan.md):209,
   [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §2 and
   [`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T29 still say `ever-works/apps`. Recorded, not
   rewritten — the two name the same repository and the env variable accepts either (R-29 makes that
   explicit).
5. **The PostHog project per environment is not named anywhere in the programme.** The flags in §2 are
   listed by name; which PostHog project each environment reads is an operator fact and is not stated.
   `POSTHOG_HOST` is named **only in code** (`work-kinds.ts:47`), never in the spec tree.
6. **The seven R-30 kill switches are not in [CONTRACTS.md](./CONTRACTS.md) §7's table.** R-30 in §0 is their
   normative source, with each switch's ACC; §7 lists only `EVER_WORKS_APP_WORKS_ENABLED`. §3A above names
   them so the inventory is complete in one place, and the §7 rows are in the shared-file request.
7. **`EVER_WORKS_AGENTS_REF`, `EVER_WORKS_APPS_LOCAL_WORKER`, `EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST`,
   the three `EVER_WORKS_APP_RELAY_*` names and `EVER_WORKS_DB_PROVISION_IT_URL`** are introduced by epic
   text but absent from §7's table — same treatment: named in §3, requested for §7.
8. **Nothing in §3 is implemented.** No App Works environment variable is read anywhere in `apps/` or
   `packages/`, and `apps/api/.env.example` carries none, so APW-01's own criterion
   ([`APW-01/tasks.md`](./APW-01-app-work-kind/tasks.md) T7: _"`apps/api/.env.example` contains
   `EVER_WORKS_APP_WORKS_ENABLED=false`"_) is unmet. This document describes the target state, not the
   current one. _(Superseded, 2026-09-26: see the update under §0 — App Works variables are now read in `apps/` and
   `packages/`, and that line of `.env.example` now exists.)_
