# Teams & Prebuilt Companies — task checklist

Phase 1 — data model + API
- [ ] T1 `team.entity.ts` + `team-member.entity.ts` (Tier A/C, PortableDateColumn, raw uuid scope refs)
- [ ] T2 export via `entities/index.ts`; add both to `ENTITIES` in `database.config.ts`
- [ ] T3 add `reportsToAgentId` to `agent.entity.ts`
- [ ] T4 migration CreateTeamsTables (tables, FKs, UNIQUEs, indexes, agents column; guarded)
- [ ] T5 tier lock tests: `teams` → tier-a list, `team_members` → tier-c list
- [ ] T6 `TeamsService` CRUD + slug + cycle/depth + roster validation (+ unit specs)
- [ ] T7 `OrgChartService` flat payload (+ unit spec)
- [ ] T8 `teams.controller.ts` + DTOs + guards + swagger; register module in `api.module.ts`
- [ ] T9 `UpdateAgentDto.reportsToAgentId` + cycle guard in agents service (+ spec)

Phase 2 — web UI
- [ ] T10 ROUTES const + sidebar item + 21-locale `navigation.teams` strings
- [ ] T11 `lib/api/teams.ts` + `app/actions/dashboard/teams.ts`
- [ ] T12 `/teams` list + empty/no-org states (+ testids)
- [ ] T13 `/teams/new` create dialog (slug preview reuse)
- [ ] T14 `/teams/[id]` overview + settings (roster add/remove UI)
- [ ] T15 `buildOrgTree()` pure fn + unit spec
- [ ] T16 `/teams/org-chart` SVG tidy-tree, pan/zoom, node links
- [ ] T17 NewAgentDialog team/reports-to selects; AgentSettingsClient same
- [ ] T18 e2e: teams CRUD, roster, org-chart render, agent-with-team

Phase 3 — ever-works/orgs
- [ ] T19 repo scaffold (README+credits, LICENSE MIT, CONTRIBUTING, manifest, schema, CI)
- [ ] T20 flagship `ever-starter` company (starter-template agents, 2 teams, project+tasks)
- [ ] T21 adapted-concept companies (≥ 8, original prose, `.works/company.yml`, org-chart.svg)
- [ ] T22 validate workflow green; tag v1.0.0

Phase 4 — catalog + import + wizard
- [ ] T23 `OrgTemplateCatalogService` + `GET /api/org-templates` (+ unit spec w/ vendored fixture)
- [ ] T24 `CompanyImportService` (parse pkg, mapping, 2nd-pass reportsTo, report, caps) (+ specs)
- [ ] T25 `WorkLifecycleService.createDraftWork`
- [ ] T26 `POST /api/organizations/import-company` + DTO + throttle
- [ ] T27 CreateOrganizationModal template step (skip-when-empty) + import path
- [ ] T28 e2e: wizard both paths (adaptive), import API vs fixture

Phase 5 — chat/MCP/docs
- [ ] T29 `teams.tools.ts` + tool-selection wiring
- [ ] T30 MCP whitelist rows
- [ ] T31 apps/docs page + Workspace pointer note
