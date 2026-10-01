# App Works — agent surfaces (MCP · chat · CLI)

**Status:** `Draft` · **Created:** 2026-09-17 · **Updated:** 2026-09-17 (aligned with Resolution **R-32**)
**Closes:** `SK-09` (the program never decides which App Works routes agents may call through MCP, chat or
the CLI)
**Owner:** programme level. Each exposing epic owns the whitelist entry, the chat tool, the `@HumanOnly()`
guard and the test that pins them; this document owns the **decision rule** and the classification.
**Companion documents:** [`../CONTRACTS.md`](./../CONTRACTS.md) §0 **R-32** (human-only actions — binding) and
§4 (the normative route table) · [`README.md`](./README.md) (the OpenAPI fragments and their `x-mcp` fields) ·
[`../CONFIGURATION.md`](./../CONFIGURATION.md) · [`../data-model.md`](./../data-model.md)

---

## 0. Why this document exists, and what changed

Three different surfaces let a machine call this API, and until now the programme decided nothing about any
of them:

| Surface                      | Mechanism today                                                          | Scale today                                                             |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **MCP**                      | a **static whitelist** in code; a tool exists only if the route is on it | **127 entries**, **zero** App Works entries                             |
| **Chat** (the web assistant) | a separate, manifest-driven registry                                     | ~335 raw entries across four registry files, **zero** App Works entries |
| **CLI**                      | `apps/cli` (commander) and `apps/internal-cli` (nest-commander)          | **zero** App Works commands                                             |

The gap that made this urgent is not any single route — it is that **`deploy_work` already exists** and
APW-06 extends `POST /api/deploy/works/:id` with a kind-`app` branch
([`../CONTRACTS.md`](./../CONTRACTS.md) §4). Without a decision, deploying an App Work — including onto the
**managed** tier, which spends real compute — would silently become agent-callable the day APW-06 merges.

**Resolution R-32 now decides most of it**, and this document defers to it rather than inventing a parallel
rule:

> **R-32 — Human-only actions.** Every action that **spends money**, **deletes data**, **publishes outside
> the platform**, **changes a security posture** or **accepts a legal obligation** is bound to an
> **interactive session** through `@HumanOnly()` (`apps/api/src/safety/guards/human-actor.guard.ts`, which
> admits only `authMethod === 'session'` and records refusals) **and** listed in the §4 human-only column.
> API keys, Fleet run tokens and Ever ID delegated tokens are refused with `403` and the existing
> non-human-actor body. A typed confirmation (`confirmSlug`) is an extra field, never a substitute for the
> guard. **The MCP whitelist omits human-only routes.** — [`../CONTRACTS.md`](./../CONTRACTS.md) §0, R-32

**Nothing in this document removes an existing surface.** Resolution R-26 (additive-only, top priority): the
127 existing MCP entries, the eight hand-written MCP tools and every existing chat tool stay exactly as they
are. This document adds decisions about App Works routes only — and, where R-32 and R-26 meet, it says so
instead of quietly picking a winner (§3.3).

---

## 1. The decision rule

> **A route is callable by an agent on a surface only when it passes every test below.** A route that fails
> any test is `not exposed` on that surface, and the reason is recorded in §3 — never left blank, never
> "TBD".

**T1 — R-32's five classes are human-only.** Does the route spend money, delete data, publish outside the
platform, change a security posture, or accept a legal obligation? If yes it is `@HumanOnly()`, it is listed
in the §4 human-only column, and **the MCP whitelist omits it**. Concretely for App Works: builds (runner
minutes), provisioning (model tokens), managed deploys (compute), dependency release (data), upstream-PR
proposal and withdrawal (publishing outside the platform), licence attestation and CLA/DCO signature (legal),
env / target / kubeconfig writes (security posture).

**T2 — It carries no secret value in either direction.** Neither the request nor the response may transport
a secret: an env value, a dotenv import, a kubeconfig, a Git or registry token, a dependency connection
output, a keypair half. A route that returns _names_, _origins_ and _set/unset_ is a read and passes; a
route that accepts a value is refused even though the platform would encrypt it.

**T3 — It destroys nothing that cannot be regenerated.** Deleting stored data, volumes, dependency data, a
repository, or a published pull request is a person's act. (This is T1's "deletes data" class, stated
separately because it also governs routes whose monetary cost is nothing.) Stopping or restarting something
is not destruction.

**T4 — The API already scopes it to the caller.** The route is owner-scoped by the API itself, or is public
by design. A route the API admits only on `authMethod === 'session'`, or only for a platform admin (which
answers `404` otherwise), cannot be reached by an MCP caller holding an API key **even if it were
whitelisted** — so it is `not exposed` and the reason is the API's own gate, not a second one we invent.

**T5 — A read is always allowed.** A read passes T1–T4 unless the response carries a secret (T2) or the route
is admin-only / session-only (T4). Reads are exposed with `readOnlyHint: true`.

**Corollaries.**

- **Human-only is a property of the route, not of the caller.** R-32's guard refuses an API key _and_ a
  delegated token _and_ a Fleet token. An MCP caller is one of those, so "human-only" and "not on the MCP
  whitelist" are the same statement. R-32 says it in one line; §3 applies it per route.
- **A `403` is not a substitute for a decision.** A route that would fail T1 but happens to refuse a bare
  MCP call today may start accepting it after any unrelated change. The whitelist is the decision, and the
  guard is the enforcement.
- **A route that reads and then writes is classified by its write.** `POST /api/works/app-source/inspect` is
  a `POST` that persists nothing and writes nothing to a provider; it is a read (D-C).
- **The §4 human-only column is normative.** R-32 requires it, and the column does not exist yet in
  [`../CONTRACTS.md`](./../CONTRACTS.md) §4 (its header is `| Route | Owner |`). §6.1 below supplies it as
  literal markdown so it can be pasted in additively.

---

## 2. The mechanisms, as they actually are

### 2.1 MCP — a static whitelist, enforced by construction

