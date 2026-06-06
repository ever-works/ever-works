# Internal working docs

This folder holds **internal, working/tracking documentation** generated during
development efforts — implementation plans, progress logs, hand-off summaries,
and coverage trackers. It is **not** polished, user-facing documentation.

## Convention — keep these OUT of the repo root

> **Working/progress/plan/summary/tracker docs do NOT belong in the monorepo
> root.** Put them here, under `docs/internal/`.

The repo root is reserved for a small, fixed set of standard files
(`README.md`, `CLAUDE.md`, `AGENTS.md`, `AUGMENT.md`, `LICENSES.md`). Anything
that is effort-scoped or ephemeral — e.g. `*-PLAN.md`, `*-PROGRESS.md`,
`*-SUMMARY.md`, `*-TRACKER.md`, review notes, checklists — goes in
`docs/internal/` (or a feature folder under `docs/specs/<feature>/` when it is
tied to one feature's spec).

These files are intentionally **not** listed in the Docusaurus sidebar
(`apps/docs/sidebarsPlatform.ts`), so they don't surface on the published docs
site — same treatment as `docs/specs/`.

## Contents

| File                         | What it tracked                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `COVERAGE-TRACKER.md`        | Test/docs/specs 100%-coverage progress (auto-updated by the hourly scheduled task; prettier-ignored). |
| `E2E-PLAN.md`                | E2E suite expansion plan.                                                                             |
| `E2E-PROGRESS.md`            | E2E suite progress log.                                                                               |
| `IMPLEMENTATION-PROGRESS.md` | Agents/Skills/Tasks implementation progress.                                                          |
| `IMPLEMENTATION-SUMMARY.md`  | Agents/Skills/Tasks implementation summary / PR scaffold.                                             |
| `FOLLOWUP-PROGRESS.md`       | Agents/Skills/Tasks post-PR-#1019 follow-ups progress.                                                |
| `FOLLOWUP-SUMMARY.md`        | Agents/Skills/Tasks post-PR-#1019 follow-ups summary.                                                 |
