# Feature Specification: Record Visibility

**Feature ID**: `record-visibility`
**Status**: `Draft` (EW-P1-3)
**Created**: 2026-10-15
**Last updated**: 2026-10-16
**Owner**: Product (Ruslan)

> **Problem.** Tasks, goals, missions, ideas and agents are private to their owner: every list filters on
> `userId = caller` (`task.repository.ts`, `ownership-scope.ts`), so two members of one organization never see each
> other's tasks, and a user assigned to a task cannot even list it. Only Teams are org-wide. An organization-level
> integration (Ever Gauzy) has no shared view to sync.
>
> **Owner decisions.** D6: keep today's per-user ownership and **add** visibility through the org, teams, works and
> participants. D11 (2026-10-15): a record attached to a Team is team-scoped; a record with no team is organization-scoped
> — for new **and existing** org records, applied automatically by the migration, with no opt-in and no "share" action.
> Owners can still mark a record `private`.
>
> **Hard rule (additive only):** the owner keeps every right they have today; `Mine` stays the default tab.

---

## 1. Columns

- `visibility varchar(16) NOT NULL DEFAULT 'private'` (`private` | `team` | `organization`) and
  `visibilityExplicit boolean NOT NULL DEFAULT false` on `tasks`, `goals`, `missions`, `work_proposals` and `agents`.
- `team_resources.resourceType` gains `goal`, so goals can sit on a team like every other resource (goal form shows
  and edits its teams).

## 2. Backfill (same migration)

- Every existing **org-scope** row (`organizationId IS NOT NULL`): `team` if it sits on a team (`teamId`,
  `team_resources`, or for agents a team membership), otherwise `organization`; `visibilityExplicit = false`.
- Personal-scope rows (`organizationId IS NULL`) stay `private`.
- **Roster backfill**: insert an `organization_members` row for every active user whose `tenantId` matches the org's
  tenant. They already have tenant-wide access (a user joins a tenant only by accepting an organization invitation, and
  `organization-membership.service.ts` authorizes on `user.tenantId === org.tenantId`), so access does not change. The
  roster only records that existing membership; it grants no permission by itself, and it is not what authorizes a
  write — an integration's act-as user still passes that user's own permission checks for every operation
  ([`integration-keys`](../integration-keys/spec.md) §2).
    - **As implemented (migration `1795070000000-AddRecordVisibility`):** the rows go to every active, non-anonymous
      user of the tenant who holds **no** roster row in that tenant yet — the members who joined before
      `organization_members` was written (it is empty in production) — one row per organization of the tenant, since
      nothing records which one they were invited to. A user who already holds a row joined through the roster-era
      invitation flow, which records the organization they were invited to; adding sibling-organization rows for them
      would change what `removeMember` revokes, so they are left alone. The tenant owner gets no row: a member by
      construction (`listMembers` synthesizes the row, seat counting already counts them), and the access policy treats
      the owner as a member of every organization of their tenant. `joinedAt` = the later of the organization's and the
      account's creation. `down()` keeps these rows (they state true membership and cannot be told apart from later
      invitation rows).
- **Insert-time default (§5) ships with the columns:** an entity `@BeforeInsert` listener on the five entities, plus
  `ScopeStampingSubscriber` after it stamps the scope (the entity listener runs first), set `team` / `organization` on
  new org rows, so no org row is created `private` between this migration and the read policy.

## 3. Who can read an org-scoped record