| Fact                                                                                                                                                                                                 | Evidence                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| An entry is `{ method, path, toolName?, description?, annotations?{readOnlyHint,destructiveHint}, omitArgs? }`                                                                                       | `apps/mcp/src/openapi-tools/whitelist.ts:1-21`                                                                                                      |
| `omitArgs` exists to cut a human-only **flag** out of a tool that stays useful without it; the comment names `force` on a Task transition and `requireAllApprovers` on a Task create/update          | `whitelist.ts:10-19`                                                                                                                                |
| The tool set is exactly the whitelist: the registration loop iterates `WHITELIST` and nothing else                                                                                                   | `apps/mcp/src/openapi-tools/tool-registration.service.ts:9` · `:56` · `:91-98`                                                                      |
| **There is no "refuse the route" branch.** A route absent from the whitelist never becomes a tool, so it is unreachable over MCP. The only skip path is "the route is not in the generated document" | `tool-registration.service.ts:59`                                                                                                                   |
| Matching is exact method + path, with every `{param}` collapsed to `{*}`                                                                                                                             | `tool-registration.service.ts:185-192`                                                                                                              |
| Tool arguments are generated from the OpenAPI operation's `requestBody`; the document is **OpenAPI 3.0**, so nullability is the 3.0 `nullable: true` spelling the converter reads                    | `apps/mcp/src/openapi-tools/schema-converter.service.ts:20,37-56,71`                                                                                |
| A route missing from the spec is skipped with a warning — pinned by a test                                                                                                                           | `apps/mcp/test/tool-registration.spec.ts:114-121`                                                                                                   |
| Human-gate routes are deliberately excluded and the exclusion is pinned                                                                                                                              | `whitelist.ts:291-310` (comment) · `whitelist.ts:302-304` (the excluded routes) · `apps/mcp/test/whitelist-tasks-inbox-goals-fleet.spec.ts:281-286` |
| The whitelist's own README heading states the entry count and a test asserts it                                                                                                                      | `apps/mcp/README.md:85` · `whitelist-tasks-inbox-goals-fleet.spec.ts:264-268`                                                                       |
| The tool surface is **not** exclusively whitelist-driven: eight hand-written tools bypass it                                                                                                         | `apps/mcp/src/ping.tool.ts:8`, `register-work.tool.ts:49`, `tools/kb/{list,get,create,update,lock,unlock}.ts`                                       |

**Existing MCP routes that already touch App Works objects** (unchanged by this programme; listed because
their behaviour changes when a kind-`app` branch lands):

