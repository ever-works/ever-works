# Teams & Prebuilt Companies (Agent Companies support)

**Status:** Draft v1 · **Owner:** Product (Ruslan) · **Date:** 2026-07-17

**Audience:** platform engineers, agent authors, catalog contributors.

**Internal codename:** `teams-and-companies`

**Related code today:**
- `packages/agent/src/entities/agent.entity.ts` — Agent scope model (`tenant|mission|idea|work`), `targets`, `agent_memberships`
- `packages/agent/src/entities/organization.entity.ts` — Organization (`linkedWorkId`, registration fields)
- `apps/api/src/organizations/` — org routes, `OrganizationOwnershipGuard`, `organization-membership.service.ts`
- `apps/api/src/agents/agent-template-catalog.service.ts` — the ADR-011/ADR-014 catalog reader for `ever-works/agents`
- `packages/agent/src/services/work-lifecycle.service.ts` — `createCompanyWork` (bare draft Work, no side-effects)
- `apps/web/src/components/organizations/CreateOrganizationModal.tsx`, `apps/web/src/components/agents/NewAgentDialog.tsx`

> Scope of this document: product + technical spec. Phasing lives in the sibling
> [plan.md](./plan.md); the work-item checklist lives in [tasks.md](./tasks.md).

> **Hard rule (additive only).** This feature **extends** the platform; it removes and
> renames nothing. Works stay Works (never renamed to "Projects" internally), the Agent
> scope enum stays `tenant|mission|idea|work`, Work Members RBAC stays as shipped, the
> Organization entity and the register-company flow stay as shipped. Everything below is
> new tables, new nullable columns, new routes, new UI surfaces.

## 0. TL;DR

