# Feature — Environments (Settings → Environments)

Branch: `session/feat-environments`. Implementation notes for review.

## What shipped

Named, reusable **Environments** a user manages under Settings and assigns
per-Agent: pip/npm package lists, networking posture (unrestricted vs.
limited + egress allow-list), draft/published lifecycle, and an
available-in-all-projects flag. Consumed v1 by the `claude-managed-agent`
pipeline plugin (CMA environment networking + a first-session package
bootstrap step); carried elsewhere as an advisory, serializable
`runtimeEnvironment` object on pipeline execution contexts.

## Data model

- **`environments` table** (`packages/agent/src/entities/environment.entity.ts`):
  `id, userId, name(120), slug(80, unique per user), description?,
  pipPackages simple-json, npmPackages simple-json, networkingMode
  varchar(16) 'unrestricted'|'limited', allowedHosts simple-json?,
  allowPackageManagers bool default true, status varchar(16)
  'draft'|'published' default 'draft', availableInAllProjects bool default
  true, tenantId?, organizationId?, timestamps`. Registered in
  `_entities-inventory.ts` + `_entity-names.ts` + entities barrel.
- **`agents.environmentId uuid NULL`** — FK ON DELETE SET NULL
  (belt-and-braces; the service refuses deletion first).
- **Migrations** (portable Table API, idempotent guards, both `up`/`down`):
  - `apps/api/src/migrations/1785010000000-CreateEnvironments.ts`
  - `apps/api/src/migrations/1785020000000-AddAgentEnvironmentId.ts`

## Server rules

- Package specs and hosts are validated with strict allow-list regexes at
  THREE layers (DTO → `EnvironmentsService` → consuming plugin), because
  they later reach install commands. Canonical validators live in
  `packages/plugin/src/pipeline/runtime-environment.ts`
  (`isValidPipPackageSpec` / `isValidNpmPackageSpec` /
  `isValidAllowedHost` / `normalizeRuntimePackageList`). No whitespace,
  quotes, or shell metacharacters can validate; comparison operators must
  be followed by a digit (anti-`>out.txt`); composed install commands
  additionally single-quote every spec.
- Assignment rule (server-side, in `AgentsService.create/update`): an
  Environment may be assigned only when it belongs to the same user
  (cross-user/unknown → **404**) and is **published** (draft → **422**
  with a clear message). The UI picker filters to published rows as the
  matching affordance.
- DELETE refused with **409** while any Agent references the row.
- Unrestricted rows normalise `allowedHosts` to NULL so mode and hosts
  can never disagree.
- Slug uniqueness enforced by DB index; lost create races surface as the
  same named 409 via `isUniqueConstraintError`.
- Activity rows: additive `ENVIRONMENT_CREATED/UPDATED/PUBLISHED/DELETED`
  enum entries, emitted best-effort from the controller.

## Endpoints (`apps/api/src/environments/`, JWT, user-scoped)

- `GET    api/environments?status=draft|published`
- `POST   api/environments`
- `GET    api/environments/:id`
- `PATCH  api/environments/:id`
- `POST   api/environments/:id/publish`
- `DELETE api/environments/:id` (409 while referenced)

Registered in `api.module.ts` as `EnvironmentsApiModule`.
`CreateAgentDto`/`UpdateAgentDto` gained optional `environmentId`
(`AgentDto` exposes it; the agents validation-authz e2e matrix pins
unknown-property 400s and is unaffected by an added optional field).

## Pipeline carrier + consumption

- `@ever-works/plugin`: `RuntimeEnvironmentData` + optional
  `runtimeEnvironment` on `StepExecutionContext`, optional
  `agentId`/`runtimeEnvironment` on `PipelineExecutionOptions`.
- `FullPipelineExecutorService`: `options.runtimeEnvironment` wins;
  otherwise `options.agentId` resolves through an `@Optional()`
  `EnvironmentsService` (`resolveRuntimeEnvironmentForAgent`: agent →
  `environmentId` → published, same-owner row → plain carrier).
  Fail-open: resolution errors log a warning and the run continues with
  no Environment. `PipelineModule` imports the (leaf) agent-side
  `EnvironmentsModule`; the module pin spec was updated (3 imports).
