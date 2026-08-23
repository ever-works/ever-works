# Fleet Agent-to-Node Affinity Design

**Status:** Approved for implementation on 2026-08-22
**Scope:** Code and migration only; no deployment, node enrollment, or live Fleet job execution

## Problem

Fleet nodes can already authenticate, poll, lease, heartbeat, and complete owner-scoped jobs. An `agent-task` job carries an `agentId`, but that identifier is currently correlation data only. Any compatible node owned by the same user can lease the job. Capability tags cannot safely represent affinity because they are self-reported runtime properties, not durable owner intent.

The Windows pilot needs a durable way to say that one Organization Agent executes on one specific user-owned PC. The queue must enforce that decision without weakening the existing owner isolation or compare-and-swap lease authority.

## Decision

Add a durable `FleetAgentNodeAffinity` row keyed by owner, active Organization, and Agent. The row points to a user-owned Fleet node.

- The Agent must belong to the authenticated user and the active Organization.
- The Fleet node must belong to the authenticated user. Nodes remain user-owned and can be reused across Organizations the user can access.
- Unknown and foreign Agent/node identifiers are rejected through the same non-enumerating not-found path.
- The binding endpoint is Organization-only. Personal scope cannot create or read an Organization binding.
- This pilot exposes set/read operations only. It does not delete bindings or any existing Fleet data.

When `FleetJobService.enqueue` receives an `agent-task` job, it resolves `payload.agentId` against the job owner and `organizationId`. A matching affinity is copied into the new nullable `FleetJob.targetNodeId` field. Other job kinds, malformed/missing Agent identifiers, personal-scope jobs, and unbound Agents keep `targetNodeId = null` and preserve current scheduling behavior.

The snapshot is intentional:

- changing a binding affects future jobs only;
- a queued job cannot silently jump PCs while an operator changes configuration;
- historical jobs preserve the scheduling decision used at enqueue time.

During leasing, a candidate is eligible only when `targetNodeId` is null or equals the authenticated node id. This check runs before capability filtering and before the existing compare-and-swap claim. The repository CAS remains the final authority for races.

If a bound node is offline, paused, disabled, or otherwise unavailable, its targeted job remains queued. There is no fallback to a different node. This is strict affinity and prevents repository credentials or worktrees from appearing on an unintended PC.

## Data Model

### `fleet_agent_node_affinities`

| Column                   | Meaning                                       |
| ------------------------ | --------------------------------------------- |
| `id`                     | UUID primary key                              |
| `userId`                 | Owner isolation boundary                      |
| `organizationId`         | Active Organization boundary                  |
| `agentId`                | Organization Agent selected by the owner      |
| `nodeId`                 | User-owned Fleet node selected for that Agent |
| `createdAt`, `updatedAt` | Audit timestamps                              |

Constraints and indexes:

- unique `(userId, organizationId, agentId)` so an Agent has at most one active target;
- lookup index `(userId, organizationId, agentId)`;
- reverse lookup index `(userId, nodeId)` for future node-management views.

The identifiers are durable UUID references without cascading deletion. API/service validation provides the ownership contract while avoiding a new cascade that could remove historical configuration or make existing node lifecycle behavior destructive.

### `fleet_jobs.targetNodeId`

A nullable UUID snapshot. It is indexed with queued scheduling fields and intentionally does not cascade with Fleet node lifecycle. A historical or queued job retains the target decision even if the node later changes state.

## API

Authenticated, session-scoped endpoints:

- `GET /api/fleet/agents/:agentId/node-affinity`
- `PUT /api/fleet/agents/:agentId/node-affinity` with `{ "nodeId": "<uuid>" }`

Both require an active Organization. The response contains `agentId`, `nodeId`, `organizationId`, and timestamps. A missing binding returns `null` from GET; foreign and unknown Agent identifiers use the same not-found response. PUT is an upsert for the authenticated owner and active Organization.

## Failure and Security Semantics

- Never infer affinity from capability tags.
- Never bind an Agent in personal scope.
- Never accept an Agent from another Organization or owner.
- Never accept a Fleet node owned by another user.
- Never retarget an existing job when a binding changes.
- Never let a non-target node claim a targeted job, even when its capabilities match.
- Never fall back to another node when the target is unavailable.
- Preserve the existing owner-scoped candidate query and CAS claim predicates.

## Compatibility

All new columns and rows are additive. Existing Agents, nodes, and jobs remain unbound. Existing job kinds and `agent-task` jobs without a valid scoped binding lease exactly as they do today.

This slice does not enable real repository execution. Repository/worktree provisioning, model-driven Claude/Codex execution, terminal AgentRun/task/Git reconciliation, and cancellation remain required gates before the first real Windows coding task.

## Verification

TDD coverage must prove:

1. owner + active-Organization binding succeeds;
2. foreign/unknown Agent and foreign node paths do not mutate state or enumerate ownership;
3. personal scope cannot create/read a binding;
4. a future `agent-task` job snapshots the current target;
5. changing a binding does not retarget an already queued job;
6. a non-target owner node cannot lease the job even with matching capabilities;
7. the target node can lease it through the existing CAS;
8. unbound and non-agent jobs retain current lease behavior;
9. entity inventory, migration, focused tests, and type checks agree.

## Rollout Boundary

This branch may open a code-only PR to `develop`. It must not be merged, cascaded, deployed, or used to enroll a live Windows node while overlapping Fleet rollout claims remain active. A live pilot needs a separate pushed MAINTENANCE claim plus Organization-scope proof and the remaining reconciliation/cancellation safety gates.