| Route                                                              | Tool                                      | Whitelist line         | What changes for an App Work                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/works`                                                  | `create_work`                             | `whitelist.ts:39`      | gains `kind: 'app'`, `repositoryUrl`, `repositoryMode`, `targetOwner`, `blueprintId`, `appEnv` — **automatically**, because the tool schema is generated from `CreateWorkDto` (APW-01 §4.5). No whitelist change needed |
| `POST /api/works/:id/delete`                                       | `delete_work` (`destructiveHint: true`)   | `whitelist.ts:47-52`   | gains `omitArgs: ['delete_stored_data', 'confirm_slug']` — an agent cannot destroy stored data through MCP, and the server-side `confirm_slug` rule makes the flag unusable there anyway (APW-01 §4.5; R-15, R-32)      |
| `POST /api/deploy/works/:id`                                       | `deploy_work`                             | `whitelist.ts:99`      | APW-06 adds a kind-`app` branch — **the one case where R-32 and R-26 collide; see §3.3**                                                                                                                                |
| `GET /api/works` · `GET /api/works/{id}` · `PUT /api/works/{id}`   | `list_works` · `get_work` · `update_work` | `whitelist.ts:33-46`   | `PUT` gains the optional `appLauncherExposed` field (APW-11); no whitelist change                                                                                                                                       |
| `GET /api/deploy/works/{id}/domains` · `GET /api/deploy/providers` | `list_domains` · `list_deploy_providers`  | `whitelist.ts:100-111` | unchanged; APW-06 adds a kind-`app` branch to `/domains*`                                                                                                                                                               |

### 2.2 The human-only gate the API applies on its own

`@HumanOnly()` + `HumanActorGuard` **is** R-32's mechanism, and it is worth understanding precisely:

- The decorator sets `HUMAN_ONLY_KEY = 'safety:humanOnly'`
  (`apps/api/src/safety/decorators/human-only.decorator.ts:4,20`).
- The guard returns `true` for anything not marked; for a marked handler it admits only
  `request.user.authMethod === 'session'` and otherwise **fails closed** — including when no stamp is present
  at all ("the safe reading of 'I cannot tell whether this is a person' is NOT a person",
  `apps/api/src/safety/guards/human-actor.guard.ts:20-26,45-56`).
- The refusal is **recorded** as a `rail_refusals` row with reason `non-human-actor`, not just logged
  (`human-actor.guard.ts:58-79`).
- `authMethod` is `'session' | 'api-key'` today
  (`apps/api/src/auth/types/auth.types.ts:64`); APW-12 appends `'ever-id-delegated'` and nothing else (R-19).
  Because the guard admits only `'session'`, it refuses a delegated token with no change to itself
  ([`../APW-12-ever-id/plan.md`](./../APW-12-ever-id/plan.md) §5.3).
- **It covers exactly two handlers today**, both on `/api/safety/ladder`
  (`apps/api/src/safety/safety.controller.ts:173-174` and `:208-209`). No Works, deploy, build, env or
  approval route carries it. App Works must add it — that is the task R-32 creates for every API-owning epic
  (§6.2).
- The guard is **provided, not global** (`apps/api/src/safety/safety.module.ts:18-20,29`), so a new App Works
  controller must provide it or import `SafetyModule`.

**What R-32 changes for the plan.** Before it, "not on the MCP whitelist" was the only protection an App
Works route had. After it, the protection is the guard and the whitelist omission is the _consequence_ —
which is strictly stronger: a route marked `@HumanOnly()` is refused on **every** non-session credential path
(API key, Fleet token, delegated token, an agent run, the CLI), not only on MCP.

### 2.3 Chat — a separate registry, and a separate agent tool loop

The chat surface is **not** the MCP whitelist and must be decided separately:

- `apps/web/src/lib/ai/tools/generated/registry.ts:11-12` says it plainly: _"This mirrors the MCP server's
  `apps/mcp/src/openapi-tools/whitelist.ts` curation model, but emits web-chat tools instead of MCP tools."_
- An entry is an `OperationSpec` (`registry.ts:47-66`) and carries a `requiresConfirmation` flag.
- The live tool set is `buildChatTools()` = generated tools + canvas tools + report tools + hand-written
  domain tools (`apps/web/src/lib/ai/tools/index.ts:92-98`); hand-written tools win name collisions
  (`index.ts:89-90`).
- **Agents' own tool loop is a third surface**: `AgentToolService.resolveAllowedTools()` is the single
  assembly point (`packages/agent/src/agents/agent-tool.service.ts:681`), fed by the
  `AGENT_DOMAIN_TOOL_SOURCES` injection seam
  (`packages/agent/src/agents/agent-domain-tool-sources.ts:24-28,51`), bound in
  `apps/api/src/agents/agents.module.ts:911`.
- **Chat is not exempt from R-32.** A chat tool runs with the signed-in person's session, so a human-only
  route is legitimately reachable from chat — that is the point of the guard. What chat must **not** do is
  answer the gate on the person's behalf: the tool starts the flow and the person completes it in the UI
  (`requiresConfirmation: true` for create, deploy, provision and Blueprint apply).
- Today there is **no** App Works chat tool at all. APW-08 already names the file it will touch
  ([`../APW-08-evolve-loop/plan.md`](./../APW-08-evolve-loop/plan.md) §1's chat row).

### 2.4 CLI — no App Works command, and R-6 is enforced server-side

`apps/cli` has a two-level commander registry (`apps/cli/src/main.ts:23-26`,
`apps/cli/src/commands/work/index.ts:16-30`: create, list, generate, update, submit-item, remove-item,
regenerate-markdown, update-website, deploy, delete, status, plugins, register) and every route it calls is
centralised in `apps/cli/src/services/api.service.ts`. `apps/internal-cli` has its own nest-commander
registry (`apps/internal-cli/src/commands/work/work.command.ts:13-27`).

**No App Works verb exists in either.** That is **correct by design**, not an omission: R-6 makes the server
the gate. APW-01 §4.2's flow diagram shows the refusal reaching every client — _"no (every client: web, chat,
MCP, CLI)"_ → `400 app_works_disabled` — and APW-01 §4.4 says the MCP server and the command-line client
**"are all refused identically"**, because `work create` calls the same `POST /api/works`.

**R-32 applies to a future CLI command too**: the CLI authenticates with a **token**, not a browser session,
so every human-only route is `403` from the CLI by construction. A CLI command for a human-only action would
have to open a browser session — which is exactly R-32's intent. The only CLI work the programme plans is
**Ever ID device sign-in** (`apps/cli/src/commands/auth/` gains `--ever-id` and an
`ever-id-device.service.ts`, [`../APW-12-ever-id/plan.md`](./../APW-12-ever-id/plan.md) §7) — an
authentication flow, not an App Works command.

---

## 3. The classification

`MCP` = the decision, which under R-32 is `not exposed — human-only (R-32)` for every T1 route. `Chat` =
whether a web-chat tool is planned (a human-only route may have one: the person's session satisfies the
guard). `CLI` = whether a command is planned (none is; a token cannot satisfy `@HumanOnly()`).

**Every `not exposed` is a decision, not a default**: a reviewer can diff this table against the whitelist,
the chat registry and each controller's `@HumanOnly()` decorators.

### 3.1 The explicit decisions the gap register asked for

**D-A. `deploy_work` (`POST /api/deploy/works/:id`) with the kind-`app` branch — a collision between R-32 and
R-26, recorded rather than resolved unilaterally.**

- A deploy **spends money** (managed-tier compute) — squarely R-32's first class. R-32's consequence is
  explicit: _"The MCP whitelist omits human-only routes."_
- But `deploy_work` **exists today** (`whitelist.ts:99`) and is exposed; removing it would be a removal of
  existing behaviour, which R-26 and README §7 rule 1 forbid.
- **Recommended reading, adopted in §3.2 and flagged for the lead in §3.3:** the route is human-only **for
  the managed target** and the MCP entry stays. Two things make that safe rather than a loophole: (a) the
  managed target is gated by the API itself — `AppsTierPolicy.isOpen()`, an **opened** tier against a
  self-check under 24 h old, the per-Work quota profile (R-5, R-31) and a receipt (README §7 rule 12) — so an
  MCP caller gets exactly the gate a web caller gets; and (b) in Wave 1 the managed target does not exist at
  all, so `deploy_work` on an App Work can only reach **Your cluster** or **None**.
- **What is added:** APW-06 marks the route human-only in §4's column, applies `@HumanOnly()` to the
  managed-target branch (not to the whole handler, so the existing website deploy is unchanged), and **pins it
  with a test**: a managed-target MCP deploy with the tier **Closed** is refused with the same code the web
  gets.

**D-B. `delete_work` — an agent cannot destroy stored data.** `omitArgs: ['delete_stored_data',
'confirm_slug']` (APW-01 §4.5). R-32 is explicit that _"a typed confirmation (`confirmSlug`) is an extra
field, never a substitute for the guard"_ — so the route is human-only in §4's column **and** the tool omits
both flags.

**D-C. `inspect_app_source` — the one new MCP tool.** `{ method: 'POST', path:
'/api/works/app-source/inspect', toolName: 'inspect_app_source', annotations: { readOnlyHint: true } }`
(APW-01 §4.5). It is a `POST` that is nonetheless a **read**: nothing is persisted and no provider write
happens (T5).

**D-D. `apps/mcp/test/whitelist-app-works.spec.ts` does not exist yet.** It is a deliverable of APW-01 T19
([`../APW-01-app-work-kind/tasks.md`](./../APW-01-app-work-kind/tasks.md) T19) and is named by ACC-01-14.
Until it lands, nothing pins the App Works MCP surface.

### 3.2 The route table

| Route (owner)                                                                                                                                                 | MCP                                                                                                                                                                                                                         | Chat                                  | CLI                                                                                              | Rule                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/works` — kind `app` create (**APW-01**)                                                                                                            | **exposed**, existing tool `create_work`; new fields arrive automatically from the DTO                                                                                                                                      | planned, `requiresConfirmation: true` | none planned — and refused identically by the API gate (R-6)                                     | T5 (a create spends nothing, deletes nothing, publishes nothing)                                                                                                  |
| `POST /api/works/app-source/inspect` (**APW-01**)                                                                                                             | **exposed**, new tool `inspect_app_source`, `readOnlyHint: true`                                                                                                                                                            | planned                               | none planned                                                                                     | T5 (D-C)                                                                                                                                                          |
| `POST /api/works/:id/delete` — `delete_stored_data` / `confirm_slug` (**APW-01**)                                                                             | **not exposed — human-only (R-32)**; the existing `delete_work` entry stays and gains `omitArgs: ['delete_stored_data','confirm_slug']`                                                                                     | planned, with the typed slug          | none                                                                                             | T1 (deletes data) + T3 (D-B)                                                                                                                                      |
| `GET /api/works/:id/upstream` (**APW-02**)                                                                                                                    | **exposed** read-only — new tool (`get_app_upstream`)                                                                                                                                                                       | planned (Upstream tab)                | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/upstream/sync` (202) (**APW-02**)                                                                                                        | **exposed** — writes to the user's **own** fork, bounded by the `EVER_WORKS_APP_SYNC_ENABLED` kill switch (R-30) and the per-hour manual-sync cap (R-31)                                                                    | planned                               | none                                                                                             | T5: a fork sync is not "publishing outside the platform" (that is an upstream PR, below). **Borderline — the epic states the call.**                              |
| `POST /api/works/:id/upstream/readiness/retry` (202) (**APW-02**)                                                                                             | **exposed** — the "Try again" of a timed-out prepare; ≤ 3 manual retries per rolling hour (FR-19)                                                                                                                           | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/apps-catalog`, `GET /api/apps-catalog/:id`, `GET /api/apps-catalog/licenses` (**APW-03**)                                                           | **exposed** read-only — public, cached, no owner scope needed                                                                                                                                                               | planned                               | none                                                                                             | T5 (public by design)                                                                                                                                             |
| `GET /api/schema/app-spec.schema.json` (**APW-03**)                                                                                                           | **exposed** read-only — public                                                                                                                                                                                              | not needed                            | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/works/:id/app-spec` (**APW-03**)                                                                                                                    | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-spec/validate` (**APW-03**)                                                                                                          | **exposed** — pure validation, persists nothing (this is how an agent checks a spec it is about to propose)                                                                                                                 | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-spec/blueprint`, `/blueprint/upgrade` (202), `/blueprint/dismiss` (**APW-03**)                                                       | **exposed** — applying a curated Blueprint writes files to the Work Repository the platform already owns; `dismiss` is reversible and non-destructive                                                                       | planned, `requiresConfirmation: true` | none                                                                                             | T5 (no spend, no deletion, no publication, no legal act)                                                                                                          |
| `POST /api/works/:id/app-license/attest` (**APW-03**)                                                                                                         | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned (a person attests in the app) | none                                                                                             | T1 (**accepts a legal obligation**). The attestation binds a _person_ to a licence text at a revision (`textId` + `commitSha`)                                    |
| `POST /api/works/:id/provision` (202) (**APW-04**)                                                                                                            | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned, `requiresConfirmation: true` | none                                                                                             | T1 (**spends money** — model tokens). Bounded and receipted, but bounded spend is still spend                                                                     |
| `GET /api/works/:id/provisioning` (**APW-04**)                                                                                                                | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/provision/cancel` (202) (**APW-04**)                                                                                                     | **exposed** — stopping your own run is not a spend and not a deletion                                                                                                                                                       | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `POST …/provisioning/:provisioningId/blueprint-suggestion` (202) (**APW-04**)                                                                                 | **exposed** — this is the _asking_ side (a suggestion for a maintainer), not a gate answer                                                                                                                                  | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/admin/app-blueprint-suggestions`, `…/:provisioningId/bundle` (**APW-04**)                                                                           | **not exposed — platform admin (T4)**; the API answers `404` otherwise                                                                                                                                                      | not planned                           | none                                                                                             | T4                                                                                                                                                                |
| `GET /api/works/:id/builds`, `…/builds/:buildId` (**APW-05**)                                                                                                 | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/builds` (202) (**APW-05**)                                                                                                               | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned, `requiresConfirmation: true` | none                                                                                             | T1 (**spends money** — runner minutes; gated by `EVER_WORKS_APP_BUILDS_ENABLED` and per-day caps, R-30/R-31)                                                      |
| `POST /api/works/:id/builds/:buildId/cancel` (202) (**APW-05**)                                                                                               | **exposed** — cancel is not destruction                                                                                                                                                                                     | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `PUT /api/works/:id/builds/pull-token` (**APW-05**)                                                                                                           | **not exposed — human-only (R-32) + secret input (T2)**                                                                                                                                                                     | not planned                           | none                                                                                             | T1 (**changes a security posture**) + T2 (the field accepts a registry credential)                                                                                |
| `PATCH /api/works/:workId/plugins/:pluginId/settings` (existing; APW-05 build settings)                                                                       | **not exposed — human-only (R-32)** for any property that is a credential, a spend ceiling, a webhook or a security toggle; the existing entry stays for the non-secret settings it exposes today                           | not planned                           | none                                                                                             | T1 + T2. **Standing rule:** every `x-secret: true` property of any plugin settings schema is `omitArgs`. See §3.3 item 3                                          |
| `POST /api/deploy/works/:id` — kind-`app` branch (**APW-06**)                                                                                                 | **not exposed — human-only (R-32)** for the **managed** target; the existing `deploy_work` entry is kept (R-26) and the managed branch carries `@HumanOnly()`                                                               | planned, `requiresConfirmation: true` | none (the existing `work deploy` command reaches the website path; no App Work command is added) | T1 (**spends money**) — see D-A and §3.3                                                                                                                          |
| `GET /api/works/:id/app-status`, `/app-logs/:requestId`, `/app-target`, `/app-deletion-preview` (**APW-06**)                                                  | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-status/refresh` (202), `/app-smoke` (202), `/app-target/check` (202) (**APW-06**)                                                    | **exposed** — bounded, no spend, no destruction. `app-smoke` runs the App spec's own smoke requests against a host that is already live                                                                                     | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-jobs/:name/run` (202) (**APW-06**)                                                                                                   | **exposed** — runs a job the App spec itself declares; no platform spend                                                                                                                                                    | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-rollback` (202) (**APW-06**)                                                                                                         | **exposed** — rollback restores a previous Deployment; it destroys nothing the user authored                                                                                                                                | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-lifecycle` — `pause` \| `resume` \| `cancel-deploy` (**APW-06**)                                                                     | **exposed**                                                                                                                                                                                                                 | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-lifecycle` — `remove` with `deleteData` (**APW-06**)                                                                                 | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned                               | none                                                                                             | T1/T3 (**deletes data** when `deleteData` + `confirmSlug` are given). One handler carries both the benign and the destructive branch                              |
| `POST /api/works/:id/app-logs` (202) (**APW-06**)                                                                                                             | **exposed** — read-shaped, dispatched only because a log pull can be slow                                                                                                                                                   | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/works/:id/app-target` (**APW-06**)                                                                                                                  | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `PUT /api/works/:id/app-target` (**APW-06**)                                                                                                                  | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned, `requiresConfirmation: true` | none                                                                                             | T1 (**changes a security posture** — it selects where user-controlled code runs)                                                                                  |
| `POST /api/works/:id/app-target/kubeconfig` (**APW-06**, added 2026-09-17)                                                                                    | **not exposed — human-only (R-32) + secret input (T2)**                                                                                                                                                                     | planned                               | none                                                                                             | T1 + T2 — CONTRACTS §4 states this is _"the only App Work path that stores a kubeconfig"_                                                                         |
| kind-`app` branches on `POST /api/deploy/works/:id/rollback`, `/domains*`, `/subdomain` (**APW-06**)                                                          | **exposed** where already whitelisted (`list_domains`); `/rollback` and `/subdomain` **exposed** — adding or removing a hostname is reversible and costs nothing                                                            | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/works/:id/app-env` (**APW-07**)                                                                                                                     | **exposed** read-only — names, origins, `set`/`unset` only, **never values**                                                                                                                                                | planned                               | none                                                                                             | T5 (T2 satisfied in the response)                                                                                                                                 |
| `PUT /api/works/:id/app-env` (**APW-07**)                                                                                                                     | **not exposed — human-only (R-32) + secret input (T2)**                                                                                                                                                                     | planned, `requiresConfirmation: true` | none                                                                                             | T1 (**changes a security posture**) + T2. There is no useful values-less version of this route                                                                    |
| `POST /api/works/:id/app-env/:name/rotate` (**APW-07**)                                                                                                       | **not exposed — human-only (R-32) + secret input (T2)**                                                                                                                                                                     | planned                               | none                                                                                             | T1 + T2. Rotation invalidates a live credential; D9 says generated secrets are generated once and never rotated implicitly                                        |
| `GET /api/works/:id/app-dependencies` (**APW-07**)                                                                                                            | **exposed** read-only — status, policy, backup state; **never** connection outputs                                                                                                                                          | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `PUT /api/works/:id/app-dependencies/:kind` (202) (**APW-07**)                                                                                                | **not exposed — human-only (R-32) + secret input (T2)**                                                                                                                                                                     | not planned                           | none                                                                                             | T1 + T2 (write-only prompted provider credentials; it also picks the provider — a security choice)                                                                |
| `POST /api/works/:id/app-dependencies/:kind/provision` (202) (**APW-07**)                                                                                     | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned                               | none                                                                                             | T1 (**spends money** — it creates a database, cache or bucket; gated by `EVER_WORKS_APP_DEPS_ENABLED`, R-30/R-31)                                                 |
| `DELETE /api/works/:id/app-dependencies/:kind` (body `{ confirmSlug }`, 202) (**APW-07**)                                                                     | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned                               | none                                                                                             | T1/T3 (**deletes data**) — R-32's `confirmSlug` line was written for exactly this route                                                                           |
| `POST /api/works/:id/evolve` (202) (**APW-08**)                                                                                                               | **exposed** — starting a change is the product's core loop; the Task's gates, the merge policy and the person's merge are unchanged (D11). The run is admitted through the safety chain (R-17) and the run-cost caps (R-31) | planned (this _is_ the chat loop)     | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/tasks/:id/delivery`, `/cost`; `GET /api/tasks` delivery fields; `GET /api/works/:id/cost` (**APW-08**)                                              | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/tasks/:id/delivery/close`, `/follow-up` (202) (**APW-08**)                                                                                         | **exposed** — closing a _delivery_ is bookkeeping, not a gate answer                                                                                                                                                        | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/app-runs/allow-containment` (**APW-08**)                                                                                                 | **not exposed — human-only (R-32)**                                                                                                                                                                                         | not planned                           | none                                                                                             | T1 (**changes a security posture**) — R-33 makes allowing a downgraded containment an explicit operator decision                                                  |
| `workId` on `POST`/`PATCH /api/me/goals`; `outputMode`/`taskOutput` on `PATCH /api/me/missions/:id`; `templateInputs` on `POST /api/me/missions` (**APW-08**) | **exposed** — already-whitelisted goals/missions tools gain fields automatically from their DTOs                                                                                                                            | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/works/:id/upstream-pull-requests` (**APW-09**)                                                                                                     | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned, `requiresConfirmation: true` | none                                                                                             | T1 (**publishes outside the platform**). The proposal becomes an approval a person decides (R-18) — and the guard is what makes the _proposal_ a person's act too |
| `GET /api/works/:id/upstream-pull-requests`, `…/:prId`, `…/eligibility?taskId` (**APW-09**)                                                                   | **exposed** read-only                                                                                                                                                                                                       | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST …/:prId/check` (**APW-09**)                                                                                                                             | **exposed** — a bounded re-poll (min 60 s between manual checks)                                                                                                                                                            | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `POST …/:prId/address-review` (202) (**APW-09**)                                                                                                              | **not exposed — human-only (R-32)**                                                                                                                                                                                         | not planned                           | none                                                                                             | T1 (**publishes outside the platform** — it prepares a push that continues a public PR)                                                                           |
| `POST …/:prId/signed` (202) (**APW-09**)                                                                                                                      | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned (a person signs)              | none                                                                                             | T1 (**accepts a legal obligation**). README D12: the platform _"never sign[s] a CLA or DCO on the user's behalf"_                                                 |
| `POST …/:prId/withdraw` (**APW-09**)                                                                                                                          | **not exposed — human-only (R-32)**                                                                                                                                                                                         | planned                               | none                                                                                             | T1 (**publishes outside the platform** — a public act on a third-party repository) + T3                                                                           |
| `POST …/suggestions/:taskId/dismiss` (**APW-09**)                                                                                                             | **exposed** — dismissing a local suggestion is reversible and private                                                                                                                                                       | not planned                           | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/agent-approvals/:id/approve\|reject` (existing; APW-09 relies on it)                                                                               | **not exposed — human-only (R-32), and already the case.** The whitelist comment names the answering verbs as deliberately kept out (`whitelist.ts:297-307`)                                                                | not planned                           | none                                                                                             | T1 (answers a gate)                                                                                                                                               |
| `GET /api/me/apps` (**APW-11**)                                                                                                                               | **exposed** read-only **via `@DelegatedRead('apps:read')`** (R-19) — the one route a delegated Ever ID token may reach                                                                                                      | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `PUT /api/me/apps/preferences` (**APW-11**)                                                                                                                   | **exposed** — per-user display preferences; no secret, no destruction, no spend                                                                                                                                             | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/app-launcher/platforms` (**APW-11**)                                                                                                                | **exposed** read-only — public, cached                                                                                                                                                                                      | not needed                            | none                                                                                             | T5                                                                                                                                                                |
| `appLauncherExposed` on `PUT`/`PATCH /api/works/:id` (**APW-11**)                                                                                             | **exposed** — arrives with the existing `update_work` tool; a visibility toggle for the owner's own Work, not a security posture                                                                                            | planned                               | none                                                                                             | T5                                                                                                                                                                |
| operator routes `api/admin/apps-tier/*` (**APW-10**)                                                                                                          | **not exposed — platform admin (T4)**; the guard converts a refusal into `404`. This family includes the tier's `open`/`close`/`pause-all` — operator kill switches are not agent controls                                  | not planned                           | none                                                                                             | T4 + T1 (they change the platform's security posture and stop tenant workloads)                                                                                   |
| `GET /api/me/apps-tier` (**APW-10**)                                                                                                                          | **exposed** read-only — the caller's own eligibility and the tier's open/scope state                                                                                                                                        | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `GET /api/works/:id/apps-tier` (**APW-10**)                                                                                                                   | **exposed** read-only — the caller's own Work: quarantine, profile, usage                                                                                                                                                   | planned                               | none                                                                                             | T5                                                                                                                                                                |
| `POST /api/auth/ever-id/authorize`, `/callback`, `/sign-up/confirm` (**APW-12**)                                                                              | **not exposed — T4 by construction.** Browser redirect flows with an OIDC transaction cookie; a token in a URL is refused (`tokenInQuery`)                                                                                  | not planned                           | the CLI uses the **device** flow, not these routes                                               | T4                                                                                                                                                                |
| `POST /api/auth/ever-id/connect/authorize`, `/connect/confirm`; `GET /identities`; `DELETE /identities/:id`; `GET /logout-url` (**APW-12**)                   | **not exposed — session-only (T4)**; the API answers `403 sessionRequired` to an API key                                                                                                                                    | planned (Settings ▸ Personal)         | none                                                                                             | T4 + T1 (unlinking can lock the account out: `409 lastSignInMethod`)                                                                                              |
| `POST /api/auth/ever-id/backchannel-logout` (**APW-12**)                                                                                                      | **not exposed — T4** (the identity provider calls it, not a user)                                                                                                                                                           | not planned                           | none                                                                                             | T4                                                                                                                                                                |
| `POST /api/auth/ever-id/session` (**APW-12**)                                                                                                                 | **not exposed — secret input (T2) + client-credential path (T4)**. The request carries a bearer token                                                                                                                       | not planned                           | used by the CLI device flow                                                                      | T2 + T4                                                                                                                                                           |
| `GET /api/auth/ever-id/client-config` (**APW-12**)                                                                                                            | **not exposed** on the MCP surface — it returns no secrets and exists for the CLI/node clients; nothing in the agent loop needs it                                                                                          | not planned                           | read by the CLI device flow                                                                      | T5 by content, omitted by usefulness                                                                                                                              |
| `POST /api/auth/ever-id/admin/test`, `GET /api/auth/ever-id/admin/health` (**APW-12**)                                                                        | **not exposed — platform admin (T4)**                                                                                                                                                                                       | not planned                           | none                                                                                             | T4                                                                                                                                                                |
| `GET /api/auth/providers` (existing, + `everId`) (**APW-12**)                                                                                                 | already public and not whitelisted; unchanged                                                                                                                                                                               | not needed                            | none                                                                                             | —                                                                                                                                                                 |

