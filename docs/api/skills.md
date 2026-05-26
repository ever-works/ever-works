---
id: skills
title: Skills API
sidebar_label: Skills
sidebar_position: 41
---

# Skills API

Reusable, versioned Markdown-with-frontmatter instructions Agents
pull in when relevant. Shipped as a plugin capability per ADR-012;
the first-party **Ever Works Skills** plugin sources the curated
catalog from the [`ever-works/skills`](https://github.com/ever-works/skills)
GitHub repo.

All routes are `@CurrentUser()`-scoped. Cross-user reads return 404.

## Catalog (read-only union across enabled `skills-provider` plugins)

| Method | Path                        | Description                                                                                |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/skills/catalog`       | Paginated catalog union. Query: `limit`, `offset`, `search`, `tags=a,b`. (global throttle) |
| GET    | `/api/skills/catalog/:slug` | One catalog entry by slug.                                                                 |

## Installed Skills (per-user)

| Method | Path                  | Description                                                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/skills`         | List my Skills (filter: ownerType / ownerId / search).                                       |
| GET    | `/api/skills/:id`     | Get one.                                                                                     |
| POST   | `/api/skills`         | Create a custom Skill. (30/min)                                                              |
| PATCH  | `/api/skills/:id`     | Update body / frontmatter. (60/min — autosave-friendly)                                      |
| DELETE | `/api/skills/:id`     | Delete (cascades to bindings). (30/min)                                                      |
| POST   | `/api/skills/install` | Install a catalog skill at the requested scope. Body: `{slug, ownerType, ownerId}`. (60/min) |

## Bindings

Many-to-many between Skills and targets (Agent / Work / Mission /
Idea / Tenant). Resolution priority: lower number wins. Bindings
with `injectIntoAgent=false` are excluded from AI-run prompt
assembly; `injectIntoGenerator=true` surfaces them on Work
generator runs.

| Method | Path                       | Description                                                                                                   |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/skills/:id/bindings` | List all bindings of one Skill.                                                                               |
| POST   | `/api/skills/:id/bindings` | Create a binding. Body: `{targetType, targetId, priority?, injectIntoAgent?, injectIntoGenerator?}`. (60/min) |
| DELETE | `/api/skill-bindings/:id`  | Remove one binding by id. (60/min)                                                                            |

## Notes

- `SkillBindingRepository.resolveActive()` is the single source
  of truth for "which skills apply to this AI run?". Used by
  `AgentRunService` (Phase 10) and `AiFacadeService.assembleSystemMessage()`
  (Phase 10).
- Activity-log rows: `SKILL_INSTALLED`, `SKILL_ATTACHED_TO_AGENT`,
  `SKILL_INVOKED`, `SKILL_FILE_EDITED`.
- All body writes are secret-scanned (hard-reject) and capped at
  64 KB (mirrors Agent files).
