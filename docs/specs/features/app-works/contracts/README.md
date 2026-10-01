# App Works — machine-readable API contracts

**Status:** `Draft` · **Created:** 2026-09-17 · **Program:** [App Works](./../README.md)
**Closes:** `SK-07` (no machine-readable API contracts for the ~100 new operations, although MCP tool schemas
are generated from the OpenAPI document)
**Owner:** programme level — every API-owning epic owns its own fragment; the fragments are collected here.
**Companion documents:** [`../CONTRACTS.md`](./../CONTRACTS.md) §4 (the normative route table) ·
[`agent-surfaces.md`](./agent-surfaces.md) (which of these routes agents may call) ·
[`openapi/README.md`](./openapi/README.md) (the fragment convention and per-epic status) ·
[`../data-model.md`](./../data-model.md) · [`../CONFIGURATION.md`](./../CONFIGURATION.md) §1 ·
[`../quickstart.md`](./../quickstart.md) §8

---

## 0. Why fragments exist at all

The real contract in this repository is **generated code-first**: the OpenAPI document is produced from Nest
decorators, and the MCP server turns that document into tool schemas. That is a good pipeline — and it has
one sharp edge the programme depends on:

> **A DTO property without `@ApiProperty` is silently absent from the document, and therefore silently
> absent from every MCP tool's arguments.** Nothing fails; the parameter simply is not offered.

So the fragments under [`openapi/`](./openapi/) are not a second source of truth. They are a **reviewable
expectation** of what the generated document must contain, so a missing decorator, a renamed field or a
dropped status code becomes a red test instead of a quietly missing tool argument.

---

## 1. Where the machine-readable contract comes from today

| Step | What happens                                                                                                   | Where                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Nest controllers and DTOs declare the API; `@ApiProperty` / `@ApiOperation` / `@ApiResponse` decorate them.    | `apps/api/src/**`                                                                                                                                                                                                                                                                           |
| 2    | The document metadata is built once, for both consumers.                                                       | `apps/api/src/openapi/openapi-document.config.ts:10-37` — `buildOpenApiConfig()`, `.setTitle('Ever Works API')`, `.setVersion('1.0')`, `addBearerAuth(…, 'JWT-auth')`                                                                                                                       |
| 3    | The document is emitted **without starting an HTTP listener or touching a database**, under Nest preview mode. | `apps/api/src/openapi/generate-openapi.ts:28-40` — `NestFactory.create(ApiModule, { preview: true })` then `SwaggerModule.createDocument(app, buildOpenApiConfig())`, written to `openapi.json` in the CWD                                                                                  |
| 4    | The npm script.                                                                                                | `apps/api/package.json:19` — `"generate:openapi": "node dist/openapi/generate-openapi.js"` (so: build first, then `pnpm --filter ever-works-api generate:openapi`)                                                                                                                          |
| 5    | The artifact is **never committed**.                                                                           | `.gitignore:80-81` — `# Generated OpenAPI artifact (pnpm generate:openapi) — never commit` / `apps/api/openapi.json`                                                                                                                                                                        |
| 6    | The MCP server reads the document and registers tools.                                                         | `apps/mcp/src/openapi-tools/openapi-loader.service.ts:70-77` — prefers the spec bundled into the image at `EVER_WORKS_OPENAPI_SPEC_PATH`; falls back to fetching the API in local dev. In production the live endpoint is disabled (C-09), so **the bundled file is the only source there** |
| 7    | Tool input schemas are derived from the operation's `requestBody`.                                             | `apps/mcp/src/openapi-tools/schema-converter.service.ts:37-56` — `buildToolParameters(pathParams, queryParams, requestBody)`, which reads `requestBody.required` to decide which properties are optional                                                                                    |
| 8    | Tools are only ever registered for routes on the static whitelist.                                             | `apps/mcp/src/openapi-tools/tool-registration.service.ts:56` (`for (const entry of WHITELIST)`) and `:91-98` (`registry.registerTool(...)`)                                                                                                                                                 |

**Naming and versioning rule (binding).**

- The document is a **single, unversioned** document titled `Ever Works API` with `version: 1.0`
  (`openapi-document.config.ts:12,16`). There is **no** `/v2` path prefix and no per-epic document version.
  API evolution is additive: a route, a field or a status code is added; nothing is removed or narrowed
  (README §7 rule 1, Resolution R-26).
