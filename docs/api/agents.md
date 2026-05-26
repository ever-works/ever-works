---
id: agents
title: Agents API
sidebar_label: Agents
sidebar_position: 40
---

# Agents API

User-defined AI Agents — the surface introduced in PR [#1017](https://github.com/ever-works/ever-works/pull/1017)
("Agents / Skills / Tasks"). Each Agent carries an identity (`SOUL.md`),
a role (`AGENTS.md`), a heartbeat directive (`HEARTBEAT.md`), tools
(`TOOLS.md`), an agent.yml manifest, plus runtime settings (provider
+ model, permissions, heartbeat cadence, budgets).

All routes are `@CurrentUser()`-scoped. Cross-user reads return 404
(no existence leak via 403 — `security-agents-skills-tasks.md §9`).

## CRUD

| Method | Path                       | Description                                    |
| ------ | -------------------------- | ---------------------------------------------- |
| GET    | `/api/agents`              | List my Agents (filter: scope/status/target/q) |
| POST   | `/api/agents`              | Create a new Agent (30/min)                    |
| GET    | `/api/agents/:id`          | Get one                                         |
| PATCH  | `/api/agents/:id`          | Partial update (30/min)                         |
| DELETE | `/api/agents/:id`          | Archive (soft); pass `?hard=true` to delete    |
| POST   | `/api/agents/:id/pause`    | ACTIVE → PAUSED (30/min)                       |
| POST   | `/api/agents/:id/resume`   | PAUSED/ERROR → ACTIVE (30/min)                 |

## Agent definition files

The 5 canonical files are stored inline on `agents.{soulMd, agentsMd,
heartbeatMd, toolsMd, agentYml}` for tenant-scope (Phase 4 / ADR-008).
Mission/Work/Idea-scope Agents store the same files in the scope repo
via `.works/agents/<slug>/<file>` (Phase 6 follow-up).

| Method | Path                              | Description                                                                                |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/agents/:id/files/:name`     | Read one file. Returns `{name, body, hash, storage}`.                                       |
| PUT    | `/api/agents/:id/files/:name`     | Replace one file body. Body: `{body, expectedHash?}`. 64 KB cap + secret-scan + ETag (60/min). |

## Export / import

Per-Agent JSON envelope round-trip (Phase 6a, N5 override).

| Method | Path                                        | Description                                                                                                  |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/agents/:id/export`                    | Returns `AgentExportEnvelope` (identity / model / runtime / avatar / files / bindings / budget). (30/min)    |
| POST   | `/api/agents/import?onConflict=&scope=&missionId=&ideaId=&workId=` | Import an envelope. Conflict modes: `skip` / `overwrite` / `rename` (default rename). (30/min)               |

## Notes

- Status transitions are guarded by the state-machine in
  `AgentsService.transition()`. Disallowed moves return 400.
- Activity-log rows are emitted on every mutation:
  `AGENT_CREATED / UPDATED / PAUSED / RESUMED / ARCHIVED / DELETED /
  FILE_EDITED / FILE_REVERTED / FILE_EDIT_FAILED / BUDGET_EXCEEDED /
  EXPORTED / IMPORTED / HEARTBEAT_STARTED / HEARTBEAT_COMPLETED /
  HEARTBEAT_FAILED / RUN_CANCELLED`.
- Heartbeat dispatch lives in `agent-heartbeat-dispatcher.task.ts`
  (Trigger.dev cron). Per-Agent runs land in `agent-heartbeat.task.ts`
  with a CAS-claim on `agents.nextHeartbeatAt`.
