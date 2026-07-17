# Teams & Prebuilt Companies — implementation plan

Companion to [spec.md](./spec.md). Additive-only; each phase ships green (tsc, unit,
branch e2e) and is independently mergeable.

## Phase 1 — Data model + Teams API

- `Team` + `TeamMember` entities (Tier A / Tier C), `entities/index.ts` export,
  `ENTITIES` registration, tier lock-test lists.
- `agents.reportsToAgentId` column + `UpdateAgentDto` field + cycle guard in
  `AgentsService`.
- Migration `xxxxx-CreateTeamsTables.ts`: `teams`, `team_members`, `agents` column, FKs
  (`teams.parentTeamId` SET NULL, `teams.managerAgentId` SET NULL, `team_members.teamId`
  CASCADE, `agents.reportsToAgentId` SET NULL), UNIQUEs, scope-column indexes —
  hasTable/hasColumn-guarded, same PR.
- `packages/agent/src/teams/`: `TeamsService` (CRUD, slug gen, cycle/depth checks,
  roster validation), `OrgChartService` (flat payload).
- `apps/api/src/teams/`: controller (`/api/organizations/:orgId/teams…`, `/org-chart`),
  DTOs, `OrganizationOwnershipGuard` + `@OrgAdmin()`, `@ApiOperation` everywhere,
  register in `api.module.ts`.
- Unit specs: service (cycle, depth, roster IDOR), controller (404 posture).

## Phase 2 — Teams UI + Org Chart

- Sidebar item + `ROUTES.DASHBOARD_TEAMS` + 21-locale nav strings.
- `(dashboard)/teams/` routes per spec §4.2; `lib/api/teams.ts` client;
  `app/actions/dashboard/teams.ts` server actions; `components/teams/*`.
- Org chart page: flat payload → pure `buildOrgTree()` (unit-tested) → custom SVG
  tidy-tree with pan/zoom; testids per spec.
- Agent forms: Team + Reports-to selects in `NewAgentDialog` details step and
  `AgentSettingsClient` (both optional, hidden when empty).
- e2e: teams CRUD flow, roster add/remove, org-chart renders, agent-with-team create
  (environment-adaptive; probe against local `next start` per house rule).

## Phase 3 — `ever-works/orgs` catalog repo

- Bootstrap repo: README (credits), MIT LICENSE, CONTRIBUTING, `manifest.json`,
  `schema/orgs-manifest.schema.json`, validate workflow.
- Author v1 companies (original prose, agentcompanies/v1 layout, `.works/company.yml`):
  `ever-starter` (flagship, built on the `ever-works/agents` starter templates) plus a
  spread of adapted-concept companies (engineering, dev-shop, research-lab, game-studio,
  creative-agency, review-board, consulting, security, capital) — each ≤ 12 agents,
  1–3 teams, 2–5 skills, ≤ 1 project.
- CI validation green; tag `v1.0.0` (platform default ref).

## Phase 4 — Catalog service + import + wizard step

- `OrgTemplateCatalogService` (manifest reader, mirrors agent-template service:
  App-token chain, `EVER_WORKS_ORGS_REF`, 1h cache, sanitization) + `GET /api/org-templates`.
- `CompanyImportService` + `POST /api/organizations/import-company` (mapping per spec
  §6.2, second-pass reportsTo resolution, per-entity report, caps).
- `WorkLifecycleService.createDraftWork` (parametrized sibling of `createCompanyWork`).
- Wizard: template step in `CreateOrganizationModal` (skip-when-empty), import path,
  post-create redirect to org dashboard with import report toast.
- e2e: wizard blank path unchanged; template path (adaptive — skipped when catalog
  unreachable in key-less CI); import API spec against a fixture package.

## Phase 5 — Chat/MCP + docs

- `teams.tools.ts` chat tools; MCP whitelist entries.
- User docs page (apps/docs) for Teams + company templates; workspace pointer note.

## Sequencing note

Phases 1–2 and Phase 3 are independent (parallelizable). Phase 4 depends on both.
