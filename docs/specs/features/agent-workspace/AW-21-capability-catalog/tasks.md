# AW-21 — Capability & playbook catalogue · Tasks

**Epic:** `AW-21-capability-catalog` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-09-06

Execute top to bottom. Every task names the files it creates or modifies and what "done" means.
`[P1]` / `[P2]` / `[P3]` is the phase from [plan.md §11](./plan.md#11-phasing); each phase leaves
`develop` green on its own.

Conventions this repo enforces, applied to every task below without repeating them:
kebab-case filenames · tabs, width 4, single quotes, semicolons, no trailing commas · Jest in
`packages/agent` and `apps/api`, Vitest in `packages/plugin*` and web unit specs, Playwright in
`apps/web/e2e` · conventional commits (`feat:` / `test:` / `chore:`).

---

## Phase 1 — The catalogue, read-only

### Contracts and the plugin capability

**T001 [P1] — Playbook contract types**
Create `packages/contracts/src/playbook/playbook-catalog.types.ts` and
`packages/contracts/src/playbook/index.ts`; export from `packages/contracts/src/index.ts`.
Define exactly the types in [plan.md §3.5](./plan.md#35-new-contract-types-no-schema):
`PlaybookTriggerKind`, `PlaybookCategory`, `PlaybookCostBand`, `PlaybookArtefactKind`,
`PlaybookEscalationTarget`, `PlaybookStep`, `PlaybookConnectionNeed`, `PlaybookArtefact`,
`PlaybookEscalationPoint`, `PlaybookCaps`, `PlaybookTrigger`, `PlaybookProvision`,
`PlaybookCatalogEntry`. All fields `readonly`. `guardrailsAtAdoption` is typed against the
existing `AgentGuardrails` shape.
**Done:** `pnpm --filter @ever-works/contracts build` emits declarations; nothing imports
`@ever-works/agent` from `packages/contracts`.

**T002 [P1] — Playbook validator**
Add `validatePlaybookEntry(value: unknown): string | null` to
`packages/contracts/src/playbook/playbook-catalog.types.ts`, returning the first violation:
slug matches `^[a-z0-9][a-z0-9-]{0,63}$`; 2–8 steps; title ≤ 120, outcome ≤ 200, summary ≤ 600,
step title ≤ 120, reason ≤ 200; `version` is `MAJOR.MINOR.PATCH`; category and cost band are known
values. Add `comparePlaybookVersions(a, b): -1|0|1`.
**Done:** `packages/contracts/src/playbook/__tests__/playbook-catalog.spec.ts` (Vitest) covers
every violation branch and the version comparator, including `1.10.0 > 1.9.0`.

**T003 [P1] — Capability constant**
Modify `packages/plugin/src/contracts/facade-capabilities.ts`: append
`PLAYBOOK_PROVIDER: 'playbook-provider'` to `PLUGIN_CAPABILITIES` with a comment naming this epic.
**Done:** appended, nothing reordered or removed.

**T004 [P1] — Capability interface**
Create `packages/plugin/src/contracts/capabilities/playbook-provider.interface.ts` defining
`IPlaybookProviderPlugin` with `listPlaybooks(options): Promise<{ entries; total }>` and
`getPlaybook(slug, settings?): Promise<PlaybookCatalogEntry | null>`, plus
`PlaybookCatalogListOptions { limit; offset; category?; search?; settings? }`. Export from
`packages/plugin/src/contracts/capabilities/index.ts`.
**Done:** `pnpm --filter @ever-works/plugin build` passes.

**T005 [P1] — First-party plugin package skeleton**
Create `packages/plugins/everworks-playbooks/` with `package.json`, `tsup.config.ts`,
`tsconfig.json`, `vitest.config.ts`, `src/index.ts`, modelled file-for-file on
`packages/plugins/everworks-skills/`. `everworks.plugin` block: `id: 'everworks-playbooks'`,
`name: 'Ever Works Playbooks'`, `category: 'utility'`, `capabilities: ['playbook-provider']`,
`autoEnable: true`, `defaultForCapabilities: ['playbook-provider']`, `distribution: 'registry'`.
**Done:** `pnpm build:plugins` builds it; `pnpm --filter @ever-works/everworks-playbooks-plugin test`
passes with no tests yet.

**T006 [P1] — The 8 built-in playbooks**
Create `packages/plugins/everworks-playbooks/src/builtin-catalog.ts` exporting a frozen
`BUILTIN_PLAYBOOKS: readonly PlaybookCatalogEntry[]` with exactly the 8 slugs in
[plan.md §7](./plan.md#7-plugin-boundaries). Every entry declares all fields from T001. At least
5 declare no required connection. Every `provision.agentTemplateSlug` is one of the 6 slugs in
`packages/agent/src/agents/agent-templates.ts`; every `provision.skillSlugs` entry exists in the
first-party skill catalogue.
**Done:** the file compiles and every entry passes `validatePlaybookEntry`.

**T007 [P1] — Plugin implementation**
Create `packages/plugins/everworks-playbooks/src/everworks-playbooks.plugin.ts` implementing
`IPlaybookProviderPlugin` over `BUILTIN_PLAYBOOKS`, with an optional remote manifest source
(1 h TTL, in-memory cache, stale-serve ≤ 24 h) that is **off unless configured** and always merged
*under* the built-ins. Every remote string is HTML-stripped and length-capped per T002; an entry
failing validation is dropped with a warn, never thrown.
**Done:** built-ins are returned when the remote source is unset, unreachable, or malformed.

**T008 [P1] — Plugin settings schema**
In the same file, declare the settings schema: `remoteManifestUrl` (string, optional),
`remoteManifestToken` (string, optional, **`x-secret: true`**), `cacheTtlSeconds` (integer,
default 3600). Never log or return the token.
**Done:** the token field carries `x-secret: true`; a settings-serialisation test asserts it is
stripped.

**T009 [P1] — Plugin unit tests**
Create `packages/plugins/everworks-playbooks/src/everworks-playbooks.plugin.spec.ts` and
`packages/plugins/everworks-playbooks/src/builtin-catalog.spec.ts` covering everything in
[plan.md §10.1](./plan.md#101-unit--plugin-package-vitest).
**Done:** both green; the integrity spec fails if a built-in references an unknown agent-template
or skill slug.

**T010 [P1] — Canonical plugin doc**
Modify `docs/plugin-system/built-in-plugins.md`: add `everworks-playbooks` with its capability.
Update no other count anywhere (Constitution VIII).
**Done:** the new plugin appears exactly once in the repo's canonical list.

### Facade and API

**T011 [P1] — Playbook catalogue facade**
Create `packages/agent/src/facades/playbook-catalog.facade.ts`
(`PlaybookCatalogFacadeService extends BaseFacadeService`,
`CAPABILITY = PLUGIN_CAPABILITIES.PLAYBOOK_PROVIDER`), modelled on
`packages/agent/src/facades/skills.facade.ts`: resolve enabled providers for the scope, fan out,
dedupe by slug with the version-wins rule, page size 200, hard cap 2000 entries, a throwing
provider is logged and skipped. Register in `packages/agent/src/facades/facades.module.ts` and
export from `packages/agent/src/facades/index.ts`.
**Done:** `packages/agent/src/facades/__tests__/playbook-catalog.facade.spec.ts` covers fan-out,
dedupe, version-wins, the cap, and provider failure isolation.

**T012 [P1] — Readiness service**
Create `packages/agent/src/services/playbook-readiness.service.ts` resolving the four readiness
states, the missing-capability list (capability names + resolving plugin id **as data**), the two
blockers (ceiling 25, copy limit 3 — both read as 0 in P1 since no adoptions exist yet), the
agent-name collision suggestion, a 2 s budget after which unresolved checks are returned as
`unknown`, and a 60 s per-scope cache.
**Done:** `packages/agent/src/services/__tests__/playbook-readiness.service.spec.ts` covers every
state, both limits at their exact boundary, the collision suggestion and the partial result.

**T013 [P1] — Adoption planner (pure)**
Create `packages/agent/src/services/playbook-adoption-plan.ts` exporting
`planAdoption(entry, input): AdoptionPlan` and `hashAdoptionPlan(plan): string` (SHA-256 hex).
Pure, no IO. This one function is the single source of both the setup sheet's itemised list and
the executor's step list.
**Done:** `packages/agent/src/services/__tests__/playbook-adoption-plan.spec.ts` asserts the plan
item count equals the executor's step count for all 8 built-ins, and that the hash changes when
the entry version changes.

**T014 [P1] — Catalogue service**
Create `apps/api/src/catalog/playbook-catalog.service.ts`: merge facade output, apply
sanitisation caps, expose `getIndex`, `listPlaybooks`, `getPlaybook`, and a 300 s per-scope cache.
Report `source: 'builtin' | 'remote' | 'merged'` and `staleSince` when serving stale.
**Done:** unit-covered by the controller spec in T017.

**T015 [P1] — Catalogue DTOs**
Create `apps/api/src/catalog/catalog.dto.ts` with `ListPlaybooksDto`, `PreflightDto`,
`AdoptPlaybookDto`, `RemoveArtifactsDto` exactly as in
[plan.md §4.1](./plan.md#41-dto-shapes), using `class-validator` decorators (`@IsIn`,
`@IsUUID`, `@Length`, `@Matches`, `@Min`, `@Max`, `@ArrayMaxSize`).
**Done:** `limit` clamps at 50; `search` requires 2–64 chars; `localTime` rejects `24:00`.

**T016 [P1] — Catalogue controller and module**
Create `apps/api/src/catalog/catalog.controller.ts` (`@Controller('api/catalog')`,
`@UseGuards(AuthSessionGuard)`, `@ApiTags('catalog')`, `@ApiBearerAuth()`,
`@Header('Cache-Control','private, no-store')`) with the four P1 routes: `GET /`,
`GET /playbooks`, `GET /playbooks/:slug`, `POST /playbooks/:slug/preflight`. Throttles 60/60/60/30
per minute. Create `apps/api/src/catalog/catalog.module.ts` and register it in
`apps/api/src/api.module.ts`.
**Done:** routes appear in the OpenAPI document; `GET /api/catalog` returns five sections with a
per-section `error` field rather than a 500 when one source throws.

**T017 [P1] — Catalogue controller spec**
Create `apps/api/src/catalog/catalog.controller.spec.ts` covering
[plan.md §10.3](./plan.md#103-controller-specs-jest-appsapi) row 1.
**Done:** green, including the "one failing source does not 500 the index" case.

### Web — index, detail, workflows

**T018 [P1] — Routes and constants**
Modify `apps/web/src/lib/constants.ts`: add `DASHBOARD_CATALOG: '/catalog'`,
`DASHBOARD_CATALOG_PLAYBOOK: (slug) => '/catalog/playbooks/' + slug`,
`DASHBOARD_CATALOG_ADOPTIONS: '/catalog/adoptions'`,
`DASHBOARD_CATALOG_ADOPTION: (id) => '/catalog/adoptions/' + id`,
`DASHBOARD_CATALOG_WORKFLOWS: '/catalog/workflows'`,
`DASHBOARD_CATALOG_WORKFLOW: (id) => '/catalog/workflows/' + id`.
**Done:** no existing constant's value changes.

**T019 [P1] — API clients**
Create `apps/web/src/lib/api/catalog.ts` and `apps/web/src/lib/api/workflows.ts`, both
`import 'server-only'` and built on `serverFetch` / `serverMutation` from
`apps/web/src/lib/api/server-api.ts`. `workflows.ts` wraps the **existing** `api/workflows` routes
— no new backend.
**Done:** typed against the T001 contracts; every method degrades to a typed error result rather
than throwing.

**T020 [P1] — BFF proxies**
Create `apps/web/src/app/api/catalog/route.ts`, `.../catalog/playbooks/route.ts`,
`.../catalog/playbooks/[slug]/route.ts`, `.../catalog/playbooks/[slug]/preflight/route.ts`.
Forward the active scope header; return the upstream status verbatim (no 200-with-`[]` masking).
**Done:** a 502 upstream surfaces as a 502 so the section can render its error state.

**T021 [P1] — i18n keys (English)**
Modify `apps/web/messages/en.json`: add the full `dashboard.catalogPage` namespace from
[plan.md §8](./plan.md#8-i18n), plus `dashboard.sidebar.navigation.catalog` and
`metadata.pages.catalog`.
**Done:** every leaf name is camelCase and contains **no literal `.`**; `pnpm --filter web test`
i18n lint passes.

**T022 [P1] — Locale parity sync**
Run the locale parity-sync script so all 20 sibling files under `apps/web/messages/` carry the
full `dashboard.catalogPage` path (a missing **parent** key collapses the whole subtree).
**Done:** every locale file contains the `dashboard.catalogPage` object; English deep-merge
fallback fills untranslated leaves.

**T023 [P1] — Catalogue index page**
Create `apps/web/src/app/[locale]/(dashboard)/catalog/page.tsx` (RSC) with one `Promise.all` of
five independently `.catch()`-guarded fetches, plus `generateMetadata` from
`metadata.pages.catalog`.
**Done:** first paint needs no client fetch; a failing source yields that section's error slot
only.

**T024 [P1] — Index components**
Create `apps/web/src/components/catalog/`: `CatalogShell.tsx` (client — search, both chip rows,
keyboard per FR-61), `CatalogSection.tsx`, `PlaybookCard.tsx`, `ReadinessChip.tsx` (client),
`TaskTemplateMiniCard.tsx`, `StartingPointsRow.tsx`. Reuse
`apps/web/src/components/common/EmptyState.tsx` for all five empty states.
**Done:** all copy comes from `dashboard.catalogPage`; readiness never relies on colour alone;
skeletons cause no layout shift when readiness resolves.

**T025 [P1] — Playbook detail page**
Create `apps/web/src/app/[locale]/(dashboard)/catalog/playbooks/[slug]/page.tsx` and
`apps/web/src/components/catalog/PlaybookDetail.tsx` rendering the eight labelled blocks from
spec §6.6 and the readiness panel. In P1 the primary button links to `/agents/new` with the label
`Build it yourself`; the `Set it up` behaviour lands in T033.
**Done:** an unknown slug renders a 404; every block renders non-empty for all 8 built-ins.

**T026 [P1] — Workflows list and run pages**
Create `apps/web/src/app/[locale]/(dashboard)/catalog/workflows/page.tsx`,
`.../catalog/workflows/[id]/page.tsx`, `apps/web/src/components/catalog/WorkflowList.tsx` and
`apps/web/src/components/catalog/WorkflowRunTrace.tsx` over the existing
`api/workflows` routes. `Run` posts to `POST /api/workflows/:id/run` and shows the returned run
id; an archived workflow's `Run` is replaced by `Reactivate`.
**Done:** the run control returns in under 1 s; the trace shows nodes, per-node outcome, edges
traversed, decision choices and the truncated output.

**T027 [P1] — Sidebar entry**
Modify `apps/web/src/components/dashboard/DashboardSidebar.tsx`: add one nav entry after
`templates`, labelled from `dashboard.sidebar.navigation.catalog`, pointing at
`ROUTES.DASHBOARD_CATALOG`.
**Done:** no existing entry moves; the active-route highlight works for `/catalog` and its
children.

**T028 [P1] — P1 tests**
Create `apps/web/src/components/catalog/CatalogShell.unit.spec.tsx` and
`apps/web/src/components/catalog/PlaybookCard.unit.spec.tsx` (Vitest), and the Playwright specs
`apps/web/e2e/flow-capability-catalog-browse.spec.ts`,
`apps/web/e2e/flow-catalog-workflows-run.spec.ts`,
`apps/web/e2e/flow-playbook-preflight-blocked.spec.ts`,
`apps/web/e2e/flow-catalog-access-readonly.spec.ts`. Extend the existing deep accessibility spec
to cover `/catalog` and one playbook detail page.
**Done:** all green locally and in CI; the accessibility pass reports no serious or critical
violations.

---

## Phase 2 — Adoption

### Schema

**T029 [P2] — Entities**
Create `packages/agent/src/entities/playbook-adoption.entity.ts` and
`packages/agent/src/entities/playbook-adoption-artifact.entity.ts` exactly as specified in
[plan.md §3.2–§3.3](./plan.md#32-new-entity--playbookadoption-playbook_adoptions). Use
`PortableDateColumn` from `packages/agent/src/entities/_types.ts` for every timestamp column —
a raw `type: 'timestamp'` makes the better-sqlite3 CI stack fail to boot. Declare the partial
unique index with TypeORM's `where` option.
**Done:** both entities compile; no `@ManyToOne` on `agentId` or `artifactId`.

**T030 [P2] — Entity registration (four files + repositories)**
Modify `packages/agent/src/entities/index.ts`,
`packages/agent/src/database/_entity-names.ts` (alphabetical),
`packages/agent/src/database/_entities-inventory.ts`,
`packages/agent/src/database/_repository-inventory.ts`; create
`packages/agent/src/database/repositories/playbook-adoption.repository.ts` and
`.../playbook-adoption-artifact.repository.ts`; add barrel lines to
`packages/agent/src/database/index.ts`.
**Done:** `packages/agent/src/database/database.module.spec.ts` drift checks pass.

**T031 [P2] — Migration (same PR as T029, Constitution V)**
Create `apps/api/src/migrations/1791210000000-CreatePlaybookAdoptions.ts`. `up()` creates
`playbook_adoptions` and `playbook_adoption_artifacts` plus all seven indexes, including the raw
`CREATE UNIQUE INDEX uq_playbook_adoptions_inflight ON playbook_adoptions (userId, playbookSlug)
WHERE status = 'provisioning'`. `down()` drops them in reverse. Alters no existing table.
**Done:** `pnpm typeorm migration:run` applies cleanly on a fresh database and on one already
carrying every migration on `develop` (re-stamp before merge if one is newer than this file); `migration:generate` afterwards proposes nothing.

### Background work

**T032 [P2] — Dispatcher symbol and payload**
Create `packages/agent/src/tasks/playbook-adoption.types.ts` (`PlaybookAdoptionPayload
{ adoptionId; userId }` — ids only) and
`packages/agent/src/tasks/playbook-adoption-dispatcher.ts` (interface +
`PLAYBOOK_ADOPTION_DISPATCHER = Symbol(...)`, returning `Promise<string | null>`). Register the
name in `packages/agent/src/tasks/_tasks-symbols.ts`, wire it in
`packages/agent/src/tasks/job-runtime.providers.ts`, export from
`packages/agent/src/tasks/index.ts`.
**Done:** the symbol-drift spec passes; no call site imports a vendor SDK.

**T033 [P2] — Trigger.dev adapter**
Create `packages/tasks/src/dispatchers/playbook-adoption.dispatcher.ts`, modelled on
`packages/tasks/src/dispatchers/workflow-run.dispatcher.ts`. Returns `null` (never throws) when
the runtime is unconfigured.
**Done:** `packages/tasks/src/dispatchers/playbook-adoption.dispatcher.spec.ts` covers the
configured and unconfigured paths.

**T034 [P2] — Adoption executor**
Create `packages/agent/src/services/playbook-adoption-executor.service.ts` running the six steps
from [plan.md §6.3](./plan.md#63-the-executor) through the existing services:
`AgentTemplatesService` (`packages/agent/src/agents/agent-templates.service.ts`),
`SkillsService.installFromCatalog` + `createBinding` (`packages/agent/src/skills/skills.service.ts`),
`TaskTemplatesService.create` (`packages/agent/src/tasks-domain/task-templates.service.ts`),
`AgentsService.update` for guardrails and heartbeat cadence
(`packages/agent/src/agents/agents.service.ts`),
`InboundTriggersService.create` (`packages/agent/src/triggers/inbound-triggers.service.ts`),
`WorkflowsService.create` (`packages/agent/src/services/workflows.service.ts`).
Each step checks for its own artefact row first, writes the artefact row and bumps `stepIndex` in
one transaction, and never edits an existing row's configuration.
**Done:** re-running the executor against a completed adoption creates nothing; a step-2 failure
leaves step 1's artefacts and sets `status: 'failed'` with a `failureCode`.

**T035 [P2] — Worker task and module**
Create `packages/tasks/src/tasks/trigger/playbook-adoption.task.ts`
(`task({ id: 'playbook-adoption', maxAttempts: 3 })`, `withWorkerContext`, `assertUuid` on both
ids) and `packages/tasks/src/trigger/worker/modules/trigger-playbook-adoption.module.ts`,
following `trigger-workflow-run.module.ts`. Register in `packages/tasks/src/index.ts`.
**Done:** the task is discoverable by the trigger deploy; a redelivery resumes rather than
duplicates.

**T036 [P2] — Stuck-adoption sweeper**
Create `packages/tasks/src/tasks/trigger/playbook-adoption-sweeper.task.ts` —
`schedules.task({ id: 'playbook-adoption-sweeper', cron: '11 * * * *' })`. Moves any adoption in
`provisioning` for more than 15 minutes to `failed` with `failureCode: 'timed_out'`.
**Done:** the cron slot `11 * * * *` is unused elsewhere in `packages/tasks/src/tasks/trigger/`;
a unit spec covers the boundary at exactly 15 minutes.

### API and lifecycle

**T037 [P2] — Adoption service**
Create `packages/agent/src/services/playbook-adoption.service.ts`: `adopt` (validate plan hash,
re-check required connections, enforce the 25-adoption ceiling and 3-copy limit, insert the row,
dispatch, mark `dispatch_failed` on a `null` dispatch), `resume`, `pause`,
`resumeSchedule`, `retire`, `list`, `get` (with derived artefact `changed` / `missing`), and
`dismissGraduation`.
**Done:** `packages/agent/src/services/__tests__/playbook-adoption-lifecycle.service.spec.ts`
covers every legal and illegal transition and both limits at their exact boundary.

**T038 [P2] — Adoption controller**
Create `apps/api/src/catalog/playbook-adoptions.controller.ts` with the nine adoption routes from
[plan.md §4](./plan.md#4-api-surface) and the throttles listed there. Register in
`apps/api/src/catalog/catalog.module.ts`. Add `POST /playbooks/:slug/adopt` to
`catalog.controller.ts`.
**Done:** every error code in [plan.md §4.3](./plan.md#43-error-codes) is reachable and asserted.

**T039 [P2] — Adoption controller spec + DI contract spec**
Create `apps/api/src/catalog/playbook-adoptions.controller.spec.ts` and
`apps/api/src/catalog/catalog.module.di-contract.spec.ts` (modelled on
`apps/api/src/tasks/tasks.module.di-contract.spec.ts`).
**Done:** the DI spec fails if the facade or the dispatcher symbol is not bound.

### Web

**T040 [P2] — Server actions**
Create `apps/web/src/app/actions/catalog.ts` (`'use server'`) with
`adoptPlaybookAction`, `resumeAdoptionAction`, `pauseAdoptionAction`,
`resumeAdoptionScheduleAction`, `retireAdoptionAction`, each returning
`{ success, …, error }` result objects rather than throwing — the pattern in
`apps/web/src/app/actions/skills.ts`.
**Done:** every action re-validates the affected route on success.

**T041 [P2] — Setup sheet**
Create `apps/web/src/components/catalog/PlaybookSetupSheet.tsx` (client): three editable fields
(instance name, run time, Work scope), the itemised plan, the plan hash carried through to
confirm, the duplicate warning, the collision note, focus trap and focus return. Wire the detail
page's primary button to it, replacing T025's placeholder link.
**Done:** the sheet's item list is rendered from the preflight `plan.items` — it never composes
its own list.

**T042 [P2] — Adoption progress, card, failure panel, list page**
Create `apps/web/src/components/catalog/AdoptionProgress.tsx` (2 s poll while `provisioning`,
stop on terminal, hard stop after 150 polls), `AdoptionCard.tsx`, `AdoptionArtifactList.tsx`, and
the pages `apps/web/src/app/[locale]/(dashboard)/catalog/adoptions/page.tsx` and
`.../catalog/adoptions/[id]/page.tsx`.
**Done:** the failure panel lists created / not-created items with `Try again`,
`Remove what was created` (disabled until P3) and `Leave it as is`.

**T043 [P2] — `Already set up` state on cards**
Modify `apps/web/src/components/catalog/PlaybookCard.tsx` and `ReadinessChip.tsx` to render the
`adopted` readiness with a link to the adoption.
**Done:** a workspace with one adoption shows the chip on exactly that card.

**T044 [P2] — P2 i18n**
Modify `apps/web/messages/en.json` with the `setup.*`, `progress.*`, `adoption.*` groups from
[plan.md §8](./plan.md#8-i18n); re-run the locale parity sync.
**Done:** no hardcoded English in any P2 component.

**T045 [P2] — P2 tests**
Create `apps/web/e2e/flow-playbook-adoption.spec.ts`,
`apps/web/e2e/flow-playbook-adoption-failure-resume.spec.ts`,
`apps/web/e2e/flow-playbook-limits.spec.ts`, plus
`packages/agent/src/services/__tests__/playbook-adoption-executor.service.spec.ts`.
**Done:** the adoption e2e asserts the created rows match the sheet's itemised list exactly, and
that the created Agent's guardrails are `require_approval`.

---

## Phase 3 — Living with it

**T046 [P3] — Artefact removal endpoint**
Add `POST /api/catalog/adoptions/:id/remove-artifacts` to
`apps/api/src/catalog/playbook-adoptions.controller.ts` and the corresponding service method.
Per-item results (`removed[]`, `alreadyGone[]`); an already-deleted target never fails the batch;
each removal writes an activity-log entry naming the artefact **type and id** only.
**Done:** a batch of 50 with 3 already-gone targets returns 200 with both arrays populated.

**T047 [P3] — Removal sheet**
Create `apps/web/src/components/catalog/RemoveArtifactsSheet.tsx`: every checkbox unchecked by
default, live `Remove {count} items` label, disabled at zero, `Changed since setup` flag on any
renamed artefact, and the `output is kept` line. Produced Knowledge Base documents, Missions,
Tasks and drafts are never listed.
**Done:** `apps/web/src/components/catalog/RemoveArtifactsSheet.unit.spec.tsx` asserts the
all-unchecked default and the live label.

**T048 [P3] — 30-day rollup**
Extend the adoption detail read to aggregate the created Agent's runs over 30 days: run count and
summed `agent_runs.costCents` rendered to 2 decimals. `No runs yet · first run <date>` when empty.
**Done:** the rollup is one scoped aggregate query, not a per-run fetch.

**T049 [P3] — Reverse attribution**
Add a "created by the *&lt;playbook&gt;* playbook" line to the Agent detail surface, resolved via
`idx_playbook_artifacts_target`.
**Done:** an Agent created outside a playbook renders nothing extra.

**T050 [P3] — Repeated-failure warning**
Show a persistent warning on an adoption whose last 3 consecutive runs failed, with the last
failure reason and a `Run now` control.
**Done:** the warning clears on the first successful run.

**T051 [P3] — Graduation suggestion**
Create `apps/web/src/components/catalog/GraduationSuggestion.tsx` and the
`POST /api/catalog/adoptions/:id/dismiss-graduation` endpoint. Eligible at ≥ 14 days active with
0 rejected approvals; `Review the change` shows exactly which action types would stop asking;
dismissal writes `graduationDismissedUntil = now + 30 days`.
**Done:** nothing changes without an explicit confirm; a unit spec covers the 14-day and 0-rejection
boundaries.

**T052 [P3] — Remote catalogue source, wired**
Enable the plugin's remote manifest path behind its settings, and add the stale banner
(`dashboard.catalogPage.staleCatalogue`) to the Playbooks section.
**Done:** with the remote source unreachable the built-ins still render and the banner shows the
last-updated age.

**T053 [P3] — Hand the setup to an agent**
For playbooks declaring free-text inputs, add a secondary action that opens the agent chat
composer pre-filled with the setup brief. It **sends nothing** — the person presses send.
**Done:** the composer is pre-filled and no message is created until the user acts.

**T054 [P3] — P3 tests**
Extend `apps/web/e2e/flow-playbook-adoption-failure-resume.spec.ts` with the removal flow, and add
graduation and rollup coverage to
`packages/agent/src/services/__tests__/playbook-adoption-lifecycle.service.spec.ts`.
**Done:** green.

---

## Program bookkeeping (do these with the P1 PR)

**T055 — Vocabulary table**
Modify `docs/specs/features/agent-workspace/README.md` §1: add two rows — **Playbook** (a packaged
outcome in the catalogue; do not introduce "recipe", "automation", "workflow" or "blueprint" as a synonym)
and **Playbook adoption** (the record of a workspace having set one up; do not introduce
"installation", "instance"). Program rule #2 requires this in the same PR that introduces the
nouns.
**Done:** both rows present, worded consistently with the existing table.

**T056 — Tracker**
Modify `docs/specs/features/agent-workspace/TRACKER.md`: mark AW-21's spec status and record the
P1/P2/P3 implementation split.
**Done:** the tracker reflects the phase actually merged.

**T057 — Substrate note**
Modify `docs/specs/features/agent-workspace/EXISTING-SUBSTRATE.md`: mark **S1** (Workflows — no
UI) as addressed by AW-21 P1 and **S12** (Task workflow templates buried) as surfaced by AW-21 P1.
Do not delete either row — the document is a record of what was found.
**Done:** both rows carry a "surfaced by AW-21 P1" note.

**T058 — Spec-kit cross-links**
Add AW-21 to any index that lists agent-workspace epics, and link this epic from
`docs/specs/features/templates-catalog/` and `docs/specs/features/skills/` as the surface that now
indexes them.
**Done:** every link resolves; no existing document's meaning changes.

---

## Definition of done for the epic

- [ ] Every acceptance-criteria checkbox in [spec.md §8](./spec.md#8-acceptance-criteria) passes on
      a running build.
- [ ] `pnpm lint`, `pnpm type-check` and `pnpm test` are green from the repo root.
- [ ] The migration applies forward on a database already at the newest `develop` migration and
      `migration:generate` afterwards proposes no further change.
- [ ] `grep -rn "'everworks-" apps/api/src/catalog apps/web/src/components/catalog` returns
      nothing (Constitution II).
- [ ] `grep -rn "@trigger.dev/sdk" packages/agent/src apps/api/src` returns nothing new
      (Constitution IV).
- [ ] Every new user-visible string resolves from `dashboard.catalogPage`, and every locale file
      carries that parent key.
- [ ] The program vocabulary table (T055) carries both new nouns.