- Consequently the **fragments carry no `info.version` of their own** beyond a pointer to the epic's phase.
  Their job is the route surface, not a release number.
- A fragment file is named after its **owning epic**: `apw-01.openapi.yaml`, `apw-02.openapi.yaml`, … — one
  file per API-owning epic. A fragment never contains a route owned by another epic; a route an epic only
  _extends_ (for example APW-06's kind-`app` branch on the existing `POST /api/deploy/works/:id`) belongs to
  the extending epic's fragment and is marked `x-extends-existing: true`.

---

## 2. The superset rule

> **The generated `apps/api/openapi.json` MUST be a superset of every fragment.** Every `path` + `method` in
> a fragment must exist in the generated document; every property a fragment marks `required` must be
> required there; every status code a fragment lists must be declared there.

The comparison is **one-directional on purpose.** The generated document will always contain far more than
the fragments (127 whitelisted MCP tools, every pre-existing Works/Tasks/Goals route, whole subsystems the
programme never touches). A fragment that demanded equality would be unusable. What the fragments catch is
**loss**: a route the plan promised that never got a controller, a field whose `@ApiProperty` is missing, a
`202` that became a `200`.

**Enforcement (one task, APW-13 P0).** `apps/api/src/openapi/__tests__/app-works-contract.spec.ts` —
Jest, beside the generator — loads every fragment, loads the generated document, and asserts method + path +
required properties + declared status codes per operation. It is the reason this directory has tests at all;
without it a fragment is a document nobody reads.

**Linting.** `@apidevtools/swagger-parser` is **already a dependency of `apps/mcp`**
(`apps/mcp/package.json:25`, `"@apidevtools/swagger-parser": "^12.1.0"`) and already used at runtime
(`apps/mcp/src/openapi-tools/openapi-loader.service.ts:5`). The fragment lint reuses it — no new dependency
is introduced. **Not found:** Redocly, Spectral or any other OpenAPI linter in this repository.

---

## 3. Route families per epic

Owned routes are the epic's; a row marked _extends_ touches a route another epic (or the existing platform)
owns. Every path below is a **literal** path — where
[`../CONTRACTS.md`](./../CONTRACTS.md) §4 abbreviates a row with `…` (rows for APW-08, APW-09 and APW-10),
the literal path is expanded here from the epic's own plan and marked `*` in the Status column.

| Epic       | Route family                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                                                                       | Fragment                                                       | Grounded at                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **APW-01** | `POST /api/works/app-source/inspect` (200, JWT, throttle 30/60 s) · `POST /api/works` **extended** with `kind: 'app'`, `repositoryUrl`, `repositoryMode`, `targetOwner`, `blueprintId`, `appEnv` · `delete_stored_data` + `confirm_slug` on the existing `POST /api/works/:id/delete`                                                                                                                                                                                                                                                                           | **Grounded** — request fields, status codes and error codes are written out                  | [`openapi/apw-01.openapi.yaml`](./openapi/apw-01.openapi.yaml) | [`../APW-01-app-work-kind/plan.md`](./../APW-01-app-work-kind/plan.md) §4.1–§4.3                |
| **APW-02** | `GET /api/works/:id/upstream` · `POST /api/works/:id/upstream/sync` (202) · `POST /api/works/:id/upstream/readiness/retry` (202)                                                                                                                                                                                                                                                                                                                                                                                                                                | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-02-fork-lifecycle/plan.md`](./../APW-02-fork-lifecycle/plan.md) §4.1                   |
| **APW-03** | `GET /api/apps-catalog` · `GET /api/apps-catalog/:id` (public, cached) · `GET /api/apps-catalog/licenses` · `GET /api/schema/app-spec.schema.json` (public) · `GET`/`POST /api/works/:id/app-spec`, `/app-spec/validate` · `POST …/app-spec/blueprint`, `/blueprint/upgrade` (202), `/blueprint/dismiss` · `POST /api/works/:id/app-license/attest`                                                                                                                                                                                                             | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-03-app-spec-and-catalog/plan.md`](./../APW-03-app-spec-and-catalog/plan.md) §4.1       |
| **APW-04** | `POST /api/works/:id/provision` (202) · `GET /api/works/:id/provisioning` · `POST …/provision/cancel` (202) · `POST …/provisioning/:provisioningId/blueprint-suggestion` (202) · `GET /api/admin/app-blueprint-suggestions` + `…/:provisioningId/bundle` (platform admin)                                                                                                                                                                                                                                                                                       | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-04-app-provisioner/plan.md`](./../APW-04-app-provisioner/plan.md) §4                   |
| **APW-05** | `GET /api/works/:id/builds` · `GET …/builds/:buildId` · `POST …/builds` (202) · `POST …/builds/:buildId/cancel` (202) · **`PUT /api/works/:id/builds/pull-token`** `*` · build settings through the existing `PATCH /api/works/:workId/plugins/:pluginId/settings`                                                                                                                                                                                                                                                                                              | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-05-builds/plan.md`](./../APW-05-builds/plan.md) §5                                     |
| **APW-06** | `GET /api/works/:id/app-status` · `POST …/app-status/refresh` (202) · `POST …/app-jobs/:name/run` (202) · `POST …/app-smoke` (202) · `POST …/app-rollback` (202) · `POST …/app-lifecycle` (202; `pause`\|`resume`\|`remove`\|`cancel-deploy`) · `POST …/app-logs` (202) + `GET …/app-logs/:requestId` · `GET`\|`PUT …/app-target` · `POST …/app-target/check` (202) · `GET …/app-deletion-preview` · **`GET /api/deploy/works/:id/deployments`** `*` · kind-`app` branches on the existing `POST /api/deploy/works/:id`, `/rollback`, `/domains*`, `/subdomain` | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-06-app-runtime/plan.md`](./../APW-06-app-runtime/plan.md) §9.1                         |
| **APW-07** | `GET`/`PUT /api/works/:id/app-env` · `POST …/app-env/:name/rotate` · `GET …/app-dependencies` · `PUT …/app-dependencies/:kind` (202) · `POST …/app-dependencies/:kind/provision` (202) · `DELETE …/app-dependencies/:kind` (**JSON body `{ confirmSlug }`**, 202) · **`PUT /api/deploy/works/:id/runtime-env`** `*`                                                                                                                                                                                                                                             | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-07-app-env-and-dependencies/plan.md`](./../APW-07-app-env-and-dependencies/plan.md) §5 |
| **APW-08** | `POST /api/works/:id/evolve` (202) · `GET /api/tasks/:id/delivery` · `POST …/delivery/close` · `POST …/delivery/follow-up` (202) · `GET /api/tasks/:id/cost` · delivery fields on `GET /api/tasks` · `workId` on `POST`/`PATCH /api/me/goals` · `outputMode`, `taskOutput` on `PATCH /api/me/missions/:id` · `templateInputs` on `POST /api/me/missions`                                                                                                                                                                                                        | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-08-evolve-loop/plan.md`](./../APW-08-evolve-loop/plan.md) §4                           |
| **APW-09** | `GET`/`POST /api/works/:id/upstream-pull-requests` · `GET …/upstream-pull-requests/eligibility?taskId` `*` · `GET …/:prId` `*` · `POST …/:prId/signed` (202) `*` · `POST …/:prId/withdraw` `*` · `POST …/:prId/check` `*` · `POST …/:prId/address-review` (202) `*` · `POST …/suggestions/:taskId/dismiss` `*`                                                                                                                                                                                                                                                  | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-09-upstream-pull-requests/plan.md`](./../APW-09-upstream-pull-requests/plan.md) §5     |
| **APW-10** | operator routes `api/admin/apps-tier/*` (platform admin, **404 otherwise**) · `GET /api/me/apps-tier` · `GET /api/works/:id/apps-tier`                                                                                                                                                                                                                                                                                                                                                                                                                          | Route family named, members **not** enumerated in CONTRACTS                                  | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-10-apps-hosting-tier/plan.md`](./../APW-10-apps-hosting-tier/plan.md) §6.1–§6.3        |
| **APW-11** | `GET /api/me/apps` · `PUT /api/me/apps/preferences` · `GET /api/app-launcher/platforms` (public, `Cache-Control: max-age=3600`) · `appLauncherExposed` on the existing `PUT`/`PATCH /api/works/:id`                                                                                                                                                                                                                                                                                                                                                             | Route named; schema to be derived                                                            | [`openapi/README.md`](./openapi/README.md) §2                  | [`../APW-11-app-launcher/plan.md`](./../APW-11-app-launcher/plan.md) §4                         |
| **APW-12** | `@Controller('api/auth/ever-id')`: `POST /api/auth/ever-id/authorize`, `/callback`, `/sign-up/confirm`, `/connect/authorize`, `/connect/confirm`, `GET /identities`, `DELETE /identities/:id`, `GET /logout-url`, `POST /backchannel-logout`, `POST /session`, `GET /client-config`, `POST /admin/test`, `GET /admin/health` · `GET /api/auth/providers` **extended** with `everId`                                                                                                                                                                             | **Grounded** — the plan writes method, path, auth, throttle and request → response per route | [`openapi/apw-12.openapi.yaml`](./openapi/apw-12.openapi.yaml) | [`../APW-12-ever-id/plan.md`](./../APW-12-ever-id/plan.md) §5.1–§5.2                            |
| **APW-13** | none of its own — it consumes the above from the harness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                            | —                                                              | [`../APW-13-golden-paths/plan.md`](./../APW-13-golden-paths/plan.md)                            |

`*` = the literal path is **not** written as a route string in [`../CONTRACTS.md`](./../CONTRACTS.md) §4. Six
routes named by an epic plan are missing from §4 (or abbreviated there with `…`); they are listed in §5 below
so the lead can fold them in rather than have a fragment cite a route the contract file does not carry.

---

## 4. Cross-cutting rules every fragment must express

| Rule                                                    | What the fragment carries                                                                                                                                                                                                                                                                                           | Authority                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Dispatch returns `202`**                              | a `202` response, never a `200` with a body that implies completion                                                                                                                                                                                                                                                 | README §7 rule 5 (background work through the job-runtime provider) · [`../CONTRACTS.md`](./../CONTRACTS.md) §5    |
| **Admin routes answer `404`, not `403`**                | `404` documented for a non-platform-admin caller                                                                                                                                                                                                                                                                    | [`../CONTRACTS.md`](./../CONTRACTS.md) §4 (APW-04, APW-10 rows)                                                    |
| **Public + cache**                                      | `GET /api/apps-catalog*`, `GET /api/app-launcher/platforms`, `GET /api/schema/app-spec.schema.json` are public with an explicit `Cache-Control`                                                                                                                                                                     | [`../CONTRACTS.md`](./../CONTRACTS.md) §4                                                                          |
| **Delegated read**                                      | only handlers marked `@DelegatedRead(scope)` admit an Ever ID delegated token; today that is `GET /api/me/apps` with scope `apps:read`                                                                                                                                                                              | Resolution R-19 · [`../APW-12-ever-id/plan.md`](./../APW-12-ever-id/plan.md) §5.3                                  |
| **Delete is `POST …/delete`, not `DELETE` with a body** | the house pattern for deletes is the existing `POST /api/works/:id/delete`; a confirmation field travels in the body there. APW-07's `DELETE /api/works/:id/app-dependencies/:kind` with `{ confirmSlug }` is the **one** deviation planned — record it, do not silently "fix" it                                   | existing platform pattern · [`../CONTRACTS.md`](./../CONTRACTS.md) §4 (APW-07 row) · see §6                        |
| **Human-only actions carry a guard `403`**              | a route that spends money, deletes data, publishes outside the platform, changes a security posture or accepts a legal obligation documents the `403` its `@HumanOnly()` guard answers to a non-session caller                                                                                                      | Resolution **R-32** ([`../CONTRACTS.md`](./../CONTRACTS.md):75) · [`agent-surfaces.md`](./agent-surfaces.md) §1    |
| **Response envelopes**                                  | `AppsCatalogListResponse` (`{ data, meta }`), `AppLauncherListResponse` (`{ items, meta }`), APW-07's `GET app-env` (`{ entries, summary }`), APW-09's list (`{ data, meta: { total } }`), APW-01's create (`{ status, work, appSource }`) and the shared error body `{ status: 'error', code, message, details? }` | [`../APW-01-app-work-kind/plan.md`](./../APW-01-app-work-kind/plan.md) §4.2 · APW-03/07/09/11 plans                |
| **Secret values never appear**                          | a request field that carries a value is `writeOnly: true` and never echoed; a read response returns names, origins and `set`/`unset` only                                                                                                                                                                           | README §7 rule 8 · [`../APW-07-app-env-and-dependencies/plan.md`](./../APW-07-app-env-and-dependencies/plan.md) §5 |
| **`x-mcp` on every operation**                          | `not-exposed`, or the tool name plus `readOnlyHint`/`destructiveHint`/`omitArgs`                                                                                                                                                                                                                                    | [`agent-surfaces.md`](./agent-surfaces.md) §3                                                                      |

---

## 5. Six routes the fragment set needs that `CONTRACTS.md` §4 does not carry literally

Reported for the lead; nothing here is invented — each is quoted from an epic plan.

| Route                                           | Owner  | Where the plan names it                                                                         | Why §4 does not carry it                                 |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `PUT /api/works/:id/builds/pull-token`          | APW-05 | [`../APW-05-builds/plan.md`](./../APW-05-builds/plan.md) §5                                     | absent from §4                                           |
| `GET /api/deploy/works/:id/deployments`         | APW-06 | [`../APW-06-app-runtime/plan.md`](./../APW-06-app-runtime/plan.md) §1/§9.1                      | absent from §4                                           |
| `PUT /api/deploy/works/:id/runtime-env`         | APW-07 | [`../APW-07-app-env-and-dependencies/plan.md`](./../APW-07-app-env-and-dependencies/plan.md) §1 | absent from §4                                           |
| `POST /api/agents/:id/assign-task`              | APW-08 | [`../APW-08-evolve-loop/plan.md`](./../APW-08-evolve-loop/plan.md) §1 (chat row)                | absent from §4 (pre-existing platform route, referenced) |
| `POST /api/agent-approvals/:id/approve\|reject` | APW-09 | [`../APW-09-upstream-pull-requests/plan.md`](./../APW-09-upstream-pull-requests/plan.md) §6     | absent from §4 (pre-existing platform route, referenced) |
| `POST /api/users/me/scope`                      | APW-11 | [`../APW-11-app-launcher/plan.md`](./../APW-11-app-launcher/plan.md) §1                         | absent from §4 (existing substrate route, quoted)        |

**One contradiction to settle.** [`../CONTRACTS.md`](./../CONTRACTS.md) §4 calls
`POST /api/works/:id/deploy` "the existing deploy route"; the real existing route is
`POST /api/deploy/works/:id` (`deploy.controller.ts:79` `@Controller('api/deploy')` + `:226`
`@Post('/works/:id')`), and [`../APW-06-app-runtime/plan.md`](./../APW-06-app-runtime/plan.md) §"Known gaps
carried forward" says so explicitly — _"CONTRACTS §4 calls `POST /api/works/:id/deploy` "existing"; the
existing route is `POST /api/deploy/works/:id`."_ The fragments use the real path. §4's wording needs the
lead's correction.

**Three §4 rows abbreviate their route strings with `…` or `*`** — the APW-08, APW-09 and APW-10 rows. A
fragment cannot be generated from an ellipsis; §3 above expands them from the owning plans. The lead should
either expand §4 or accept §3 as the expansion.

---

## 6. The `DELETE`-with-body question

[`../CONTRACTS.md`](./../CONTRACTS.md) §4's APW-07 row specifies
`DELETE /api/works/:id/app-dependencies/:kind` with a JSON body `{ confirmSlug }` and a `202`. The house
pattern for a destructive Work-scoped operation is `POST /api/works/:id/delete` with the confirmation in the
body (APW-01 §4.3 adds `delete_stored_data` and `confirm_slug` there).

This document does **not** change APW-07's route — that decision belongs to APW-07 and the lead, and changing
it would be a specification change made by a contracts document. What it does do is **record the deviation**
so a reviewer sees it:

- `DELETE` with a request body is legal in OpenAPI 3.1 but is **not** universally implemented by clients and
  proxies (some drop the body silently, which would turn a typed confirmation into a no-op and defeat the
  guard the field exists for).
- A fragment for APW-07 must therefore mark the operation `x-body-on-delete: true` and the
  `contracts/openapi/README.md` §2 row stays "schema to be derived" until APW-07 decides.
- If the lead prefers the house pattern, the change is **additive**: keep `DELETE …/:kind` and add
  `POST /api/works/:id/app-dependencies/:kind/delete` with the same body — nothing is removed.

---

## 7. What is deliberately not here

- **No committed generated document.** `apps/api/openapi.json` is git-ignored on purpose; the fragments are
  the reviewable part.
- **No request/response schema for a route whose plan does not write one.** A fragment that guessed a field
  name would be worse than no fragment: it would become the contract by accident. Those routes are listed in
  [`openapi/README.md`](./openapi/README.md) §2 as "route named at `file:line`, schema to be derived".
- **No second source of truth for the App spec.** The `.works/works.yml` schema is APW-03's
  (`../APW-03-app-spec-and-catalog/schema.md`), not an OpenAPI schema.
