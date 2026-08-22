# Work Current Health Reconciliation Implementation Plan

> **For Codex:** Execute this plan with systematic debugging, test-driven development, and verification before completion.

**Goal:** Preserve historical generation/deployment outcomes while exposing and displaying a separate, truthful current Work health projection.

**Architecture:** Extend the existing Work read projection with `lastRun` and `currentHealth`. Read the latest production deployment history row in batch, derive paused/idle/running and deployment readiness without mutating tenant data, and let the existing readiness poller idempotently reconcile stale failure projections only after a successful health probe.

**Tech stack:** NestJS, TypeORM, shared TypeScript contracts, Next.js/React, Jest, Vitest/Testing Library.

---

### Task 1: Pin the API projection contract

**Files:**

- Modify: `packages/agent/src/services/__tests__/work-query.service.spec.ts`
- Modify: `packages/agent/src/services/work-query.service.ts`
- Modify: `packages/agent/src/database/repositories/work-deployment.repository.ts`
- Create: `packages/contracts/src/api/work/work-status.dto.ts`
- Modify: `packages/contracts/src/api/work/index.ts`

- [x] Add a failing service test proving an old generation error and deployment timeout remain in `lastRun` while current state is paused/idle and current deployment readiness is independent.
- [x] Add a batched latest-production-deployment lookup.
- [x] Implement the shared contract and pure derivation.
- [x] Run the focused service tests.

### Task 2: Reconcile stale deployment projections safely

**Files:**

- Modify: `packages/agent/src/services/__tests__/deploy-ready-poller.service.spec.ts`
- Modify: `packages/agent/src/services/deploy-ready-poller.service.ts`

- [x] Add a failing test proving stale `TIMEOUT` projections are health-probed.
- [x] Include recoverable stale projection states without editing historical deployment rows.
- [x] Run the focused poller tests.

### Task 3: Separate the list badge from historical run state

**Files:**

- Create: `apps/web/src/components/works/WorkCard.unit.spec.tsx`
- Modify: `apps/web/src/components/works/WorkCard.tsx`
- Modify: `apps/web/src/lib/api/work.ts`

- [x] Add a failing component test proving an idle Work with a failed last run displays current `Idle` as its primary badge while retaining the historical failure affordance.
- [x] Render current health as the primary badge and last-run failure/warnings separately.
- [x] Run focused web tests.

### Task 4: Verify and deliver

- [x] Run focused Jest/Vitest tests, package type checks, formatting/lint checks, and inspect the final diff.
- [ ] Commit and push the feature branch.
- [ ] Open a PR to `develop`, inspect check/review conclusions, and do not merge or deploy.
- [ ] Release the shared maintenance claim with verification and rollback details.
- [ ] Report the outcome to the originating Codex task.
