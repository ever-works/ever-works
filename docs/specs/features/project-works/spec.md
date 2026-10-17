# Feature Specification: Project Works (`project` Work kind)

**Feature ID**: `project-works` · **Plan item**: EW-P2-4 · **Status**: `In progress` · **Created**: 2026-10-16

## 1. Why

Every Work kind today provisions at least one git repository, and the create path, the content pipelines and the
Task execution path all assume one exists. Plain project tracking — and a Gauzy project mirrored into Ever Works — has
no code and no generated site: it needs a Work that holds Tasks, Goals, Missions and a team, and nothing else.

## 2. What

- **Kind** `project` in `WORK_KINDS` (`@ever-works/contracts`), inserted before `default`. **Not** user-selectable:
  the general `POST /api/works` cannot mint it (unknown/unlisted kinds are coerced as today).
- **Capabilities** (`WORK_KIND_CAPABILITIES.project`): `repos: { data: false, work: false, website: false }`; deploy,
  builds, app environment, knowledge base, items, taxonomy, comparisons, community PRs, item import/export and source
  validation all off; metric tiles Agents · Open Tasks · Days Active. Helpers: `isProjectWorkKind(kind)`,
  `workKindHasRepository(kind)` (false only for `project`).
- **Switch** `EVER_WORKS_PROJECT_WORKS_ENABLED`: exactly `true` is on; unset/empty/anything else is **off** (the
  default). Registered with `scripts/ci/check-default-off-switches.mjs`, so a deploy manifest cannot turn it on
  silently.
- **Create**: `POST /api/works/projects` `{ name, slug?, description? }` → `201` + the Work. With the switch off:
  `400 { code: 'project_works_disabled' }`. A derived slug takes the first free `<slug>-N`; an explicit slug that is
  taken is refused (`400`). `WorkLifecycleService.createProjectWork` writes a bare row (`deployProvider: null`, no
  template, no repository, no generation, not counted against the Deploy quota), stamped with the request's
  tenant/organization scope like every Work.
- **Pipelines refuse it**: `assertNotRepositoryWork` — the guard every generation, item, README, comparison,
  community-PR, source-validation and template entry point already calls — refuses a Project Work with
  `400 "… is a Project Work — <action> is not available for it …"`. `assertRepositoryRole` refuses every role.
- **Tasks run without a repository**:
    - `resolveTaskRepository(work)` answers `null` (none) for a repo-less kind; `kindHasTaskRepository(kind)` is false.
    - Run path: `TaskWorkspaceService.provisionForRun` returns no workspace (as with isolation off), so the run proceeds
      without one; the gate and `finalizeRun` only run with a workspace.
    - Fleet: `describeFleetWorkspace` returns `null`, which the planner already turns into "no repository to work in".
    - Agent git tools (`commitToRepo`, `openPullRequest`) refuse up front: "… Work with no repository — there is
      nothing to commit to or open a pull request against".
    - Merge attempts and branch clean-up skip it; PR-status, agent review, release promotion/verification and the App
      Work gates use `requireTaskRepository`, a `400` floor (unreachable: a Project Work's Tasks never get a branch
      or PR). `findTaskForPullRequest` never matches a repo-less Work's derived names.
- **Works list**: `GET /api/works?kind=<kind>` filters by exact persisted kind (additive; absent = every kind; an
  unknown kind → `400`). The count honours the filter.
- **Web**: a `project` presentation entry (badge, lime tone, `ClipboardList` icon) and a translated
  `dashboard.workKind.project` label in all 21 locales, so a Project Work renders correctly wherever a kind badge is
  shown. No create chip yet (a later UI slice, see tasks).
- **Anonymous statistics** (`ever.stats.v1`): the published `works_by_kind` keys are a closed list with no `project`
  key yet, so Project Works are counted under `other` — on purpose, listed in `WORK_KINDS_WITHOUT_STATS_KEY`; the
  guard test still fails for any other new kind without a key.

## 3. Not in scope (this slice)

- A create chip / form in the web app, and a kind filter control on `/works` (the API filter ships first).
- The knowledge base on Project Works (KB documents mirror to the Work's git repository; needs a repo-less mirror
  rule first).
- Creating Project Works from the integration API (`/integrations/v1`, EW-P1-4) — that route will call
  `createProjectWork` once it exists.
- A `project` key in the `ever.stats.v1` schema (a contract release in `@ever-co/connect-contracts`; task T11).

## 4. Acceptance

- [ ] With the switch off, `POST /api/works/projects` answers `400 project_works_disabled`; with it on, `201` and a
      Work of kind `project` with `deployProvider: null` and no repository created.
- [ ] Generation / items / deploy routes refuse a Project Work with the Project refusal.
- [ ] A Task on a Project Work runs (cloud) without a workspace; a fleet run is refused "no repository to work in";
      the agent git tools refuse.
- [ ] `GET /api/works?kind=project` lists only Project Works and counts them.
- [ ] Every existing kind behaves exactly as before (capabilities, Task repository, list without `kind`).