1. **`private`**: the **owner** (today's rule) and the **participants** — task assignees, approvers, reviewers and
   watchers.
2. **`team`**: also the **members of the record's teams** (`teamId` and `team_resources`) and of its Work
   (`work_members`).
3. **`organization`**: also every member of the org (roster).

## 4. Who can write

- Writes stay with the owner and the existing role rules.
- Participants may comment and transition, as the existing assignee rules allow.
- Connected-group and org readers may comment.

## 5. Defaults and automatic scope

- **New records in an org scope**: `team` when created with a team, otherwise `organization`. Personal-scope records
  stay `private`.
- **While `visibilityExplicit = false`**: adding the first team narrows `organization` → `team`; removing the last team
  widens `team` → `organization`.
- Choosing a visibility by hand sets `visibilityExplicit = true` and stops automatic changes. `private` is only ever set
  by hand.
- **Integration writes** may set `team` or `organization` (`422 domain_rule` for `private`) and send `teamIds[]`, stored
  as `teamId` (first) plus `team_resources` (rest).

**As implemented (`RecordVisibilityService`, `packages/agent/src/record-visibility/`):**

- `setVisibility(aggregate, id, choice)` — `private` / `team` / `organization` by hand (`visibilityExplicit = true`) or
  `automatic` (clears the flag and re-applies D11). A personal record takes `private` / `automatic` only (400).
- `recomputeAutomatic(aggregate, id)` runs after every Team change: `team_resources` attach / detach
  (`TeamResourcesService`), an agent joining or leaving a Team (`TeamsService.addMember` / `removeMember`), a task's
  `teamId` set or cleared (`TasksService.update`), and a Team deleted (`TeamsService.remove` collects its records first,
  since `team_resources` / `team_members` cascade and `tasks.teamId` is SET NULL). No-op for a hand-picked value and for
  a personal record; never fails the Team write that triggered it.
- `setTeams(aggregate, id, teamIds)` — the record's Teams as one set (integration `teamIds[]`, the goal form): for a task
  the first is `teamId` and the rest `team_resources`; for the others every id is a `team_resources` row. Every Team
  must belong to the record's organization (404). D11 then re-applies.
- `assertIntegrationVisibility` — `private` → `422` `{ error: { code: 'domain_rule' } }`.
- **API (the forms' control):** `GET /api/record-visibility/:aggregate/:id` (anyone who may read: state + `canEdit`),
  `PUT /api/record-visibility/:aggregate/:id` `{ visibility }` and `PUT …/teams` `{ teamIds }` (the owner; 404
  otherwise; an integration principal may not choose `private`).

## 6. Organization roster

`organization_members` becomes the source of truth for "member of the org": kept in sync on invite accept and on
removal (removal emits `organization.member.removed`).

## 7. UI

- A visibility control (lock / team / org icon) on the task, goal, mission, idea and agent forms. It shows
  "Automatic" until the user picks a value.
- List tabs **Mine | Shared with me | Organization** on `/tasks`, `/goals`, `/missions`, `/ideas` and `/agents`; `Mine`
  stays the default.

**As implemented (web):** `components/record-visibility/` — `RecordViewTabs` (the tab lives in `?tab=` on the web URL,
because `/tasks` already uses `?view=` for board / list; sent to the API as `view`; every other filter is kept and paging
resets), `VisibilityControl` (lock / team / organization icon; "Automatic (…)" until a value is picked; only the owner
gets the picker), `RecordTeamsEditor` (the goal's Teams) and `RecordVisibilityPanel` (both, the control re-reads after a
Teams save). Other locales fall back to `en.json` through the request-time deep merge.

## 8. Implementation shape

One `RecordAccessPolicy` service plus a repository helper `visibleTo(principal)`. Every list and get path goes through
it, replacing the scattered `userId = caller` filters; each replaced filter becomes a test case. The integration
principal reads every row in its pinned orgs with `visibility` `team` or `organization`.

**As implemented** (`packages/agent/src/record-visibility/`):

- `visibleToPredicate()` (`visible-to.ts`) is the one SQL predicate for all five aggregates. A user reads a row when they
  own it; take part in it (tasks: user assignee, approver, reviewer, watcher — any visibility); reach it through a Team
  (`tasks.teamId`, `team_resources` of the type, an agent's `team_members`) or a Work they own or belong to
  (`tasks.workId`, `agents.workId`, `mission_works`) when it is `team` / `organization`; or are an organization member
  (roster row, or the tenant owner) when it is `organization`. Personal scope stays owner-only. The integration
  principal reads `team` / `organization` rows of its pinned organizations.
- `RecordAccessPolicy` resolves the caller's roster, Teams and Works **once per request** (`contextFor`) and exposes
  `isOrganizationMember(orgId, userId)` (the authoritative roster for act-as, EW-P1-2) and `isTaskParticipant`.
- **Views:** `?view=mine|shared|organization` on `GET /api/tasks` (and the board), `/api/me/goals`, `/api/me/missions`,
  `/api/me/work-proposals` and `/api/agents`. `mine` (default, also for unknown values) is the unchanged owner query;
  `shared` = rows the caller does not own but takes part in or reaches through a Team / Work; `organization` = every
  readable row of the active organization, own rows included.
- **Get by id:** a new `getReadable` (tasks, goals, missions, ideas, agents) answers the owner exactly as before, then
  falls back to `visibleTo`. Only the `GET /:id` routes use it: **every write route keeps its owner-only gate**
  (`getOne` / `getForUser` / `requireOwned`), several of which other routes use as an ownership check.
- **Writes (§4):** a task's user assignees, approvers and reviewers may transition it (watchers and other readers get
  403); anyone who can read a task may list and post comments, and edit their own; a non-owner's `@agent` mention is
  kept on the message but never dispatches a run (no spend, no agent work on somebody else's task).

## 9. Events

A change of visibility records `<aggregate>.visibility_changed` ([`domain-events`](../domain-events/spec.md)). A change
**to** `private` carries only `{id, visibility:'private'}` so consumers stop syncing without seeing the content.

**As implemented:** recorded through the domain-event recorder (EW-P1-1) in the same transaction as the change, with
the aggregate `version` bumped: `task.visibility_changed` and `agent.visibility_changed` (P1, versioned aggregates).
To `team` / `organization`: `{ id, organizationId, visibility, visibilityExplicit, version, teamIds }` (valid against
`visibility-changed.schema.json`; the full integration DTO joins with the B2 snapshot builders). Goals, missions and ideas
record once they carry a `version` column (their P2 recording points) — the hook is marked in `recordChange`.

## 10. Acceptance criteria

- [ ] Visibility matrix: owner, participant, team member, work member, org member, outsider, integration principal ×
      `private` / `team` / `organization`.
- [ ] Automatic team ↔ organization changes while `visibilityExplicit = false`, none after a manual choice.
- [ ] Existing org rows are `team`/`organization` after the migration; personal rows stay `private`; `down` reverts.
- [ ] `Mine` lists exactly what it lists today.