- `claude-managed-agent`: with a carrier present, the CMA environment is
  created with `{type:'limited', allowed_hosts, allow_package_managers}`
  or an explicit `{type:'unrestricted'}`, and a bootstrap message
  (`pip install '…' …` / `npm install -g '…' …`, re-validated + quoted)
  is sent and awaited as the FIRST session turn. Without a carrier, the
  `CLAUDE_MANAGED_AGENT_EGRESS_HOSTS` env-var fallback and the message
  sequence are preserved byte-for-byte (test-pinned).

## Web UI

- **Settings → Environments** (`/settings/environments`): list (Name,
  Networking, Status chip, Updated) + dialog editor (name, description,
  available-in-all-projects toggle, comma-separated pip/npm inputs,
  networking radio with hosts textarea + allow-package-managers toggle
  when limited, Save draft / Save & publish), per-row Publish/Edit/Delete
  with delete confirmation. New "Environments" tab in
  `settings-layout-client.tsx` (below Job Runtime).
  Files: `apps/web/src/lib/api/environments.ts`,
  `apps/web/src/app/actions/settings/environments.ts`,
  `.../settings/environments/page.tsx`,
  `apps/web/src/components/settings/EnvironmentsSettings.tsx`.
- **Agent Settings → Runtime card**: "Environment" SearchableSelect over
  the user's *published* Environments + "None (default)", persisting
  `environmentId` through the existing `updateAgentAction` PATCH.
- i18n: `dashboard.settings.tabs.environments` +
  `dashboard.settings.environments.*` added to **all 21** locale files
  (English copy everywhere, per convention; JSON round-trip-safe insert).

## Tests

- `cd packages/agent && npx jest --testPathPattern='src/environments/__tests__'`
  — service CRUD / publish / delete-guard / resolver (17 tests).
- `cd packages/agent && npx jest --testPathPattern='(runtime-environment-injection|agents.service.environment)'`
  — executor carrier forwarding + assignment-rule specs.
- `cd packages/agent && npx jest --testPathPattern='src/(pipeline/pipeline.module|database/database.module|database/database.config|agents/__tests__/agents.service)'`
  — pin/drift suites updated + green.
- `cd packages/plugin && npx vitest run src/pipeline/__tests__/runtime-environment.spec.ts`
  — validator table tests (69 tests, incl. shell-injection samples).
- `cd packages/plugins/claude-managed-agent && npx vitest run`
  — client networking payloads + helper + full plugin execute spec
  (with-carrier vs. absent-carrier byte-for-byte).

## Divergences from the brief (code won)

- The existing env-var fallback sends `{type:'allowlist', hosts}` (H-25
  code), not the brief's `{type:'limited', allowed_hosts}`; the fallback
  was left untouched (byte-for-byte pin) and the brief's `limited` shape
  is used only for the new Environment-driven path.
- "Wire the resolution where the agent-run assembles plugin context":
  **no current production path executes a pipeline plugin on behalf of an
  Agent** — agent runs go through the AI tool loop
  (`AgentRunService.runToolLoop`), and work generation
  (`DataGeneratorService.executePipeline`) carries no agent. The
  resolution is therefore wired into `FullPipelineExecutorService`
  behind `options.agentId` (+ a pre-resolved `options.runtimeEnvironment`
  escape hatch), so the first orchestrator that dispatches a pipeline for
  an Agent gets Environments for free. Until then the carrier is
  populated only by callers that opt in.

## Known follow-ups

- Pass `agentId` from a real agent-driven pipeline dispatch once one
  exists (e.g. a future Managed-Agents task runner).
- Per-project narrowing UI for `availableInAllProjects = false` (flag is
  persisted; no narrowing surface yet).
- Playwright e2e for the settings CRUD + agent picker (unit/service
  coverage only in this PR).
- Activity feed rendering for `environment_*` rows uses the generic row
  renderer; no dedicated icon/label mapping yet.
- `resolveRuntimeEnvironmentForAgent` does not filter by
  `availableInAllProjects` (needs a project/work context to mean
  anything).