**Count.** Under R-32 the programme exposes **no new spending, deleting, publishing, posture-changing or
legal route to an agent**: one new MCP tool is named today (`inspect_app_source`, a read), and the remaining
exposed rows are reads and non-spending dispatches whose tool names the exposing epic chooses in the same PR
as the entry. **18 App Works rows are human-only** and must appear in §4's human-only column.

### 3.3 Open decisions for the lead (recorded, not resolved unilaterally)

1. **`deploy_work` — R-32 says "the MCP whitelist omits human-only routes"; R-26 says nothing is removed.**
   D-A's recommended reading keeps the entry and applies `@HumanOnly()` to the managed-target branch only.
   The alternative — dropping the `deploy_work` entry — is a one-line removal the owner must authorise
   explicitly. **This document does not authorise it.**
2. **§4 has no human-only column.** R-32 requires one; the current header is `| Route | Owner |`. §6.1
   supplies the literal column and its values.
3. **`PATCH /api/works/:workId/plugins/:pluginId/settings` is a pre-existing whitelisted route** that the
   programme now extends with build settings. R-32 would make parts of it human-only. Splitting a
   pre-existing route's exposure is a decision for the lead; the standing `x-secret → omitArgs` rule in §3.2
   is the additive interim.
4. **APW-13's `tasks.md` has no OpenAPI or fragment task.** Neither `apps/api/src/openapi/__tests__/` nor a
   "fragment updated in the same PR" line exists ([`../APW-13-golden-paths/tasks.md`](./../APW-13-golden-paths/tasks.md)
   is silent on `openapi`, `swagger` and `fragment`). [`README.md`](./README.md) §2 and this document both
   depend on that task existing.

