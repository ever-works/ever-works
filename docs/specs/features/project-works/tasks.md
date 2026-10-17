# Task Breakdown: Project Works (EW-P2-4)

- [x] **T1** Contracts: `project` kind, capabilities (no repository), `isProjectWorkKind`, `workKindHasRepository`;
      pinned tests and `docs/features/work-kinds.md`.
- [x] **T2** Switch `EVER_WORKS_PROJECT_WORKS_ENABLED` (default off) + CI default-off scanner + `.env.example`.
- [x] **T3** `createProjectWork` + `POST /api/works/projects`.
- [x] **T4** Content pipelines refuse Project Works (`assertNotRepositoryWork`).
- [x] **T5** Tasks run without a repository (`resolveTaskRepository` → none; every caller; agent git tools refuse).
- [x] **T6** `GET /api/works?kind=` filter.
- [x] **T7** Web: kind presentation + `dashboard.workKind.project` in 21 locales.
- [ ] **T8** Web: a "Project" create entry (behind the same switch, published on `/api/config`) and a kind filter on
      `/works`.
- [ ] **T9** Knowledge base on Project Works: a repo-less KB mirror rule (DB only), then `kb: true`.
- [ ] **T10** Integration API (EW-P1-4): create / link Project Works for Gauzy projects through `createProjectWork`.
- [ ] **T11** Anonymous statistics: a `project` key in `ever.stats.v1` `counts.works_by_kind` (a contract release of
      `@ever-co/connect-contracts`), then drop `project` from `WORK_KINDS_WITHOUT_STATS_KEY`
      (`apps/api/src/instance-stats/instance-stats.mapping.ts`). Until then Project Works are counted under `other`.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.
