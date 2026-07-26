export * from './anonymous-user-cleanup.task';
export * from './data-repo-sync-dispatcher.task';
export * from './deploy-ready-poller.task';
export * from './kb-backfill-skeleton.task';
export * from './kb-embed-document.task';
export * from './kb-mirror-document.task';
export * from './kb-org-overlay-fanout.task';
export * from './kb-reconcile.task';
export * from './agent-run-sweeper.task';
export * from './terminal-session.task';
export * from './task-branch-gc.task';
// Desktop PRD M4 — return lapsed fleet-job leases to the pool so a
// fleet whose nodes ALL died still converges (inline reclaim on the
// lease path covers every other case).
export * from './fleet-job-lease-sweeper.task';
export * from './user-research-rerun-dispatcher.task';
export * from './mission-tick.task';
// PR-4 — Idea → Work build executor (flag-gated, dry-run by default).
export * from './idea-build-execute.task';
// Goals & Metrics PR-8 — per-minute Goal evaluation dispatcher.
export * from './goal-evaluate-dispatcher.task';
export * from './agent-heartbeat-dispatcher.task';
export * from './agent-heartbeat.task';
export * from './agent-task-execute.task';
export * from './agent-chat-reply.task';
export * from './task-recurrence-dispatcher.task';
export * from './template-customization.task';
export * from './work-generation.task';
export * from './work-import.task';
export * from './work-onboarding.task';
export * from './work-schedule-dispatcher.task';
export * from './webhook-delivery.task';
// EW-693 — long-running plugin execution (Phase 7 / T27).
export * from './run-plugin-operation.task';
// Pricing Wave 9 M1 — daily free-credit grant (idempotent per user/day).
export * from './credits-daily-grant.task';
// Memory upgrades M9 — scheduled consolidation pass (opt-in per org,
// dry-run by default, never auto-applied).
export * from './memory-consolidation-tick.task';