---

## 4. How a route is added to, or removed from, a surface

### 4.1 Adding to MCP

1. **Decide R-32 first.** If the route spends money, deletes data, publishes outside the platform, changes a
   security posture or accepts a legal obligation, it is **human-only** and the answer is `not exposed` — add
   the `@HumanOnly()` decorator instead, and stop here.
2. The route must exist in the generated OpenAPI document, and **every body property needs `@ApiProperty`**
   or it will not appear in the tool's arguments
   (`apps/mcp/src/openapi-tools/schema-converter.service.ts:37-56`; the document is OpenAPI 3.0, so
   nullability is the `nullable: true` spelling).
3. Add the entry to `apps/mcp/src/openapi-tools/whitelist.ts` under the right domain block, with `toolName`,
   `annotations` and — where a human-only _flag_ sits on an otherwise usable route — `omitArgs`.
4. Bump the block's count comment **and** `apps/mcp/README.md`'s `## Available Tools (N)` heading; a test
   asserts the heading and the feature doc agree (`whitelist-tasks-inbox-goals-fleet.spec.ts:264-268`).
5. Extend the pinning spec — `apps/mcp/test/whitelist-app-works.spec.ts` (created by APW-01 T19) — and, for
   a human-gate exclusion, assert **absence**, the way
   `whitelist-tasks-inbox-goals-fleet.spec.ts:196-203` does.