Ever Works already has 5 of the 6 entities of the open **Agent Companies** spec
(`agentcompanies/v1`, https://agentcompanies.io/specification):

| agentcompanies/v1 | Ever Works | Status |
|---|---|---|
| Company (`COMPANY.md`) | **Organization** (user-facing "Company") | exists |
| Project (`PROJECT.md`) | **Work** (internal name unchanged) | exists |
| Task (`TASK.md`) | **Task** | exists |
| Skill (`SKILL.md`) | **Skill** (Agent Skills format, unchanged) | exists |
| Agent (`AGENTS.md`) | **Agent** | exists |
| Team (`TEAM.md`) | **Team** | **NEW — this spec** |

This feature adds:

1. **Teams** — a first-class, optional grouping of Agents *and* human members inside an
   Organization, with team-in-team hierarchy (`parentTeamId`) and agent-reports-to-agent
   hierarchy (`Agent.reportsToAgentId`).
2. **Org Chart** — a per-Organization chart of Teams, Agents and Members.
3. **Prebuilt Companies** — a new public catalog repo **`ever-works/orgs`**
   (agentcompanies/v1 packages + `manifest.json` index, per ADR-014), surfaced as an
   optional "Start from a company template" step in the Create Organization flow. Picking
   a template creates the Organization **plus** its Teams, Agents (paused), Skills, draft
   Works and Tasks in one shot.

```
Tenant (internal)
└── Organization  ("Company" in UI)          ←  COMPANY.md
    ├── Team "Engineering"                   ←  teams/engineering/TEAM.md
    │   ├── Team "QA"          (parentTeamId — teams nest, Orgs never do)
    │   ├── Agent "CTO"        (roster row; reportsTo: ceo)
    │   ├── Agent "Coder"      (roster row; reportsTo: cto)
    │   └── Member @ruslan     (roster row, memberType='user')
    ├── Team "Growth"
    ├── Agent "CEO"            (org-stamped, teamless is fine — Teams are OPTIONAL)
    ├── Work  "marketing-site" (kind='default', unchanged)
    └── Work  "acme-inc"       (kind='company', linkedWorkId — unchanged)
```

**Non-goals for v1:** company **export**, importing from arbitrary third-party GitHub
URLs (catalog-only in v1; see §10), team-level budgets/approvals, per-Org human role
matrix (org roles stay deferred-with-decision), a `team`/`organization` value in the
Agent scope enum.

## 1. Concepts

### 1.1 Team

A Team is a named, optional container **inside one Organization**:

- Groups **Agents and human members** via a roster (`team_members`), not via columns on
  the member entities. An agent/user may belong to several Teams.
- Nests via `parentTeamId` (service-enforced acyclic, max depth 10). This satisfies the
  locked tenants-and-orgs decision "no nested Organizations": hierarchy lives *inside*
  an Org, never between Orgs.
- Optionally names a **manager agent** (`managerAgentId`) — mirrors `TEAM.md`'s
  `manager:` field and anchors the subtree in the org chart.
- Teams are **organization-scoped in v1**. Users with no Organization see the existing
  "create your first organization" affordance (same banner pattern as
  `CreateFirstOrgBanner`). Tenant-level (org-less) teams are an open question (Q1).

Explicitly **not** a Team: Work Members (per-Work RBAC, untouched), `agent_memberships`
(agent→target reach, untouched), Organization membership (still tenant-ownership).

### 1.2 Agent hierarchy

`agents.reportsToAgentId` (new nullable uuid, additive) is the direct-manager edge used
by the org chart and by `AGENTS.md` `reportsTo:` on import. Rules:

- Same Organization only; cycle-guarded in the service (walk-up with max 50, mirroring
  Paperclip's chain-of-command guard); dangling manager ⇒ treated as root.
- Purely descriptive in v1: it does **not** change task-assignment authz, the
  `createSubAgent` scope-narrowing cascade, or heartbeat behavior. (Delegation-aware
  behavior is a future spec.)

### 1.3 Company template ( = an agentcompanies/v1 package)

A folder in `ever-works/orgs` with `COMPANY.md` + conventional subfolders
(`teams/ agents/ projects/ tasks/ skills/`). Importing one is a **copy**, exactly like
agent templates (ADR-011 fork-on-use): nothing stays subscribed to the repo.

## 2. Data model (all new, Tier conventions per EW-651)

### 2.1 `teams` (Tier A: `tenantId` + `organizationId`, auto-stamped)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `userId` | uuid | creator/owner (house pattern) |
| `name` | varchar(200) | |
| `slug` | varchar(100) | `^[a-z0-9][a-z0-9-]*$`; **UNIQUE(organizationId, slug)** |
| `description` | text, null | |
| `parentTeamId` | uuid, null | raw column (no `@ManyToOne`), FK in migration `ON DELETE SET NULL` |
| `managerAgentId` | uuid, null | raw column, FK in migration `ON DELETE SET NULL` |
| `avatarIcon` | varchar(64), null | kebab-case lucide id (same convention as agent templates) |
| `metadata` | simple-json, null | provenance: `{source: {repo, path, slug, contentHash}}` on import |
| `tenantId` / `organizationId` | uuid, null | Tier A scope columns → `ScopeStampingSubscriber` auto-stamps |
| `createdAt` / `updatedAt` | `PortableDateColumn` | |

### 2.2 `team_members` (Tier C: both scope columns denormalized)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `teamId` | uuid | FK in migration `ON DELETE CASCADE` |
| `memberType` | varchar(16) | `'agent' \| 'user'` (mirrors `TaskAssignee.actorType`) |
| `memberId` | uuid | agents.id or users.id (polymorphic, service-validated) |
| `role` | varchar(16) | `'lead' \| 'member'`, default `'member'` — display-only in v1, **not** authz |
| `addedById` | uuid, null | |
| `tenantId` / `organizationId` | uuid, null | |
| `createdAt` | `PortableDateColumn` | |

UNIQUE(`teamId`, `memberType`, `memberId`).

### 2.3 `agents` — one additive column

```
reportsToAgentId: uuid, nullable   // raw column; FK in migration ON DELETE SET NULL
```

No change to `scope`, `scopeTargetId`, the `uq_agents_user_scope_slug` index, DTO
cross-field validation, or identity-file storage. An agent of **any** scope may sit in a
Team and report to another agent — Teams ride on top of the existing model.

### 2.4 Registration checklist (bug-class guard)

Both entities: `packages/agent/src/entities/*.entity.ts` → export from `entities/index.ts`
→ **add to `ENTITIES` in `database.config.ts`** → `TypeOrmModule.forFeature` in the new
module → migration (hasTable-guarded, FKs + indexes) in `apps/api/src/migrations/`, same
PR → add to `tier-a` / `tier-c` lock-test lists.

## 3. API surface (NestJS, `apps/api`)

All org-nested routes use `OrganizationOwnershipGuard` (+ `@OrgAdmin()` on writes — the
single seam that tightens automatically when per-org roles land), 404-never-403 posture,
`@ApiOperation` on every route (MCP whitelist derivation), `@Throttle` 30/min on writes.

```
GET    /api/organizations/:orgId/teams                     list (flat + parentTeamId; client builds tree)
POST   /api/organizations/:orgId/teams                     {name, slug?, description?, parentTeamId?, managerAgentId?, avatarIcon?}
GET    /api/organizations/:orgId/teams/:teamId             detail incl. members[], childTeamIds[]
PATCH  /api/organizations/:orgId/teams/:teamId             partial update (same fields; cycle re-check)
DELETE /api/organizations/:orgId/teams/:teamId             children re-parent to deleted team's parent; roster rows cascade
GET    /api/organizations/:orgId/teams/:teamId/members     roster
POST   /api/organizations/:orgId/teams/:teamId/members     {memberType, memberId, role?} (validates agent/user exists + same org/tenant)
DELETE /api/organizations/:orgId/teams/:teamId/members/:memberId?memberType=
GET    /api/organizations/:orgId/org-chart                 §5 payload
PATCH  /api/agents/:id                                     accepts new optional reportsToAgentId (existing route, additive DTO field)
GET    /api/org-templates                                  catalog list (auth'd, same posture as /agent-templates)
POST   /api/organizations/import-company                   §6 (create-org + import, one transaction-ish flow)
```

Domain errors: plain Nest `HttpException`s from the service (`NotFoundException`,
`ConflictException` for slug/UNIQUE and cycle violations, `UnprocessableEntityException`
for depth/size caps) — no new FacadeError leaves needed.

New module pair: `packages/agent/src/teams/teams.module.ts` (entities, `TeamsService`,
`OrgChartService`, `CompanyImportService`) + `apps/api/src/teams/teams.module.ts`
(controller only), registered in `api.module.ts`. Catalog service lives beside the agent
one: `apps/api/src/organizations/org-template-catalog.service.ts`.

## 4. Web UI (`apps/web`)

### 4.1 Sidebar

New item **Teams** (`Users` lucide icon, `strokeWidth={1.5}`) between **Agents** and
**Templates**. `ROUTES.DASHBOARD_TEAMS = '/teams'` + `dashboard.sidebar.navigation.teams`
in all 21 locale files. No feature flag (consistent with the static nav array).

### 4.2 Routes (model: `agents/`)

```
(dashboard)/teams/
  page.tsx            # list: team cards (name, icon, member/agent counts, parent) + "Org Chart" button + empty states
  new/page.tsx        # create dialog (name, slug preview, parent team, manager agent, icon)
  org-chart/page.tsx  # §5
  [id]/
    layout.tsx        # tabs: Overview | Members | Settings
    page.tsx          # overview: roster, sub-teams, manager
    settings/page.tsx # rename, re-parent, manager, delete
```

Server actions in `app/actions/dashboard/teams.ts`, typed client in `lib/api/teams.ts`,
components under `components/teams/`. Explicit `isSubmitting` state on detached-async
submits (house convention). testids: `teams-list`, `team-card-<slug>`,
`team-create-submit`, `org-chart-canvas`, `org-chart-node-<slug>`, …

No active Organization ⇒ both pages render the create-first-org empty state (reuse
`CreateFirstOrgBanner` copy pattern); Teams never appear without an Org in v1.

### 4.3 Agent forms (extension, not replacement)

- **NewAgentDialog details step:** optional **Team** `<select>` (native select, like the
  existing pickers; hidden when the active org has no teams) + optional **Reports to**
  agent select. Submitting creates the agent, then a roster row / sets
  `reportsToAgentId`.
- **AgentSettingsClient:** same two selects in an "Organization" card. Scope stays
  non-editable, exactly as today.

### 4.4 Create Organization flow (§6 UX)

`CreateOrganizationModal` gains an optional **template step** in front of the name step —
the exact `NewAgentDialog` pattern: step is skipped entirely when the catalog is empty or
fails to load (fallback = today's behavior, guaranteed no regression). Card grid:
"Blank organization" first + featured templates (name, icon, description,
`N agents · M teams · K skills` badges from `manifest.json`). Picking a template routes
the submit through `POST /api/organizations/import-company`; blank routes through the
existing `POST /api/organizations` unchanged. `RegisterCompanyDialog` (legal
registration) is untouched.

## 5. Org chart

`GET /api/organizations/:orgId/org-chart` →

```jsonc
{
  "organization": { "id", "slug", "displayName" },
  "teams":   [{ "id", "slug", "name", "avatarIcon", "parentTeamId", "managerAgentId" }],
  "agents":  [{ "id", "name", "title", "status", "avatarIcon", "reportsToAgentId", "teamIds": [] }],
  "members": [{ "userId", "name", "avatarUrl", "teamIds": [] }]   // v1: tenant owner (+ roster users)
}
```

Rendering (client, **no new dependency** — hand-rolled tidy-tree like the KB workbench
tree; Paperclip proves custom SVG is enough): root node = Organization; children =
top-level Teams and team-less Agents. Inside a Team subtree, agents order by
`reportsToAgentId` chains (manager first), humans last. SVG elbow connectors + absolutely
positioned cards, pan (drag) + zoom (wheel/buttons), click-through to agent/team pages.
Server keeps the payload flat; the tree is a pure client function (unit-testable).

Reached from the sidebar Teams page and from the Organization section in Settings.

## 6. Prebuilt companies — the `ever-works/orgs` catalog

### 6.1 Repo layout (ADR-014: separate repo, platform ships reader code only)

```
ever-works/orgs
├── README.md                # what it is, format docs, credits (see §6.4), install snippet
├── LICENSE                  # MIT — "Ever Works contributors"
├── CONTRIBUTING.md          # how to add a company; validation instructions
├── manifest.json            # THE index the platform reads (schema/orgs-manifest.schema.json)
├── schema/orgs-manifest.schema.json
├── .github/workflows/validate.yml   # ajv manifest check + per-company structural check
└── companies/<slug>/        # one agentcompanies/v1 package per folder
    ├── COMPANY.md           #   name, description, slug, schema: agentcompanies/v1, version, license, goals
    ├── teams/<slug>/TEAM.md #   manager: ../../agents/<slug>/AGENTS.md, includes: [...]
    ├── agents/<slug>/AGENTS.md  # name, title, reportsTo: <bare-agent-slug>|null, skills: [shortnames]
    ├── projects/<slug>/PROJECT.md  (+ projects/<slug>/tasks/<slug>/TASK.md)
    ├── skills/<slug>/SKILL.md      # standard Agent Skills, never redefined
    ├── images/org-chart.svg
    └── .works/company.yml   # OUR vendor sidecar (.works/<entity>.yml convention,
                             # like mission.yml / agent.yml) — see §6.3
```

`manifest.json` (v1) mirrors the agents-repo pattern:

```jsonc
{
  "$schema": "./schema/orgs-manifest.schema.json",
  "version": 1,
  "companies": [{
    "slug": "ever-starter", "path": "companies/ever-starter",
    "name": "Ever Starter Co", "description": "…", "category": "general",
    "agents": 8, "teams": 2, "skills": 4, "projects": 1,
    "avatarIcon": "rocket", "tags": ["starter"], "featured": true
  }]
}
```

### 6.2 Import mapping (`CompanyImportService`)

| Package file | Creates | Notes |
|---|---|---|
| `COMPANY.md` | **Organization** | name/slug (user may override name in the wizard); goals → org `metadata`; lazy Tenant as usual |
| `teams/*/TEAM.md` | **Team** rows | `manager:` path → `managerAgentId`; `includes:` agent paths → roster rows; nested team includes → `parentTeamId` |
| `agents/*/AGENTS.md` | **Agent** rows | scope `tenant`, org-stamped; markdown body → DB-inline `agentsMd` (the tenant-scope E9 path); `reportsTo` slug → `reportsToAgentId` (second pass after all slugs resolve, Paperclip-style); **heartbeat disabled + status paused** on arrival |
| `AGENTS.md skills:` shortnames | **Skill** rows + `SkillBinding(targetType='agent')` | resolved against the package's `skills/` dir; unknown shortnames skipped with a warning in the import report |
| `projects/*/PROJECT.md` | **draft Work** | new `createDraftWork` sibling of `createCompanyWork` (bare row, `kind:'default'`, `status:'draft'`, no repo/generation side-effects); body → Work description |
| `projects/*/tasks/*/TASK.md`, `tasks/*` | **Task** rows | `assignee:` slug → `TaskAssignee(actorType='agent')`; `project:` → the created Work's `workId` |
| `.works/company.yml` | hints | §6.3; unknown vendor files (e.g. `.paperclip.yaml`) are **ignored silently** — required for cross-vendor compat |

Fetching uses the existing `GitFacadeService.getFileContent` path with the platform
GitHub App / `EVER_WORKS_ORGS_TOKEN` / `GITHUB_TOKEN` fallback chain (tokenless →
raw.githubusercontent.com, the repos are public), ref pinned via `EVER_WORKS_ORGS_REF`,
1h `cache_entries` TTL (catalog + per-company package), and the same sanitization the
agent-template service applies (slug regex allowlist, `stripHtml`, length caps).
Server-side caps: ≤ 50 agents, ≤ 20 teams, ≤ 20 works, ≤ 200 tasks, ≤ 60 skills per
import. The CATALOG's own validation caps (50 agents / 10 teams / 40 skills / 2
projects, `ever-works/orgs` `scripts/validate.mjs`) are deliberately a strict subset of
these importer caps, so every published company always imports whole; over-cap content
in a hand-built package is truncated AND reported in `skipped[]`, never silent.

Failure model: Organization creation is the pivot. If it succeeds and a later entity
fails validation, the import **continues** and returns a per-entity report
(`created[] / skipped[{path, reason}]`) — the Paperclip preview/report pattern without
the preview round-trip in v1 (Q2 covers adding a preview step).

### 6.3 `.works/company.yml` (vendor extension, `schema: everworks/v1`)

The spec reserves vendor sidecars; ours carries only platform mapping hints, never
secrets:

```yaml
schema: everworks/v1
agents:
  ceo:
    template: starter-pm        # optional ever-works/agents slug to merge identity files from
    heartbeatCadence: null      # stays off unless the user enables it post-import
company:
  suggestedWorkKind: default
```

### 6.4 Content & licensing rules for `ever-works/orgs`

- **Original prose only.** Companies are *inspired by* the paperclipai/companies catalog
  (same idea: engineering shop, research lab, game studio, …) but every COMPANY/TEAM/
  AGENTS/SKILL body is written fresh for Ever Works. No `.paperclip.yaml`, no
  SOUL/HEARTBEAT/TOOLS runtime scaffolding, no `paperclip`/`para-memory-files` skill
  refs, no "Generated with company-creator" credit lines.
- **Credit up front:** README credits `paperclipai/companies` (and agentcompanies.io)
  with links, as the catalog that pioneered the format. Where a company adapts the
  *structure* of an upstream one, its COMPANY.md carries `metadata.sources` with
  `usage: referenced` per the spec.
- **License hygiene:** repo is MIT. Nothing derived from CC-BY-SA sources (i.e. no
  Trail-of-Bits-derived content) ships in v1 — share-alike doesn't mix with MIT.

## 7. Chat & MCP

- `@ApiOperation` on every new route ⇒ MCP whitelist tools derive automatically
  (`apps/mcp/src/openapi-tools/whitelist.ts` entry added).
- Hand-written `apps/web/src/lib/ai/tools/teams.tools.ts` (pre-#1200 pattern):
  `list_teams`, `create_team`, `add_team_member`, `get_org_chart` — thin wrappers over
  the same server actions the UI uses. Registry rows follow when chat-everything merges.

## 8. Security

- All team routes behind `OrganizationOwnershipGuard`; writes `@OrgAdmin()`; cross-org
  probes 404. Roster mutations re-validate that the referenced agent/user belongs to the
  caller's tenant/org (IDOR guard — same class as the Idea-accept fix).
- Import: catalog slugs only in v1 (no user-supplied repo URLs ⇒ no SSRF surface);
  every markdown body sanitized on render (never `dangerouslySetInnerHTML`); yaml parsed
  with safe schema; per-entity size caps (§6.2); imported agents cannot run until a human
  enables them (paused + heartbeat off).
- `team_members.role` is display-only — explicitly **not** an authorization input, so it
  does not pre-empt the deferred per-org-roles decision.

## 9. Naming (user-facing)

"**Teams**", "**Org Chart**", "**Company templates**" / "Start from a template". Never
"Departments", never "Projects" for Works, never "Workspace/Tenant". The Organization ↔
Company equivalence stays exactly as documented in the tenants-and-orgs spec.

## 10. Open questions

- **Q1** Tenant-level (org-less) Teams? v1: no — Teams require an Organization.
- **Q2** Import preview step (Paperclip-style checkbox tree) before applying a template?
  v1 imports whole packages (small, curated); preview lands with arbitrary-repo import.
- **Q3** Arbitrary GitHub repo import (`owner/repo/path`, SSRF-guarded like
  `missionTemplateRepo`) — v1.1 candidate; unlocks installing any agentcompanies/v1
  package, including Paperclip's catalog.
- **Q4** Company **export** (Organization → agentcompanies/v1 package) — natural sequel;
  requires the secrets-scrubbing rules from the spec's exporter section.
- **Q5** Registering Ever Works as a `companies.sh` provider (PR to
  `paperclipai/companies-tool`; needs a CLI import entrypoint) — after Q3/Q4.
- **Q6** `reportsToAgentId`-aware delegation (task routing down the chain) — future spec.
