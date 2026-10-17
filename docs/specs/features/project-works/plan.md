# Implementation Plan: Project Works (EW-P2-4)

**Spec**: [spec.md](./spec.md) · **Branch**: `feat/gw-project-work-kind`

Additive only; today's behaviour is the default; the kind ships dormant behind `EVER_WORKS_PROJECT_WORKS_ENABLED`.
No migration: `works.kind` is `varchar(32)` with no CHECK constraint, so a new value needs no schema change.

1. **Contracts** — `WORK_KINDS` (+ `project` before `default`), `isProjectWorkKind`, `WORK_KIND_CAPABILITIES.project`
   (every repository role off), `workKindHasRepository`. Pinned tests updated (`domain.spec`, `work-capabilities.spec`,
   the docs-parity spec via `docs/features/work-kinds.md`).
2. **Switch** — `config.everWorks.projectWorks.enabled()`, `apps/api/.env.example`, the CI default-off scanner.
3. **Create** — `WorkLifecycleService.createProjectWork` (bare row, refuses when off) +
   `WorkProjectsController` (`POST /api/works/projects`, slug resolution through `checkSlugAvailability`).
4. **Guards** — `assertNotRepositoryWork` refuses `project` too (one place, every pipeline entry point).
5. **Tasks** — `resolveTaskRepository` → `TaskRepositoryTarget | null`; `kindHasTaskRepository`,
   `requireTaskRepository`, `pickOwnerRepo`; every caller handles none (run → no workspace, fleet → `null`, merge /
   branch GC → skip, PR / review / release / App gates → `requireTaskRepository`); agent git tools refuse.
6. **List** — `findAllAccessible` / `countAllAccessible` / `getWorks` take `kind`; `GET /api/works?kind=`.
7. **Web** — presentation entry + i18n label (21 locales). The `Record<WorkKind, …>` makes the entry compile-required.
8. **Tests** — contracts, guard, task repository, workspace run path, create (switch on/off), controller (create,
   list filter), agent git tool refusal; full agent / api / contracts / web suites before merge.