6. Record the decision in §3.2 and, if the route is human-only, in §4's column.

**Nothing is removed from the whitelist by this programme.** If a route is ever found to be wrongly exposed,
the fix is `omitArgs` on the offending field or an explicit owner-authorised removal — R-26 forbids a silent
one.

### 4.2 Adding a `@HumanOnly()` guard

Decorate the **handler** (not the controller) with `@HumanOnly()` from
`apps/api/src/safety/decorators/human-only.decorator.ts`, make sure `HumanActorGuard` is reachable from the
module (it is provided, non-global, in `apps/api/src/safety/safety.module.ts:29` — so either import
`SafetyModule` or add the guard to the new module's providers), add the route to §4's human-only column, and
add a spec that asserts the metadata is present — the way
`apps/api/src/safety/safety.controller.spec.ts:386` does.

### 4.3 Adding to chat

1. Add an `OperationSpec` to `apps/web/src/lib/ai/tools/generated/registry*.ts` with a truthful
   `requiresConfirmation` (true whenever the flow continues into a human-only action).
2. A chat tool runs with the **person's session**, so a human-only route is reachable — the tool must start
   the flow, never complete the gate. The guard's `403` is the backstop, not the design.
3. Hand-written chat tools for App Works belong in a sibling `*.tools.ts` under `apps/web/src/lib/ai/tools/`
   and win name collisions (`index.ts:89-90`).

### 4.4 Adding to an agent run (the third surface)

A tool for the agent tool loop is a **separate** decision from a chat tool: register it through
`AGENT_DOMAIN_TOOL_SOURCES` (`packages/agent/src/agents/agent-domain-tool-sources.ts:51,174-187`, bound at
`apps/api/src/agents/agents.module.ts:911`). An agent run authenticates as a **machine**, so every R-32 route
is `403` to it — and the Provisioner's agent is additionally constrained by its sandbox policy
(`allow_mcp_servers: false`) and by an explicit deny-list including `commitToRepo`, `openPullRequest` and
every MCP tool ([`../APW-04-app-provisioner/plan.md`](./../APW-04-app-provisioner/plan.md) §7.4).

### 4.5 Adding a CLI command

A new App Works command must call the same route as the web and must not bypass the API gate (R-6). Because
the CLI holds a token rather than a browser session, **any human-only route is `403` from the CLI** — a
command for one would have to open a browser session (R-32's intent). **No App Works CLI command is planned
in Wave 1–3.**

---

## 5. Standing exclusions (never exposed on any surface)

| Class                           | Routes                                                                                                                                                                                                                                                                   | Reason                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Answering a gate                | `POST /api/inbox/:id/reply`, `POST /api/tasks/:id/escalations/:id/resolve`, `POST /api/me/goals/:id/dod/approve`, `force` on `POST /api/tasks/:id/transition`, `requireAllApprovers` on `POST`/`PATCH /api/tasks*`, `POST /api/agent-approvals/:id/approve\|reject`      | R-32 / T1 — already excluded today (`whitelist.ts:291-310`, `:302-304`, `:326`, `:334`, `:356`) |
| Legal / contractual attestation | `POST /api/works/:id/app-license/attest`, `POST …/:prId/signed`                                                                                                                                                                                                          | R-32 — a person's statement, bound to a text and a revision                                     |
| Secret input / security posture | `PUT /api/works/:id/app-env`, `POST …/app-env/:name/rotate`, `PUT …/app-dependencies/:kind`, `PUT /api/works/:id/builds/pull-token`, `PUT /api/works/:id/app-target`, `POST …/app-target/kubeconfig`, `POST …/app-runs/allow-containment`, any `x-secret` plugin setting | R-32 / T1 + T2                                                                                  |
| Spending money                  | `POST /api/works/:id/provision`, `POST …/builds`, `POST …/app-dependencies/:kind/provision`, `POST /api/deploy/works/:id` (managed target), `POST /api/works/:id/upstream-pull-requests`, `POST …/:prId/address-review`                                                  | R-32 / T1                                                                                       |
| Data destruction                | `POST /api/works/:id/delete` (with `delete_stored_data`), `DELETE /api/works/:id/app-dependencies/:kind`, `POST …/app-lifecycle` (`remove` with `deleteData`), `POST …/:prId/withdraw`                                                                                   | R-32 / T1 + T3                                                                                  |
| Platform administration         | `api/admin/apps-tier/*`, `GET /api/admin/app-blueprint-suggestions*`, `/api/auth/ever-id/admin/*`                                                                                                                                                                        | T4                                                                                              |
| Session-only identity acts      | `connect/authorize`, `connect/confirm`, `GET`/`DELETE /api/auth/ever-id/identities*`, `GET /logout-url`                                                                                                                                                                  | T4 — the API itself admits only `authMethod === 'session'`                                      |

---

## 6. What this decision asks of other files

### 6.1 The §4 human-only column (literal markdown for the lead)

R-32 requires the column; it does not exist. The change is **purely additive**: `| Route | Owner |` becomes
`| Route | Owner | Human-only |`, the separator gains a cell, and **every existing row gains one third cell**.
No route string and no owner cell changes. The rows whose third cell is **not** blank:

| Route (as §4 writes it)                                       | Owner  | Human-only                                      |
| ------------------------------------------------------------- | ------ | ----------------------------------------------- |
| `POST /api/works/:id/delete` — the `delete_stored_data` set   | APW-01 | ✅ typed `confirm_slug` + `@HumanOnly()` (R-15) |
| `POST /api/works/:id/app-license/attest`                      | APW-03 | ✅ legal attestation (C3, R-3)                  |
| `POST /api/works/:id/provision` (202)                         | APW-04 | ✅ spends tokens                                |
| `POST /api/works/:id/builds` (202)                            | APW-05 | ✅ spends runner minutes                        |
| `PUT /api/works/:id/builds/pull-token`                        | APW-05 | ✅ registry credential                          |
| `POST /api/deploy/works/:id` — the managed-target branch      | APW-06 | ✅ spends compute (see D-A)                     |
| `POST /api/works/:id/app-lifecycle` — `remove` + `deleteData` | APW-06 | ✅ deletes data                                 |
| `PUT /api/works/:id/app-target`                               | APW-06 | ✅ security posture                             |
| `POST /api/works/:id/app-target/kubeconfig`                   | APW-06 | ✅ kubeconfig                                   |
| `PUT /api/works/:id/app-env`                                  | APW-07 | ✅ secrets                                      |
| `POST /api/works/:id/app-env/:name/rotate`                    | APW-07 | ✅ invalidates a live credential                |
| `PUT /api/works/:id/app-dependencies/:kind` (202)             | APW-07 | ✅ provider credentials                         |
| `POST /api/works/:id/app-dependencies/:kind/provision` (202)  | APW-07 | ✅ provisions paid resources                    |
| `DELETE /api/works/:id/app-dependencies/:kind`                | APW-07 | ✅ deletes data                                 |
| `POST /api/works/:id/app-runs/allow-containment`              | APW-08 | ✅ security posture (R-33)                      |
| `POST /api/works/:id/upstream-pull-requests`                  | APW-09 | ✅ publishes outside the platform               |
| `POST …/:prId/signed` (202)                                   | APW-09 | ✅ CLA/DCO                                      |
| `POST …/:prId/withdraw`                                       | APW-09 | ✅ public act on a third-party repository       |
| `POST …/:prId/address-review` (202)                           | APW-09 | ✅ publishes outside the platform               |

### 6.2 Task lines the exposing epics must add

| Epic       | Task line to add                                                                                                                                                                                                                                                               | Why                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **APW-01** | already carries T19 (whitelist entry, `omitArgs`, `whitelist-app-works.spec.ts`) — **no change**; add `@HumanOnly()` + the column row for the `delete_stored_data` branch                                                                                                      | D-C, D-D, R-32                                                  |
| **APW-02** | whitelist entries + chat tools for the three upstream routes; `@HumanOnly()` + column row **if** the epic reads fork sync as publishing                                                                                                                                        | §3.2                                                            |
| **APW-03** | whitelist entries for the catalog reads, `app-spec` read/validate and the Blueprint apply/upgrade/dismiss tools; **assert `app-license/attest` is absent** and add its `@HumanOnly()` + column row                                                                             | §3.2, R-32                                                      |
| **APW-04** | whitelist entries for the provisioning read/cancel/suggestion routes; **assert `provision` and the two admin routes are absent**; `@HumanOnly()` + column row on `provision`                                                                                                   | §3.2, R-32                                                      |
| **APW-05** | whitelist entries for the builds reads and `cancel`; **assert `builds` (POST) and `builds/pull-token` are absent**; `@HumanOnly()` + column rows; the standing `x-secret → omitArgs` rule for plugin settings                                                                  | §3.2, R-32                                                      |
| **APW-06** | the `deploy_work` kind-`app` decision **pinned by a test** (D-A); `@HumanOnly()` on the managed branch, `app-lifecycle` `remove` + `deleteData`, `app-target` PUT and `app-target/kubeconfig`; whitelist entries for the app-status/logs/target-read/rollback/smoke/jobs tools | D-A, §3.2, R-32                                                 |
| **APW-07** | whitelist entries for `GET app-env` and `GET app-dependencies`; **assert `PUT app-env`, `app-env/:name/rotate`, `PUT app-dependencies/:kind`, `DELETE app-dependencies/:kind` and `app-dependencies/:kind/provision` are absent**; `@HumanOnly()` + column rows on each        | §3.2, R-32                                                      |
| **APW-08** | chat tool for `evolve`; whitelist entries for the delivery/cost reads, `delivery/close` and `delivery/follow-up`; `@HumanOnly()` + column row on `app-runs/allow-containment`                                                                                                  | §3.2, R-32                                                      |
| **APW-09** | whitelist entry for reading upstream PRs, `check` and `suggestions/:taskId/dismiss`; **assert `upstream-pull-requests` (POST), `signed`, `withdraw` and `address-review` are absent**; `@HumanOnly()` + column rows on each                                                    | §3.2, R-32                                                      |
| **APW-10** | **assert every `api/admin/apps-tier/*` route is absent**; whitelist entries for `GET /api/me/apps-tier` and `GET /api/works/:id/apps-tier`                                                                                                                                     | §3.2                                                            |
| **APW-11** | whitelist entries for `GET /api/me/apps` (delegated, `apps:read`), `PUT /api/me/apps/preferences` and `GET /api/app-launcher/platforms`                                                                                                                                        | §3.2                                                            |
| **APW-12** | **assert none of `/api/auth/ever-id/*` is whitelisted** (session/client-credential surface, not an agent surface)                                                                                                                                                              | §3.2                                                            |
| **APW-13** | one P0 task for `apps/api/src/openapi/__tests__/app-works-contract.spec.ts` — the fragment superset check **and** the `x-mcp` negative check (a `not-exposed` route has no tool)                                                                                               | makes §3 testable — the task does not exist today (§3.3 item 4) |
