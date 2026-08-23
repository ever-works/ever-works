# Fleet Agent-to-Node Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Persist an active-Organization Agent-to-user-owned-node binding, snapshot it onto future `agent-task` Fleet jobs, and enforce it during lease selection.

**Architecture:** A new agent-package affinity entity/repository/service owns validation and lookup. The authenticated API controller supplies the active Organization boundary. `FleetJobService` resolves a binding only while enqueueing `agent-task` work and stores a nullable immutable target snapshot; lease filtering rejects other nodes before capability checks and the existing CAS claim.

**Tech Stack:** TypeScript, NestJS 11, TypeORM 0.3, Jest, pnpm, PostgreSQL/SQLite-compatible schema.

**Spec:** `docs/specs/fleet-agent-node-affinity/design.md`

## Global Constraints

- Work only in `codex/fleet-agent-node-affinity` from current `origin/develop`.
- Do not edit the shared dirty checkout or the credential-passthrough files owned by the overlapping Fleet stream.
- Additive code/migration only; do not deploy, enroll nodes, execute repository jobs, merge, or cascade.
- Keep nodes user-owned and bindings scoped to the authenticated user plus active Organization.
- Preserve existing Fleet data and scheduling for unbound jobs.
- Write and observe each focused failing test before its implementation.

---

## Task 1: Capture the scheduling contract in failing service tests

- [ ] Extend `packages/agent/src/fleet/__tests__/fleet-job.service.spec.ts` with literal fixtures proving target snapshot and strict lease behavior.
- [ ] Add a failing test showing an `agent-task` enqueue snapshots the current scoped binding.
- [ ] Add a failing test showing the wrong owner node is skipped even when capabilities match.
- [ ] Add a failing test showing the target node wins through the existing CAS.
- [ ] Retain explicit coverage for unbound/non-agent jobs.
- [ ] Run the focused Jest file and confirm failures are due to missing affinity/target behavior.

## Task 2: Add the additive persistence model

- [ ] Add `FleetAgentNodeAffinity` and nullable `FleetJob.targetNodeId` entities.
- [ ] Register the new entity in the entity barrel, Fleet module, and concrete DataSource inventory.
- [ ] Add the affinity repository with owner + Organization + Agent lookup/upsert.
- [ ] Add one additive API migration creating the affinity table, indexes, and Fleet job target column/index.
- [ ] Add/extend schema inventory tests where the repository already asserts registered entities.
- [ ] Run the focused entity/database tests and type check.

## Task 3: Implement snapshot and lease enforcement

- [ ] Inject the affinity repository into `FleetJobService`.
- [ ] Resolve only `agent-task` payloads with a non-empty string `agentId` and a non-null job Organization.
- [ ] Pass the resolved node id into `FleetJobRepository.create` as `targetNodeId`.
- [ ] Include `targetNodeId` in `FleetJobView` mapping and the Fleet job contract.
- [ ] Skip candidates targeted at a different node before capability filtering.
- [ ] Run the focused Fleet job tests to GREEN, then refactor without changing behavior.

## Task 4: Add owner/Organization-validated binding operations

- [ ] Add affinity service tests for owned scoped success, unknown/foreign Agent, foreign node, and personal scope.
- [ ] Observe RED before implementing validation.
- [ ] Implement the service using real Agent/Fleet node repository lookups and one non-enumerating not-found path.
- [ ] Add the API DTO and dedicated Fleet Agent affinity controller.
- [ ] Add controller tests proving active-Organization propagation and personal-scope refusal.
- [ ] Register the controller in `apps/api/src/fleet/fleet.module.ts` without touching the overlapping run router.
- [ ] Run focused service/controller tests to GREEN.

## Task 5: Verify the complete code-only slice

- [ ] Run Prettier on changed TypeScript/Markdown files.
- [ ] Run focused agent Fleet tests and API controller tests.
- [ ] Run `@ever-works/contracts`, `@ever-works/agent`, and API type checks/builds proportionate to the change.
- [ ] Inspect `git diff --check`, the complete branch diff, and confirm the shared dirty checkout is untouched.
- [ ] Commit in reviewable TDD-sized commits and push `codex/fleet-agent-node-affinity`.
- [ ] Open a PR targeting `develop`; do not merge or cascade.
- [ ] Read check conclusions and AI/bot review feedback, addressing only verified issues within the claimed slice.

## Task 6: Handoff and release coordination claim

- [ ] Record exact remaining Windows pilot gates: repository/worktree provisioning, model loop, reconciliation, cancellation, dedicated-account installer/service, and signed/private distribution.
- [ ] Move the MAINTENANCE ACTIVE row to CHANGE LOG with commit/PR, verification, no-data statement, and rollback.
- [ ] Commit and push the board release.
- [ ] Report the outcome and whether work continues to task `01a02977-83d2-7fe3-b504-d0351a4cf6f8` on host `local`.
