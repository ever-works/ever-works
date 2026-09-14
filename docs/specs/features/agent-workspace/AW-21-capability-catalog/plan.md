# AW-21 — Capability & playbook catalogue · Implementation Plan

**Epic:** `AW-21-capability-catalog` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Tasks:** [tasks.md](./tasks.md)
**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-09-06
**Size:** M · **Blocking dependencies:** [AW-08](../README.md#3-epics)

> **Additive-only.** Two new tables, one new API module, one new capability, one new first-party
> plugin package, one new facade, one new dispatcher symbol, one new web route tree. Nothing
> existing is removed, renamed or re-bound.
>
> **The load-bearing decision:** playbook **definitions** are catalogue data behind a plugin
> capability, exactly as Skill catalogue entries already are — so they carry no schema, no
> migration and no admin UI. Only the **adoption** (what this workspace actually set up) becomes
> rows. §3.1 explains why, and §7 explains why the provider is a plugin rather than a service.
>
> **Two thirds of the Workflows work is already done.** `apps/api/src/workflows/workflows.controller.ts`
> ships eight tested routes against a finished executor. This epic gives them a screen; it writes
> no new workflow backend at all.

---

## 1. Current state in the codebase

Every path below was verified to exist in this worktree before being cited.

### 1.1 The five capability surfaces that exist today

| File                                                                                                                          | What it does today                                                                                                                                                                                                                              | What this epic does with it                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/[locale]/(dashboard)/templates/page.tsx`                                                                    | The DB-backed template catalogue. Reads `?kind=` and offers exactly `['website','work','mission']`; renders `TemplatesCatalog`. Fully internationalised under `dashboard.templatesPage` / `dashboard.templates` / `dashboard.templateSelector`. | Untouched. The **Starting points** section links here with `?kind=`.                                                                                                                                                  |
| `apps/web/src/app/[locale]/(dashboard)/agents/templates/page.tsx`                                                             | Repo-backed agent-template browser (`AstTemplatesBrowser`, `entity="agent"`). Self-labelled a "Phase 18.6 (scaffold)".                                                                                                                          | Untouched. Linked from the index.                                                                                                                                                                                     |
| `apps/web/src/app/[locale]/(dashboard)/skills/templates/page.tsx`                                                             | Same browser, `entity="skill"`.                                                                                                                                                                                                                 | Untouched.                                                                                                                                                                                                            |
| `apps/web/src/app/[locale]/(dashboard)/tasks/templates/page.tsx`                                                              | Renders `TaskWorkflowTemplatesList` (the real multi-step templates) **above** the scaffold `AstTemplatesBrowser`. Hardcoded English.                                                                                                            | Untouched. The **Task templates** section on the index surfaces `TaskWorkflowTemplatesList`'s data with its own i18n keys and links here for the rest.                                                                |
| `apps/web/src/components/templates/TemplatesCatalog.tsx`, `.../AstTemplatesBrowser.tsx`, `.../CreateCustomTemplateDialog.tsx` | The three existing browse components.                                                                                                                                                                                                           | Not reused. The catalogue index needs a card grid with readiness chips these components do not have; forking their markup would couple two unrelated surfaces. Their **data** is reused via the existing API clients. |
| `apps/web/src/components/tasks/TaskWorkflowTemplatesList.tsx`                                                                 | Lists the caller's `task_templates` with an instantiate control.                                                                                                                                                                                | Its API client is reused; the index renders a compact card variant.                                                                                                                                                   |

### 1.2 The backends the catalogue reads

| File                                                                               | Route / export                                                                                                                                                                                                               | Used for                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/api/src/skills/skills.controller.ts`                                         | `GET api/skills/catalog`, `GET api/skills/catalog/:slug`, `POST api/skills/install`, `POST api/skills/:id/bindings`                                                                                                          | Skills section; adoption step 2                                             |
| `packages/agent/src/facades/skills.facade.ts`                                      | `SkillsFacadeService` — fans catalogue reads across enabled `skills-provider` plugins, dedupes by slug                                                                                                                       | The pattern the playbook facade copies verbatim                             |
| `packages/plugins/everworks-skills/src/everworks-skills.plugin.ts`                 | First-party `skills-provider` with an in-code fallback catalogue                                                                                                                                                             | The pattern the playbook plugin copies verbatim                             |
| `apps/api/src/workflows/workflows.controller.ts`                                   | `GET api/workflows`, `GET api/workflows/runs/:runId`, `GET api/workflows/:id`, `POST api/workflows`, `PATCH api/workflows/:id`, `POST api/workflows/:id/run` (202), `GET api/workflows/:id/runs`, `DELETE api/workflows/:id` | Workflows section — **no new API needed**                                   |
| `packages/agent/src/services/workflows.service.ts`, `.../workflow-runs.service.ts` | Owner-scoped list/get/create/update/remove; run start via dispatcher                                                                                                                                                         | Read only                                                                   |
| `apps/api/src/task-templates/task-templates.controller.ts`                         | `GET/POST api/task-templates`, `GET/PATCH/DELETE :id`, `POST :id/instantiate`                                                                                                                                                | Task templates section; adoption step 3                                     |
| `apps/api/src/agents/agents.controller.ts`                                         | `GET api/agents/templates`, `POST api/agents/from-template/:slug`, `PATCH api/agents/:id`                                                                                                                                    | Adoption steps 1 and 4                                                      |
| `packages/agent/src/agents/agent-templates.service.ts`, `.../agent-templates.ts`   | The 6 built-in, fully-specified agent presets (`AGENT_TEMPLATES`) with `systemPrompt`, `suggestedSkills`, `defaultPermissions`, `defaultGuardrails`                                                                          | Adoption step 1 resolves `agentTemplateSlug` here                           |
| `packages/agent/src/agents/guardrails.ts`                                          | `AgentGuardrails` (`mode: 'require_approval' \| 'autonomous'`, `autoApproveActionTypes`, `blockedActionTypes`), `validateGuardrails`, `AGENT_GUARDRAIL_MODES`                                                                | Adoption step 4 and the spec's escalation-point promise                     |
| `packages/agent/src/entities/agent-action-proposal.entity.ts`                      | `AGENT_ACTION_PROPOSAL_ACTION_TYPES = ['spawn_agent','schedule_task','send_message','budget_override','other']`                                                                                                              | The exact vocabulary the detail page's `WHAT IT MAY DO ALONE` block renders |
| `apps/api/src/plugins/plugins.controller.ts`                                       | `GET api/plugins`, `GET api/plugins/:pluginId/connection-status`                                                                                                                                                             | Readiness: does an enabled plugin provide capability X                      |
| `apps/api/src/schedules/schedules.controller.ts`                                   | `GET api/schedules` — the seven-source cadence aggregation                                                                                                                                                                   | Adoption detail shows the created cadence; no write here                    |
| `apps/api/src/triggers/inbound-triggers.controller.ts`                             | `POST api/inbound-triggers` (+ pause/resume/test-fire/fires). `InboundTrigger.mode` is `'single-task' \| 'template'` with `taskTemplateId`                                                                                   | Adoption step 5 for `inbound_trigger`-kind playbooks                        |
| `packages/agent/src/entities/agent-run.entity.ts`                                  | `costCents` (integer cents), token totals, status                                                                                                                                                                            | The adoption's 30-day rollup                                                |
| `packages/agent/src/entities/agent-escalation.entity.ts`                           | `agent_escalations` — `reasonCode`, `summary`, `decisionNeeded`, `confidence`                                                                                                                                                | Read for the adoption's "raised a decision" link                            |

### 1.3 The shell the new route hangs off

| File                                                               | What it does today                                                                                             | Change                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/[locale]/(dashboard)/layout.tsx`                 | Auth-gates the group, then one `Promise.all` of independently `.catch()`-guarded fetches into the client shell | Untouched — the catalogue is a page, not a shell concern                                                                                                         |
| `apps/web/src/components/dashboard/DashboardSidebar.tsx`           | Hardcoded nav array; entries read from `dashboard.sidebar.navigation.*`                                        | **One entry added**: `catalog`, placed after `templates`                                                                                                         |
| `apps/web/src/lib/constants.ts`                                    | `ROUTES` is the single source of truth for paths                                                               | Gains `DASHBOARD_CATALOG`, `DASHBOARD_CATALOG_PLAYBOOK(slug)`, `DASHBOARD_CATALOG_ADOPTION(id)`, `DASHBOARD_CATALOG_WORKFLOWS`, `DASHBOARD_CATALOG_WORKFLOW(id)` |
| `apps/web/src/components/common/EmptyState.tsx`                    | Shared `title`/`description`/`action`/`icon` primitive                                                         | Reused for all five section empty states                                                                                                                         |
| `apps/web/src/lib/api/server-api.ts`                               | `serverFetch` / `serverMutation`                                                                               | Every new API client is built on it                                                                                                                              |
| `apps/web/src/lib/api/task-templates.ts`, `.../agent-templates.ts` | Existing typed clients                                                                                         | Reused as-is by the index                                                                                                                                        |

### 1.4 The plugin + facade registration surface

| File                                                                                 | Why it is touched                                                          |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/plugin/src/contracts/facade-capabilities.ts`                               | `PLUGIN_CAPABILITIES` gains `PLAYBOOK_PROVIDER: 'playbook-provider'`       |
| `packages/plugin/src/contracts/capabilities/index.ts`                                | Barrel for the new interface file                                          |
| `packages/agent/src/facades/facades.module.ts`, `.../index.ts`, `.../base.facade.ts` | The new facade is declared and exported exactly like `SkillsFacadeService` |
| `packages/agent/src/plugins/services/plugin-registry.service.ts`                     | Untouched — discovery is automatic                                         |

### 1.5 Entity / repository registration surface

Adding an entity to `@ever-works/agent` touches four files, and `packages/agent/src/database/database.module.spec.ts` fails CI if any is missed:

1. `packages/agent/src/entities/index.ts` — barrel export.
2. `packages/agent/src/database/_entity-names.ts` — the string-only name list (alphabetical).
3. `packages/agent/src/database/_entities-inventory.ts` — the real `ENTITIES` array.
4. `packages/agent/src/database/_repository-inventory.ts` — `REPOSITORY_PROVIDERS`, plus a barrel
   line in `packages/agent/src/database/index.ts`.

### 1.6 The job-runtime seam

| File                                                                            | Pattern                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/tasks/_tasks-symbols.ts`                                    | The canonical list of `*_DISPATCHER` symbol names (`WORKFLOW_RUN_DISPATCHER`, `TEMPLATE_CUSTOMIZATION_DISPATCHER`, …). A drift spec reads it. |
| `packages/agent/src/tasks/workflow-run-dispatcher.ts` + `workflow-run.types.ts` | The exact two-file shape a new dispatcher takes: a payload type and an interface + `Symbol()`                                                 |
| `packages/agent/src/tasks/job-runtime.providers.ts`                             | The binding factory that routes every symbol to the active provider                                                                           |
| `packages/tasks/src/dispatchers/workflow-run.dispatcher.ts`                     | The Trigger.dev adapter; returns `null` (never throws) when the runtime is not configured                                                     |
| `packages/tasks/src/tasks/trigger/workflow-run.task.ts`                         | Consumer task; ids-only payload; `withWorkerContext`; `assertUuid` on every id off the queue                                                  |
| `packages/tasks/src/trigger/worker/modules/trigger-workflow-run.module.ts`      | The per-task worker Nest module                                                                                                               |
| `packages/tasks/src/tasks/trigger/agent-run-sweeper.task.ts`                    | The `schedules.task({ id, cron })` shape for a sweeper                                                                                        |

---

## 2. Architecture and the seam it plugs into

```
                        ┌──────────────────────────────────────────────┐
   BROWSE               │  /catalog  (server component, one round trip) │
                        └──────────────────────────────────────────────┘
                                          │
        ┌──────────────┬──────────────────┼──────────────────┬─────────────────┐
        ▼              ▼                  ▼                  ▼                 ▼
  GET /api/       GET /api/          GET /api/          GET /api/        GET /api/
  catalog/        skills/catalog     workflows          task-templates   templates
  playbooks       (existing)         (existing)         (existing)       (existing)
        │
        ▼
 ┌───────────────────────────┐        ┌─────────────────────────────────────────┐
 │ PlaybookCatalogService    │───────►│ PlaybookCatalogFacadeService            │
 │ (apps/api/src/catalog)    │        │ (packages/agent/src/facades)            │
 │  • merge + version-pick   │        │  • resolve enabled `playbook-provider`  │
 │  • sanitise + cap         │        │    plugins for the scope                │
 │  • 300 s scope cache      │        │  • fan out, dedupe by slug              │
 └───────────────────────────┘        └─────────────────────────────────────────┘
        │                                              │
        ▼                                              ▼
 ┌───────────────────────────┐          ┌──────────────────────────────────────┐
 │ PlaybookReadinessService  │          │ @ever-works/everworks-playbooks-     │
 │  • capability → enabled?  │          │ plugin  (packages/plugins/…)         │
 │  • adoption ceiling       │          │  • BUILTIN_PLAYBOOKS (8, in code)    │
 │  • per-slug copy limit    │          │  • optional remote source + 1 h TTL  │
 │  • name collision         │          └──────────────────────────────────────┘
 │  • 60 s cache             │
 └───────────────────────────┘

   ADOPT
        POST /api/catalog/playbooks/:slug/adopt   ──202──►  playbook_adoptions (provisioning)
                                                                    │
                                     PLAYBOOK_ADOPTION_DISPATCHER ──┘
                                                    │
                                                    ▼
                        packages/tasks/.../playbook-adoption.task.ts
                                                    │
              ┌───────────┬───────────┬─────────────┼───────────┬────────────┐
              ▼           ▼           ▼             ▼           ▼            ▼
        AgentTemplates  Skills    TaskTemplates  Agents     Agents /     Workflows
        Service.create  install+  .create        .patch     InboundTrig  .create
                        bind                     guardrails   .create    (optional)
              └───────────┴───────────┴─────────────┴───────────┴────────────┘
                                     each writes one playbook_adoption_artifacts row
```

**The seam.** The catalogue is a **reader over five existing sources plus one new one**, and the
adoption path is a **composer over five existing services**. It introduces no new execution
engine, no new scheduling mechanism and no new approval mechanism — it configures the ones that
exist. That is deliberate: every promise a playbook card makes ("it will ask before it sends
anything") has to be enforced by the same code that enforces it for a hand-built agent, or the
card is lying.

**Three rules the adoption composer obeys.**

1. **Nothing it did not itemise.** The setup sheet's list and the provisioning steps are generated
   from the same function (`planAdoption(entry, input)`), so a step that creates a row the sheet
   did not show is a unit-test failure, not a review catch.
2. **Never edit an existing row's configuration.** Reuse means _adding a skill binding to an
   Agent_. It never rewrites instructions, guardrails, permissions or cadence on a row the user
   already owns.
3. **Idempotent per step, keyed by the adoption.** Each step first looks for its own artefact row.
   Resume re-enters the same function and skips what is already recorded.

---

## 3. Data model

### 3.1 What deliberately gets no schema

**Playbook definitions.** They are catalogue data supplied by a `playbook-provider` plugin,
resolved through a facade, cached in memory on a TTL. This mirrors `skills-provider` exactly, and
it buys four things a table would cost us: definitions ship and roll back with the build; there is
no admin CRUD surface to build or secure; a definition cannot drift from the agent template and
skill slugs it references (a build-time integrity spec pins them, the way `AGENT_TEMPLATES`
already pins `suggestedSkills` against the first-party skill catalogue); and a stale row can never
describe a capability the running build does not have.

**Readiness.** Computed per request from plugin state plus two counts. Caching it in a table would
create a correctness problem (a freshly enabled plugin showing `Not ready`) in exchange for
nothing.

### 3.2 New entity — `PlaybookAdoption` (`playbook_adoptions`)

`packages/agent/src/entities/playbook-adoption.entity.ts`

| Column                     | Type                          | Notes                                                                                                                                                  |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                       | `uuid` PK                     |                                                                                                                                                        |
| `userId`                   | `uuid`                        | Owner. Every read filters on it.                                                                                                                       |
| `playbookSlug`             | `varchar(64)`                 | The catalogue slug. Not an FK — definitions have no table.                                                                                             |
| `playbookVersion`          | `varchar(32)`                 | The version adopted, so a later catalogue bump is visible as a diff rather than a silent change.                                                       |
| `instanceName`             | `varchar(200)`                | User-editable at setup (FR-30).                                                                                                                        |
| `status`                   | `varchar(16)`                 | `provisioning \| active \| paused \| failed \| retired \| removed`. Default `provisioning`.                                                            |
| `stepIndex`                | `int`                         | Highest completed provisioning step (0–6). Drives resume and the progress bar. Default `0`.                                                            |
| `failureCode`              | `varchar(64)` nullable        | Short machine token (`skill_install_failed`, `agent_create_failed`, `dispatch_failed`, `timed_out`). Never a stack.                                    |
| `failureDetail`            | `text` nullable               | One human sentence. Deliberately typed as text we author, never a serialised `Error`.                                                                  |
| `plan`                     | `simple-json`                 | The itemised plan the sheet showed, frozen at confirm time. Read whole, written once — same argument as `workflows.graph`.                             |
| `workId`                   | `uuid` nullable               | Optional narrowing when the playbook is scoped to one Work.                                                                                            |
| `agentId`                  | `uuid` nullable               | Denormalised pointer to the created Agent so the adoption list needs no join. No `@ManyToOne` (cycle avoidance, same posture as `workflow.entity.ts`). |
| `scheduleKind`             | `varchar(16)` nullable        | `agent_heartbeat \| inbound_trigger \| manual` — which cadence mechanism was used.                                                                     |
| `lastRunAt`                | `PortableDateColumn` nullable | Mirrored from the created Agent's runs by the rollup read; nullable until the first run.                                                               |
| `graduationDismissedUntil` | `PortableDateColumn` nullable | FR-49's 30-day suppression.                                                                                                                            |
| `activatedAt`              | `PortableDateColumn` nullable | When it first reached `active`. FR-49's 14-day clock.                                                                                                  |
| `tenantId`                 | `uuid` nullable               | Tier C scope stamp.                                                                                                                                    |
| `organizationId`           | `uuid` nullable               | Tier C scope stamp.                                                                                                                                    |
| `createdAt` / `updatedAt`  | timestamps                    |                                                                                                                                                        |

Indexes:

- `idx_playbook_adoptions_user_status` on `(userId, status)` — the adoptions list.
- `idx_playbook_adoptions_org` on `(organizationId)` — the workspace ceiling count.
- `idx_playbook_adoptions_slug` on `(userId, playbookSlug)` — the per-slug copy limit and the
  `Already set up` chip on every card.
- **Partial unique** `uq_playbook_adoptions_inflight` on `(userId, playbookSlug)`
  `WHERE status = 'provisioning'` — this is what makes FR-36 (two people, same second, one Agent)
  structural rather than a race the service tries to win.

> `PortableDateColumn` (`packages/agent/src/entities/_types.ts`) is mandatory, not stylistic: the
> e2e stack and CI run better-sqlite3, which has no `timestamp` type, and a raw one makes TypeORM
> metadata validation throw at boot.

### 3.3 New entity — `PlaybookAdoptionArtifact` (`playbook_adoption_artifacts`)

`packages/agent/src/entities/playbook-adoption-artifact.entity.ts`

| Column           | Type                          | Notes                                                                                                                                                         |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `uuid` PK                     |                                                                                                                                                               |
| `adoptionId`     | `uuid`                        | `@ManyToOne(() => PlaybookAdoption, { onDelete: 'CASCADE' })`                                                                                                 |
| `artifactType`   | `varchar(24)`                 | `agent \| skill \| skill_binding \| task_template \| schedule \| inbound_trigger \| workflow`                                                                 |
| `artifactId`     | `uuid`                        | The row id in its owning table. **No FK** — the target may be deleted independently, and a hard FK would make "already gone" (FR-46) impossible to represent. |
| `nameAtCreation` | `varchar(200)`                | What it was called when we made it. Powers the `Changed since setup` flag.                                                                                    |
| `state`          | `varchar(16)`                 | `created \| removed`. `changed` and `missing` are **derived on read**, never written.                                                                         |
| `removedAt`      | `PortableDateColumn` nullable |                                                                                                                                                               |
| `createdAt`      | timestamp                     |                                                                                                                                                               |

Indexes:

- `idx_playbook_artifacts_adoption` on `(adoptionId)`.
- `idx_playbook_artifacts_target` on `(artifactType, artifactId)` — the reverse lookup that lets
  an Agent page say "created by the Weekly operations report playbook" (FR-50).
- **Unique** `uq_playbook_artifacts_step` on `(adoptionId, artifactType, artifactId)` — makes the
  resume path (FR-35) idempotent at the database rather than in a `if (!exists)` branch.

### 3.4 Migration (Constitution V — same PR)

`apps/api/src/migrations/1791210000000-CreatePlaybookAdoptions.ts`

Forward-only. `up()` creates both tables and all seven indexes; `down()` drops them in reverse
order. Nothing is backfilled — before this migration no adoption existed, so there is no data to
preserve. No existing table is altered, so there is no rollback hazard for anything else.

The partial unique index is written as raw SQL in the migration (`CREATE UNIQUE INDEX … WHERE
status = 'provisioning'`) and declared on the entity with TypeORM's `where` option so
`migration:generate` does not keep proposing it.

> Migrations live in `apps/api/src/migrations/` (latest on `develop` at time of writing
> `1790100000000-AddReleaseVerification.ts`; this epic's timestamp is its reserved block's slot 00, [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)) and self-apply on boot via `migrationsRun`. Constitution
> §V's `src/database/migrations` path predates the move; the live directory is the one above.

### 3.5 New contract types (no schema)

`packages/contracts/src/playbook/playbook-catalog.types.ts` — the wire and plugin contract:

```
PlaybookTriggerKind      = 'schedule' | 'inbound_trigger' | 'event' | 'manual'
PlaybookCategory         = 'reporting' | 'content' | 'operations' | 'research' | 'inbox'
PlaybookCostBand         = 'low' | 'medium' | 'high'
PlaybookArtefactKind     = 'kb_document' | 'mission' | 'task' | 'email_draft' | 'run_receipt'
PlaybookEscalationTarget = 'approval' | 'escalation'

PlaybookStep             { position, title, produces, agentTemplateSlug?, requiresApproval, prompt? }
PlaybookConnectionNeed   { capability, required, reason, degradedWithout? }
PlaybookArtefact         { kind, title, where }
PlaybookEscalationPoint  { when, becomes, carriesRecommendation }
PlaybookCaps             { maxPerRun?, maxSourcesTracked?, maxWordCount?, maxDecisionsPerRun? }
PlaybookTrigger          { kind, cadence?, defaultLocalTime?, description }
PlaybookProvision        { agentTemplateSlug, skillSlugs[], taskTemplate{name,slug,steps[]},
                           guardrailsAtAdoption, graduatedGuardrails?, workflowGraph? }
PlaybookCatalogEntry     { slug, title, outcome, summary, category, version, icon,
                           trigger, steps[], connections[], artefacts[], escalations[],
                           caps, costBand, estimatedTokensPerRun{min,max}, tags[], provision }
```

`guardrailsAtAdoption` is typed as the existing `AgentGuardrails` so a definition cannot express a
posture the platform cannot enforce, and `validateGuardrails` is the same check the API already
runs.

### 3.6 Entity registration

`PlaybookAdoption` and `PlaybookAdoptionArtifact` are added to all four registration files listed
in §1.5, plus `PlaybookAdoptionRepository` / `PlaybookAdoptionArtifactRepository` in
`packages/agent/src/database/repositories/` and `_repository-inventory.ts`.

---

## 4. API surface

New module: `apps/api/src/catalog/`. Everything is `@UseGuards(AuthSessionGuard)`,
`@ApiBearerAuth()`, `@ApiTags('catalog')`, `@Header('Cache-Control', 'private, no-store')`, and
`@CurrentUser()`-scoped. Throttles use the in-repo `@Throttle({ long: { limit, ttl: 60_000 } })`
idiom.

| Method   | Path                                           | Body / query                                                                | Response                                                                                                                          | Throttle |
| -------- | ---------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET`    | `api/catalog`                                  | —                                                                           | `{ sections: [{ key, total, items[] }] }` — 6 items per section, all five sections, per-section `error?: string` instead of a 500 | 60/min   |
| `GET`    | `api/catalog/playbooks`                        | `category?`, `search?`, `readiness?`, `limit?` (≤50, default 24), `offset?` | `{ items: PlaybookSummary[], total, source: 'builtin'\|'remote'\|'merged', staleSince?: string }`                                 | 60/min   |
| `GET`    | `api/catalog/playbooks/:slug`                  | —                                                                           | `PlaybookDetail` = entry + `readiness` + `adoptions: AdoptionSummary[]`                                                           | 60/min   |
| `POST`   | `api/catalog/playbooks/:slug/preflight`        | `{ workId?, instanceName? }`                                                | `PreflightReport` (§4.2)                                                                                                          | 30/min   |
| `POST`   | `api/catalog/playbooks/:slug/adopt`            | `AdoptPlaybookDto`                                                          | `202 { adoptionId, status: 'provisioning' }`                                                                                      | 10/min   |
| `GET`    | `api/catalog/adoptions`                        | `status?`, `limit?`, `offset?`                                              | `{ items, total }`                                                                                                                | 60/min   |
| `GET`    | `api/catalog/adoptions/:id`                    | —                                                                           | `AdoptionDetail` = row + artefacts (with derived `changed`/`missing`) + 30-day rollup                                             | 60/min   |
| `POST`   | `api/catalog/adoptions/:id/resume`             | —                                                                           | `202 { adoptionId, status }` — only from `failed`                                                                                 | 10/min   |
| `POST`   | `api/catalog/adoptions/:id/pause`              | —                                                                           | `200 AdoptionDetail`                                                                                                              | 30/min   |
| `POST`   | `api/catalog/adoptions/:id/resume-schedule`    | —                                                                           | `200 AdoptionDetail`                                                                                                              | 30/min   |
| `POST`   | `api/catalog/adoptions/:id/retire`             | —                                                                           | `200 AdoptionDetail`                                                                                                              | 30/min   |
| `POST`   | `api/catalog/adoptions/:id/remove-artifacts`   | `{ artifactIds: string[] }` (1–50)                                          | `200 { removed[], alreadyGone[] }`                                                                                                | 10/min   |
| `POST`   | `api/catalog/adoptions/:id/dismiss-graduation` | —                                                                           | `204`                                                                                                                             | 30/min   |
| `DELETE` | `api/catalog/adoptions/:id`                    | —                                                                           | `204` — removes the adoption record only; artefacts are never touched                                                             | 10/min   |

`pause` and `resume-schedule` are separate route names from the provisioning `resume` on purpose:
one resumes a **cadence**, the other resumes a **failed setup**, and collapsing them into one verb
is exactly the kind of ambiguity that produces a wrong-button incident.

**No new workflow, skill, task-template or agent endpoints.** The web layer calls the existing
ones directly.

### 4.1 DTO shapes

`apps/api/src/catalog/catalog.dto.ts`

```
ListPlaybooksDto      { category?: PlaybookCategory; search?: string (2..64);
                        readiness?: 'ready'|'needs_connection'|'adopted';
                        limit?: number (1..50); offset?: number (>=0) }

PreflightDto          { workId?: string (uuid); instanceName?: string (1..200) }

AdoptPlaybookDto      { instanceName: string (1..200);
                        workId?: string (uuid);
                        localTime?: string (/^([01]\d|2[0-3]):[0-5]\d$/);
                        weekday?: 0..6;
                        acknowledgedPlanHash: string (64 hex) }

RemoveArtifactsDto    { artifactIds: string[] (1..50, each uuid) }
```

`acknowledgedPlanHash` is the SHA-256 of the plan the sheet rendered. If the catalogue version
changed between the sheet opening and the confirm, the hash no longer matches and the API answers
`409 plan_changed` with the new plan rather than silently creating something the user did not
read. This is the same "you approved _this_" property the approval queue relies on.

### 4.2 `PreflightReport`

```
{
  readiness: 'ready' | 'needs_connection' | 'blocked' | 'adopted',
  connections: [{ capability, required, satisfiedBy: pluginId | null, reason,
                  connectUrl }],
  blockers:    [{ code: 'adoption_ceiling' | 'copy_limit' | 'no_edit_access',
                  message, currentCount, limit }],
  plan:        { instanceName, planHash, items: [{ type, name, detail }] },
  collisions:  [{ type: 'agent_name', requested, suggested }],
  unknown:     string[]        // checks that did not resolve inside the 2 s budget
}
```

`connections[].satisfiedBy` returns a plugin id **as data for display**, resolved by the facade
from the capability. No controller, service or component in this epic contains a plugin id
literal (Constitution II).

### 4.3 Error codes

| HTTP  | Code                 | When                                                          |
| ----- | -------------------- | ------------------------------------------------------------- |
| `400` | `invalid_local_time` | `localTime` is not `HH:MM`                                    |
| `403` | `no_edit_access`     | Caller may browse but not adopt                               |
| `404` | `playbook_not_found` | Slug is not in the resolved catalogue                         |
| `404` | `adoption_not_found` | Adoption belongs to another user                              |
| `409` | `adoption_in_flight` | The partial unique index rejected the insert (FR-36)          |
| `409` | `plan_changed`       | `acknowledgedPlanHash` mismatch                               |
| `409` | `copy_limit_reached` | 3 non-retired copies of this slug (FR-38)                     |
| `409` | `adoption_ceiling`   | 25 active adoptions (FR-37)                                   |
| `409` | `not_failed`         | `resume` called on an adoption that is not `failed`           |
| `422` | `connection_missing` | A required capability has no enabled provider at confirm time |

---

## 5. Web

### 5.1 Routes

| Route                       | File                                                     | Kind                                                                     |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/catalog`                  | `apps/web/src/app/[locale]/(dashboard)/catalog/page.tsx` | RSC — one `Promise.all` of five independently `.catch()`-guarded fetches |
| `/catalog/playbooks/[slug]` | `.../catalog/playbooks/[slug]/page.tsx`                  | RSC                                                                      |
| `/catalog/adoptions`        | `.../catalog/adoptions/page.tsx`                         | RSC                                                                      |
| `/catalog/adoptions/[id]`   | `.../catalog/adoptions/[id]/page.tsx`                    | RSC                                                                      |
| `/catalog/workflows`        | `.../catalog/workflows/page.tsx`                         | RSC                                                                      |
| `/catalog/workflows/[id]`   | `.../catalog/workflows/[id]/page.tsx`                    | RSC                                                                      |

### 5.2 Components — `apps/web/src/components/catalog/`

| Component                                   | Client? | Responsibility                                                                                                                                                       |
| ------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CatalogShell.tsx`                          | client  | Owns the search string, the two chip rows and keyboard handling (FR-6, FR-61). Nothing else is client-side on the index.                                             |
| `CatalogSection.tsx`                        | server  | Heading, `See all (N)`, empty state via `EmptyState`, per-section error slot (FR-4).                                                                                 |
| `PlaybookCard.tsx`                          | server  | Title, outcome, cadence, cost band, readiness chip. One focusable element with a composed accessible name (FR-62).                                                   |
| `ReadinessChip.tsx`                         | client  | `Checking…` → resolved label. Text always present; colour is decoration (FR-62).                                                                                     |
| `PlaybookDetail.tsx`                        | server  | The eight labelled blocks in §6.6 of the spec.                                                                                                                       |
| `PlaybookSetupSheet.tsx`                    | client  | The three editable fields, the itemised plan, the plan hash, the confirm. Headless UI `Dialog` + focus trap, following `HelpDrawer.tsx`'s prop contract.             |
| `AdoptionProgress.tsx`                      | client  | The 5-step progress readout. Polls `GET api/catalog/adoptions/:id` at **2 s** while `provisioning`, stops on any terminal state, and hard-stops after **150** polls. |
| `AdoptionCard.tsx`                          | server  | Status, next run, 30-day rollup, artefact links, `Pause`/`Retire`/`⋯`.                                                                                               |
| `AdoptionArtifactList.tsx`                  | server  | Reused by the failure panel and the removal sheet.                                                                                                                   |
| `RemoveArtifactsSheet.tsx`                  | client  | All-unchecked-by-default, live `Remove N items` label, `Changed since setup` flags.                                                                                  |
| `GraduationSuggestion.tsx`                  | client  | The single non-blocking FR-49 prompt.                                                                                                                                |
| `WorkflowList.tsx` / `WorkflowRunTrace.tsx` | server  | The Workflows section and one run's trace.                                                                                                                           |
| `TaskTemplateMiniCard.tsx`                  | server  | Compact variant over the existing task-template client.                                                                                                              |
| `StartingPointsRow.tsx`                     | server  | Three counted links into the existing template pages.                                                                                                                |

### 5.3 Data fetching

- **Index:** server-side `Promise.all` of `catalogAPI.getIndex()`, `skillsAPI.catalog({limit:6})`,
  `workflowsAPI.list({limit:6})`, `taskTemplatesAPI.list()`, `templatesAPI.counts()` — each
  `.catch()` to a per-section error marker so one failure cannot take the page down (FR-4). This
  is the same shape the dashboard layout already uses.
- **Search:** client-side filtering of the already-loaded 6-per-section set until the query
  matches nothing in the loaded set, at which point one BFF call widens the search. This keeps
  FR-9 (one round trip after first paint) true for the common case.
- **Readiness:** a single BFF call after paint, so the cards render immediately and chips resolve
  in place without layout shift (spec §6.3).
- **Adoption:** server actions in `apps/web/src/app/actions/catalog.ts`, returning
  `{ success, …, error }` result objects rather than throwing — the house pattern in
  `apps/web/src/app/actions/skills.ts`.

### 5.4 New BFF proxies — `apps/web/src/app/api/catalog/`

`route.ts` (index), `playbooks/route.ts`, `playbooks/[slug]/route.ts`,
`playbooks/[slug]/preflight/route.ts`, `adoptions/route.ts`, `adoptions/[id]/route.ts`.
Client-side search and the adoption poll go through these; every mutation goes through a server
action instead. Each proxy forwards the active scope header and returns the upstream status
verbatim (no 200-with-empty-array masking — the sections need to distinguish "empty" from
"broken").

### 5.5 New API clients — `apps/web/src/lib/api/`

`catalog.ts` (`import 'server-only'`, built on `serverFetch`/`serverMutation`) and
`workflows.ts` (the same, over the existing `api/workflows` routes).

### 5.6 Sidebar and routes

`DashboardSidebar.tsx` gains one entry after `templates`, labelled from
`dashboard.sidebar.navigation.catalog`. `ROUTES` gains the five constants in §1.3. No existing
entry moves, and no existing route constant changes value.

---

## 6. Background work

**Constitution IV — every one of these goes through a `*_DISPATCHER` DI symbol. No call site
imports a vendor SDK.**

### 6.1 New dispatcher

| File                                                             | Contents                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/tasks/playbook-adoption.types.ts`            | `PlaybookAdoptionPayload { adoptionId: string; userId: string }` — ids only, so an older worker silently drops nothing load-bearing                                                                       |
| `packages/agent/src/tasks/playbook-adoption-dispatcher.ts`       | `PlaybookAdoptionDispatcher` interface + `export const PLAYBOOK_ADOPTION_DISPATCHER = Symbol('PLAYBOOK_ADOPTION_DISPATCHER')`; returns `Promise<string \| null>`, `null` when the runtime is unconfigured |
| `packages/agent/src/tasks/_tasks-symbols.ts`                     | Name appended to the canonical symbol list                                                                                                                                                                |
| `packages/agent/src/tasks/job-runtime.providers.ts`              | Symbol wired through the binding factory                                                                                                                                                                  |
| `packages/agent/src/tasks/index.ts`                              | Barrel export                                                                                                                                                                                             |
| `packages/tasks/src/dispatchers/playbook-adoption.dispatcher.ts` | Trigger.dev adapter, modelled line-for-line on `workflow-run.dispatcher.ts`                                                                                                                               |

When the dispatcher returns `null`, the adoption row is immediately marked `failed` with
`failureCode: 'dispatch_failed'` — never left `provisioning` for a sweeper to find. That mirrors
how `WorkflowRunsService.start` treats an unconfigured runtime, and it is why an install with no
job runtime configured gets an honest error instead of a spinner.

### 6.2 New tasks

| Task id                     | File                                                                 | Shape                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playbook-adoption`         | `packages/tasks/src/tasks/trigger/playbook-adoption.task.ts`         | `task({ id, maxAttempts: 3 })`. `withWorkerContext`, `assertUuid` on both ids, then `PlaybookAdoptionExecutorService.execute(adoptionId)`. Retryable because every step is keyed off an artefact row, so a redelivery resumes rather than duplicates.                                                     |
| `playbook-adoption-sweeper` | `packages/tasks/src/tasks/trigger/playbook-adoption-sweeper.task.ts` | `schedules.task({ id, cron: '11 * * * *' })` — hourly at :11, a free slot (taken: `*/1`, `*/2`, `*/5`, `3/5`, `23 */2`, `37 * * * *`, `5 0`, `15 7`, `17 3`, `42 3`, `41 4`, `37 8`). Moves any adoption `provisioning` for more than **15 minutes** to `failed` with `failureCode: 'timed_out'` (FR-34). |

Worker module: `packages/tasks/src/trigger/worker/modules/trigger-playbook-adoption.module.ts`,
following `trigger-workflow-run.module.ts`.

### 6.3 The executor

`packages/agent/src/services/playbook-adoption-executor.service.ts` runs the six steps in §2's
diagram. Each step:

1. Looks for its own `playbook_adoption_artifacts` row; returns early if present.
2. Performs its write through the **existing** service (`AgentTemplatesService`,
   `SkillsService.installFromCatalog` + `createBinding`, `TaskTemplatesService.create`,
   `AgentsService.update` for guardrails, `AgentsService.update` for the heartbeat cadence or
   `InboundTriggersService.create`, `WorkflowsService.create`).
3. Writes its artefact row and bumps `stepIndex` in the same transaction.

A step that throws sets `status: 'failed'`, `failureCode`, `failureDetail` and stops. It never
rolls back earlier steps — the spec's failure panel (§6.9) shows what exists and lets the human
choose (NN: no removal without confirmation).

### 6.4 What does **not** become a background job

Preflight, catalogue reads, pause, resume-schedule, retire and artefact removal are all
synchronous. Removal touches at most 50 rows through existing owner-scoped services and must
report per-item results to the sheet that asked; deferring it would trade a truthful result for
nothing.

---

## 7. Plugin boundaries

**Constitution I — the catalogue source is external content, therefore it is a plugin.**

| Piece                | Where                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capability constant  | `packages/plugin/src/contracts/facade-capabilities.ts` → `PLAYBOOK_PROVIDER: 'playbook-provider'`                                                                                                                                                                                                |
| Capability interface | `packages/plugin/src/contracts/capabilities/playbook-provider.interface.ts` — `IPlaybookProviderPlugin { listPlaybooks(opts): Promise<{ entries, total }>; getPlaybook(slug): Promise<PlaybookCatalogEntry \| null> }`, plus the entry types re-exported from `@ever-works/contracts`            |
| Facade               | `packages/agent/src/facades/playbook-catalog.facade.ts` — `PlaybookCatalogFacadeService extends BaseFacadeService`, `CAPABILITY = PLUGIN_CAPABILITIES.PLAYBOOK_PROVIDER`, fans out across enabled providers, dedupes by slug with the version rule (FR-20), page size 200, hard cap 2000 entries |
| First-party plugin   | `packages/plugins/everworks-playbooks/` — ESM, tsup, Vitest. `everworks.plugin`: `id: 'everworks-playbooks'`, `category: 'utility'`, `capabilities: ['playbook-provider']`, `autoEnable: true`, `defaultForCapabilities: ['playbook-provider']`, `distribution: 'registry'`                      |
| Built-in catalogue   | `packages/plugins/everworks-playbooks/src/builtin-catalog.ts` — the 8 entries, frozen, typed, with an integrity spec pinning every `agentTemplateSlug` against `AGENT_TEMPLATES` and every `skillSlugs` entry against the first-party skill catalogue                                            |

**Constitution II — no hardcoded plugin ids outside a plugin.** The readiness service asks
`PluginRegistryService` "which enabled plugin provides capability `search` for this scope" and
renders whatever comes back. `apps/api/src/catalog/**` and `apps/web/src/components/catalog/**`
contain zero plugin id literals; an ESLint-visible grep for `'everworks-` under those two trees is
part of the review checklist.

**The 8 built-in playbooks** (`slug` → required capabilities):

| Slug                        | Title                       | Requires                                  |
| --------------------------- | --------------------------- | ----------------------------------------- |
| `weekly-operations-report`  | Weekly operations report    | —                                         |
| `daily-decision-brief`      | Morning decision brief      | —                                         |
| `directory-freshness-sweep` | Directory freshness sweep   | —                                         |
| `knowledge-gap-harvest`     | Knowledge gap harvest       | —                                         |
| `release-checklist`         | Release checklist on deploy | — (uses an inbound trigger)               |
| `content-refresh-queue`     | Content refresh queue       | `search`                                  |
| `market-watch-brief`        | Market watch brief          | `search` (+ optional `content-extractor`) |
| `inbox-triage-drafts`       | Inbox triage with drafts    | `email-outbound`                          |

Five of eight require nothing external (FR-18).

**Remote source.** The plugin may additionally read a hosted manifest with a **3600 s** TTL, an
in-memory cache, stale-serve for up to **24 h**, and the same sanitisation the skills plugin
applies (slug allow-list, HTML strip, length caps). It is off unless configured, and the built-in
catalogue is always merged underneath — the section can never be empty because a network call
failed (FR-19).

---

## 8. i18n

New namespace `dashboard.catalogPage` in `apps/web/messages/en.json`, plus one key added to
`dashboard.sidebar.navigation` and one to `metadata.pages`.

**Every leaf name is camelCase and contains no literal `.`** — a dot in a leaf name is rejected by
the i18n runtime at render time and takes out whole e2e shards.

```
dashboard.sidebar.navigation.catalog                 "Catalog"
metadata.pages.catalog                               "Catalog"

dashboard.catalogPage.title                          "What you can do"
dashboard.catalogPage.subtitle
dashboard.catalogPage.searchPlaceholder
dashboard.catalogPage.searchNoResults
dashboard.catalogPage.searchClear
dashboard.catalogPage.firstVisitBanner
dashboard.catalogPage.seeAll                         "See all ({count})"
dashboard.catalogPage.staleCatalogue
dashboard.catalogPage.retry

dashboard.catalogPage.sections.playbooks
dashboard.catalogPage.sections.skills
dashboard.catalogPage.sections.workflows
dashboard.catalogPage.sections.taskTemplates
dashboard.catalogPage.sections.startingPoints

dashboard.catalogPage.empty.playbooks
dashboard.catalogPage.empty.skills
dashboard.catalogPage.empty.skillsAction
dashboard.catalogPage.empty.workflows
dashboard.catalogPage.empty.workflowsAction
dashboard.catalogPage.empty.taskTemplates
dashboard.catalogPage.empty.taskTemplatesAction
dashboard.catalogPage.error.section
dashboard.catalogPage.error.sectionAction

dashboard.catalogPage.categories.reporting|content|operations|research|inbox
dashboard.catalogPage.filters.all
dashboard.catalogPage.filters.readyNow
dashboard.catalogPage.filters.needsConnection
dashboard.catalogPage.filters.alreadySetUp

dashboard.catalogPage.readiness.checking
dashboard.catalogPage.readiness.ready
dashboard.catalogPage.readiness.needsConnection      "Needs {count} connection(s)"
dashboard.catalogPage.readiness.adopted
dashboard.catalogPage.readiness.notAvailable
dashboard.catalogPage.readiness.blockedCeiling
dashboard.catalogPage.readiness.blockedCopyLimit

dashboard.catalogPage.cost.low|medium|high
dashboard.catalogPage.cost.tooltip

dashboard.catalogPage.detail.readinessHeading
dashboard.catalogPage.detail.whenItRuns
dashboard.catalogPage.detail.whatItCosts
dashboard.catalogPage.detail.theSteps
dashboard.catalogPage.detail.whatItProduces
dashboard.catalogPage.detail.whenItAsks
dashboard.catalogPage.detail.itsOwnLimits
dashboard.catalogPage.detail.whatItMayDoAlone
dashboard.catalogPage.detail.asksYouFlag
dashboard.catalogPage.detail.optionalConnection
dashboard.catalogPage.detail.connectAction
dashboard.catalogPage.detail.setItUp
dashboard.catalogPage.detail.openAdoption

dashboard.catalogPage.setup.heading
dashboard.catalogPage.setup.nameLabel
dashboard.catalogPage.setup.runLabel
dashboard.catalogPage.setup.scopeLabel
dashboard.catalogPage.setup.willCreate
dashboard.catalogPage.setup.reassurance
dashboard.catalogPage.setup.duplicateWarning
dashboard.catalogPage.setup.collisionNote
dashboard.catalogPage.setup.cancel
dashboard.catalogPage.setup.confirm

dashboard.catalogPage.progress.creatingAgent
dashboard.catalogPage.progress.installingSkills
dashboard.catalogPage.progress.buildingTaskTemplate
dashboard.catalogPage.progress.settingGuardrails
dashboard.catalogPage.progress.scheduling
dashboard.catalogPage.progress.stepCounter                "{done} of {total}"

dashboard.catalogPage.adoption.active
dashboard.catalogPage.adoption.paused
dashboard.catalogPage.adoption.retired
dashboard.catalogPage.adoption.failedHeading
dashboard.catalogPage.adoption.createdSoFar
dashboard.catalogPage.adoption.tryAgain
dashboard.catalogPage.adoption.leaveAsIs
dashboard.catalogPage.adoption.pause
dashboard.catalogPage.adoption.resume
dashboard.catalogPage.adoption.retire
dashboard.catalogPage.adoption.retireConfirm
dashboard.catalogPage.adoption.nextRun
dashboard.catalogPage.adoption.rollup                     "{runs} runs in the last 30 days · {cost}"
dashboard.catalogPage.adoption.noRunsYet
dashboard.catalogPage.adoption.repeatedFailure

dashboard.catalogPage.remove.heading
dashboard.catalogPage.remove.nothingUnlessTicked
dashboard.catalogPage.remove.changedSinceSetup
dashboard.catalogPage.remove.outputKept
dashboard.catalogPage.remove.confirm                      "Remove {count} items"
dashboard.catalogPage.remove.alreadyGone

dashboard.catalogPage.graduation.prompt
dashboard.catalogPage.graduation.notYet
dashboard.catalogPage.graduation.review

dashboard.catalogPage.workflows.subtitle
dashboard.catalogPage.workflows.run
dashboard.catalogPage.workflows.queued
dashboard.catalogPage.workflows.archivedRefused
dashboard.catalogPage.workflows.reactivate
dashboard.catalogPage.workflows.nodes                     "{count} nodes"
dashboard.catalogPage.workflows.runs                      "{count} runs"
dashboard.catalogPage.workflows.neverRun
dashboard.catalogPage.workflows.traceHeading
dashboard.catalogPage.workflows.outputTruncated
```

Playbook **content** (titles, outcomes, step text) ships from the catalogue entry, not from
`en.json` — a definition supplied by a plugin cannot have translation keys in the web bundle. v1
renders catalogue content in the language the provider supplied and marks those blocks
`lang="en"`. That is a deliberate, stated limitation, not an oversight; localising catalogue
content needs a provider-side mechanism and is out of scope.

After English lands, run the locale parity sync so all 20 sibling files carry the full
`dashboard.catalogPage` path — a **missing parent key collapses the whole subtree**, so a partial
merge is worse than none.

---

## 9. Telemetry and failure modes

### 9.1 Events (PostHog, via the existing analytics service)

| Event                                                   | Properties                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `catalog.viewed`                                        | `sectionsRendered`, `sectionsErrored`, `playbookCount`, `readyCount`                  |
| `catalog.playbook_opened`                               | `slug`, `version`, `readiness`                                                        |
| `catalog.preflight_run`                                 | `slug`, `readiness`, `missingCapabilities` (names only), `durationMs`, `unknownCount` |
| `catalog.adoption_started`                              | `slug`, `version`, `scheduleKind`, `plannedItemCount`                                 |
| `catalog.adoption_succeeded`                            | `slug`, `version`, `durationMs`, `createdItemCount`                                   |
| `catalog.adoption_failed`                               | `slug`, `version`, `failureCode`, `stepIndex`                                         |
| `catalog.adoption_paused` / `_retired`                  | `slug`, `daysActive`, `runCount30d`                                                   |
| `catalog.artifacts_removed`                             | `slug`, `removedCount`, `alreadyGoneCount`, `changedCount`                            |
| `catalog.graduation_shown` / `_accepted` / `_dismissed` | `slug`, `daysActive`, `approvalsGranted`                                              |
| `catalog.workflow_run_started`                          | `workflowId`, `nodeCount`, `status`                                                   |

No event carries an instance name, a Work name, a document title or any plugin credential. Slugs
and counts only.

### 9.2 Activity log

Adoption, pause, retire and artefact removal each write one `activity_log` row naming the playbook
slug, the instance name and the affected row count. Removal names each removed artefact's **type
and id**, never its content.

### 9.3 Failure modes

| Failure                                                   | Behaviour                                                                                                       | Surfaced as                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Playbook provider unreachable                             | Built-in catalogue serves; stale-serve up to 24 h                                                               | Quiet banner (spec §6.5)                                     |
| Every catalogue source empty                              | Section empty state; the other four sections unaffected                                                         | Empty state                                                  |
| Skills catalogue unreachable                              | Skills section error slot; playbook adoption fails at step 2 with `skill_install_failed` and keeps what it made | Section error / failure panel                                |
| Job runtime unconfigured                                  | `adopt` immediately marks the adoption `failed` with `dispatch_failed`                                          | Failure panel with a plain reason                            |
| Provisioning worker dies mid-step                         | `stepIndex` unchanged; task retries (≤3); if all fail the sweeper moves it to `failed` at 15 min                | Failure panel + `Try again`                                  |
| Two simultaneous adopts                                   | Partial unique index rejects the second insert                                                                  | `409 adoption_in_flight` with a link                         |
| Catalogue version bumped between sheet and confirm        | Plan hash mismatch                                                                                              | `409 plan_changed`, sheet re-renders the new plan            |
| Required connection removed between preflight and confirm | Re-checked at confirm                                                                                           | `422 connection_missing`                                     |
| Artefact deleted outside this flow                        | Derived `missing` on read                                                                                       | `already gone` in the removal result                         |
| Artefact renamed outside this flow                        | Derived `changed` on read                                                                                       | `Changed since setup` flag                                   |
| Workflow run dispatch returns `null`                      | Run row marked dispatch-failed by the existing service                                                          | Row shows failed, not a permanent `Queued`                   |
| Readiness check exceeds 2 s                               | Marked `unknown` in the report                                                                                  | Chip reads `Checking…` then falls back to the cautious label |

### 9.4 Rate limiting and abuse

`adopt`, `resume`, `remove-artifacts` and `DELETE` are all 10/min. Preflight is 30/min because it
is read-only and the sheet may re-run it. The adoption ceiling (25) and copy limit (3) are the
real backstop: a runaway client cannot create unbounded agents.

---

## 10. Test plan

### 10.1 Unit — plugin package (Vitest)

| File                                                                          | Covers                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/plugins/everworks-playbooks/src/everworks-playbooks.plugin.spec.ts` | `listPlaybooks` paging, `getPlaybook` miss, remote-source failure falls back to built-ins, stale-serve window, sanitisation (bad slug dropped, long title truncated, HTML stripped)                                                                                                  |
| `packages/plugins/everworks-playbooks/src/builtin-catalog.spec.ts`            | All 8 entries validate against the contract; ≥5 declare no required connection; every `agentTemplateSlug` exists in `AGENT_TEMPLATES`; every skill slug exists in the first-party skill catalogue; every `guardrailsAtAdoption` passes `validateGuardrails`; every step count is 2–8 |

### 10.2 Unit — agent package (Jest)

| File                                                                                | Covers                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/src/facades/__tests__/playbook-catalog.facade.spec.ts`              | Fan-out across two mock providers, slug dedupe, version-wins rule (FR-20), hard cap, a throwing provider does not poison the union                                                                                                                                                         |
| `packages/agent/src/services/__tests__/playbook-readiness.service.spec.ts`          | Each of the four readiness states, ceiling at exactly 25, copy limit at exactly 3, name collision suggestion, 2 s partial result                                                                                                                                                           |
| `packages/agent/src/services/__tests__/playbook-adoption-plan.spec.ts`              | `planAdoption` is the single source of both the sheet list and the executor steps; plan hash stability; hash changes when the catalogue version changes                                                                                                                                    |
| `packages/agent/src/services/__tests__/playbook-adoption-executor.service.spec.ts`  | Six steps in order; each idempotent (re-run creates nothing new); failure at step 2 leaves steps 1's artefacts intact and status `failed`; resume completes without duplication; guardrails written are always `require_approval` (FR-39); an existing Agent is never reconfigured (FR-41) |
| `packages/agent/src/services/__tests__/playbook-adoption-lifecycle.service.spec.ts` | pause/resume-schedule/retire transitions and the illegal ones; artefact removal per-item results; `already gone`; derived `changed`/`missing`; graduation eligibility at exactly 14 days / 0 rejections and the 30-day dismissal                                                           |
| `packages/agent/src/database/database.module.spec.ts` (existing)                    | Extended — both new entities registered in all four inventory files                                                                                                                                                                                                                        |

### 10.3 Controller specs (Jest, `apps/api`)

| File                                                         | Covers                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/catalog/catalog.controller.spec.ts`            | Auth guard; index returns five sections; one failing source yields a per-section error not a 500; list filters and paging clamps; detail 404 on unknown slug                                                                   |
| `apps/api/src/catalog/playbook-adoptions.controller.spec.ts` | `adopt` returns 202 and never blocks; every error code in §4.3; plan-hash mismatch → 409; ceiling → 409; copy limit → 409; `resume` on a non-failed adoption → 409; cross-user adoption → 404; `remove-artifacts` clamps at 50 |
| `apps/api/src/catalog/catalog.module.di-contract.spec.ts`    | The module resolves with the facade and dispatcher symbols bound, following the existing `tasks.module.di-contract.spec.ts`                                                                                                    |

### 10.4 Web unit (Vitest)

| File                                                                 | Covers                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/src/components/catalog/PlaybookCard.unit.spec.tsx`         | Accessible name composition; readiness rendered as text, not colour alone       |
| `apps/web/src/components/catalog/RemoveArtifactsSheet.unit.spec.tsx` | All-unchecked default; live count in the button label; disabled at zero         |
| `apps/web/src/components/catalog/CatalogShell.unit.spec.tsx`         | `/` focus, 2-char minimum, 250 ms debounce, per-section counts, no-results copy |

### 10.5 e2e (Playwright, `apps/web/e2e/`)

| File                                            | Golden path                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow-capability-catalog-browse.spec.ts`        | Sidebar → index; five sections; `See all` counts; search narrows all sections; category + readiness chips combine; a failing section degrades alone                                                              |
| `flow-playbook-adoption.spec.ts`                | Detail → `Set it up` → sheet lists exactly N items → `Create it` → `provisioning` → `active`; the created Agent, skills, task template and schedule exist and match the sheet; guardrails are `require_approval` |
| `flow-playbook-preflight-blocked.spec.ts`       | Playbook needing `search` shows `Not ready`, names the capability, disables the button; enabling a provider flips it to `Ready` inside 60 s; preflight created nothing                                           |
| `flow-playbook-adoption-failure-resume.spec.ts` | Force a step-2 failure; failure panel lists what exists; `Try again` completes without a second Agent; removal sheet defaults to unchecked and reports `already gone`                                            |
| `flow-playbook-limits.spec.ts`                  | 3-copy limit and 25-adoption ceiling both disable with their exact copy                                                                                                                                          |
| `flow-catalog-workflows-run.spec.ts`            | Workflows list; `Run` returns queued in under a second; trace shows nodes, outcomes, edges and decisions; archived refuses with the reactivate message                                                           |
| `flow-catalog-access-readonly.spec.ts`          | A read-only member sees no `Set it up`, `Pause`, `Retire`, `Run`, `Use it`                                                                                                                                       |
| `accessibility` (extend the existing deep pass) | Index and detail page report no serious/critical violations; full keyboard walk incl. focus return from both sheets                                                                                              |

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green on its own.

### P1 — The catalogue, read-only (no new tables)

- Capability constant, interface, facade, first-party plugin with the 8 built-ins.
- `apps/api/src/catalog/` with `GET /api/catalog`, `GET /api/catalog/playbooks`,
  `GET /api/catalog/playbooks/:slug`, `POST …/preflight`. No adoption endpoints.
- `/catalog` index with all five sections, search, both chip rows, all empty and error states.
- `/catalog/playbooks/[slug]` detail with the eight labelled blocks and a readiness panel; the
  primary button links to a manual path (`Build it yourself →` pointing at `/agents/new`) instead
  of adopting.
- `/catalog/workflows` + `/catalog/workflows/[id]` — list, run, trace. **This alone closes the
  "saved workflows have no UI" gap** and is the reason P1 ships value without P2.
- Sidebar entry, `ROUTES`, the full `dashboard.catalogPage` namespace, locale parity sync.
- Tests: §10.1, §10.2 (facade + readiness), §10.3 (`catalog.controller.spec.ts`), §10.4,
  `flow-capability-catalog-browse`, `flow-catalog-workflows-run`, `flow-playbook-preflight-blocked`,
  `flow-catalog-access-readonly`.

_Shippable because:_ browsing, readiness and the workflows surface are all useful with nothing
persisted. Zero schema change, zero migration, zero background work.

### P2 — Adoption

- Both entities, the four registration files, both repositories, the migration.
- Dispatcher symbol, Trigger.dev adapter, `playbook-adoption` task, worker module, executor
  service, sweeper task.
- Adoption endpoints (`adopt`, `resume`, `pause`, `resume-schedule`, `retire`, list, detail).
- Setup sheet, progress readout, adoption card, failure panel, adoptions list page.
- `Already set up` chip on cards; the detail page's primary button becomes `Set it up`.
- Tests: §10.2 (plan, executor, lifecycle), §10.3 (`playbook-adoptions.controller.spec.ts`,
  DI contract), `flow-playbook-adoption`, `flow-playbook-adoption-failure-resume`,
  `flow-playbook-limits`.

_Shippable because:_ it strictly adds a button to a page that already works. If P2 is reverted,
P1's catalogue is unaffected.

### P3 — Living with it

- `remove-artifacts` endpoint and sheet, with the `changed` / `missing` derivation.
- The 30-day run + cost rollup on adoption cards, and the reverse "created by" line on the Agent
  page (FR-50).
- Repeated-failure warning (FR-48).
- Graduation suggestion and its 30-day dismissal (FR-49).
- Optional remote catalogue source in the plugin, with the stale banner.
- "Hand the setup to an agent" for playbooks that declare free-text inputs: pre-fills the agent
  chat composer with the setup brief and sends nothing.

_Shippable because:_ every item is additive to an adoption that already works.

---

## 12. Constitution compliance

| Gate                                     | Status | Why                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I — Plugin-first**                     | ✅     | The catalogue source is a new `playbook-provider` capability with a first-party plugin package (`packages/plugins/everworks-playbooks/`); core code reaches it only through `PlaybookCatalogFacadeService`.                             |
| **II — Capability-driven**               | ✅     | Playbooks declare **capabilities** (`search`, `email-outbound`), never provider ids. Readiness resolves them through the registry. No plugin id literal exists under `apps/api/src/catalog/**` or `apps/web/src/components/catalog/**`. |
| **III — Source-of-truth repos**          | ✅     | Nothing here writes Work content. The artefacts playbooks produce (Knowledge Base documents) go through the existing KB path, which already mirrors to the user's data repo.                                                            |
| **IV — Job runtime**                     | ✅     | Provisioning and the stuck sweep both go through `PLAYBOOK_ADOPTION_DISPATCHER`; no call site imports `@trigger.dev/sdk`; `adopt` returns 202 immediately.                                                                              |
| **V — Forward-only migrations**          | ✅     | `apps/api/src/migrations/1791210000000-CreatePlaybookAdoptions.ts` ships in the same PR as both entities. Creates only; alters nothing; `down()` drops in reverse.                                                                      |
| **VI — Tests first-class**               | ✅     | 14 named spec files across Vitest (plugin, web unit), Jest (agent, api) and Playwright (7 e2e flows), listed in §10 and enumerated as tasks.                                                                                            |
| **VII — Secrets**                        | ✅     | No new setting holds a credential. The optional remote-source token, if configured, is declared `x-secret: true` in the plugin's settings schema and never returned. Telemetry carries slugs and counts only.                           |
| **VIII — Canonical plugin list**         | ✅     | The new plugin is added to `docs/plugin-system/built-in-plugins.md` and to no other count.                                                                                                                                              |
| **IX — Behaviour-first spec**            | ✅     | `spec.md` names no class, file or endpoint. Every path, DTO and symbol lives here.                                                                                                                                                      |
| **X — Backwards compatibility**          | ✅     | Every route is new. No existing DTO field is renamed or removed. Adding `PLAYBOOK_PROVIDER` to `PLUGIN_CAPABILITIES` is additive; existing plugins are unaffected.                                                                      |
| **Program rule #1 — additive**           | ✅     | Five existing template surfaces keep their routes and behaviour. One sidebar entry added, none moved.                                                                                                                                   |
| **Program rule #2 — no duplicate nouns** | ✅     | Two new nouns, justified in spec §5.1, and added to the program vocabulary table in the same PR (tasks T041). Everything else reuses Agent, Skill, Task, Schedule, Trigger, Approval, Escalation, Run, Plugin, Workflow.                |
| **Program rule #9 — what did it cost**   | ✅     | Every playbook card carries a token estimate before adoption; every adoption carries a 30-day run count and cost from run receipts after it.                                                                                            |

---

## 13. References

- Program overview: [`../README.md`](../README.md)
- Existing substrate (S1 workflows, S12 task templates): [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md)
- Constitution: [`../../../../.specify/memory/constitution.md`](../../../../.specify/memory/constitution.md)
- Skills shelf (dependency): [`../AW-08-skills-shelf/`](../AW-08-skills-shelf/)
- Decision queue (where escalation points land): [`../AW-03-decision-queue/`](../AW-03-decision-queue/)
- Runs & receipts (where the cost rollup comes from): [`../AW-09-runs-receipts/spec.md`](../AW-09-runs-receipts/spec.md)
- Schedules & calendar (where an adopted cadence appears): [`../AW-10-schedules-calendar/`](../AW-10-schedules-calendar/)
- Knowledge library (where most artefacts land): [`../AW-06-knowledge-library/spec.md`](../AW-06-knowledge-library/spec.md)
- Existing schedules aggregation spec: [`../../schedules/spec.md`](../../schedules/spec.md)
- Existing templates catalogue spec: [`../../templates-catalog/`](../../templates-catalog/)
- Existing skills spec: [`../../skills/`](../../skills/)
