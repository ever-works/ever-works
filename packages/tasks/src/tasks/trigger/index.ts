export * from './anonymous-user-cleanup.task';
export * from './data-repo-sync-dispatcher.task';
export * from './deploy-ready-poller.task';
export * from './kb-backfill-skeleton.task';
export * from './kb-embed-document.task';
export * from './kb-mirror-document.task';
export * from './kb-org-overlay-fanout.task';
export * from './kb-reconcile.task';
export * from './agent-run-sweeper.task';
// Judgment layer G5 — backstop for `workflow_runs` rows abandoned by a
// worker that died without reaching a terminal write. Paired with the
// `onFailure` hook on `workflow-run.task.ts`, which is the primary path.
export * from './workflow-run-sweeper.task';
export * from './terminal-session.task';
// Streaming-terminal M9 / D1 — nightly plan-tier retention sweep over
// persisted terminal transcripts.
export * from './terminal-transcript-gc.task';
export * from './task-branch-gc.task';
// Kanban run cockpit (plan 04 M5/M7) — refresh open-PR status + CI for
// the board review pill, and land Tasks whose PR merged.
export * from './task-pr-status-sync.task';
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
export * from './goal-advance-dispatcher.task';
export * from './agent-heartbeat-dispatcher.task';
export * from './agent-heartbeat.task';
export * from './agent-task-execute.task';
export * from './agent-chat-reply.task';
// Named Conversations — an Agent answers a message in a Conversation.
export * from './agent-conversation-reply.task';
export * from './task-recurrence-dispatcher.task';
// AW-20 P1 — provisions a wired roster (coordinator + lane owners) for
// the setup wizard's "Your agents" step.
export * from './roster-provision.task';
export * from './template-customization.task';
export * from './work-generation.task';
export * from './work-import.task';
export * from './work-onboarding.task';
export * from './work-schedule-dispatcher.task';
export * from './webhook-delivery.task';
// Judgment layer G5 — execute a SAVED workflow graph. The walk can run
// for ~40 minutes, so it cannot live in an API request.
export * from './workflow-run.task';
// EW-693 — long-running plugin execution (Phase 7 / T27).
export * from './run-plugin-operation.task';
// Pricing Wave 9 M1 — daily free-credit grant (idempotent per user/day).
export * from './credits-daily-grant.task';
export * from './credits-meter-flush.task';
// Memory upgrades M9 — scheduled consolidation pass (opt-in per org,
// dry-run by default, never auto-applied).
export * from './memory-consolidation-tick.task';
// AW-07 - embed one memory fact, and the nightly sweep that purges expired
// forgotten facts and backfills / re-embeds their vectors.
export * from './memory-fact-embed.task';
export * from './memory-fact-gc.task';
// Model accounts (AW-16) — six-hourly credential health check per account.
export * from './model-account-health.task';
// Skills shelf — hourly readiness sweep.
export * from './skill-readiness-sweep.task';
// AW-22 Workspace backup — build one complete archive of one workspace,
// and the hourly sweep that expires artefacts, fails stalls and prunes
// records so the history list stays honest.
export * from './workspace-backup.task';
export * from './workspace-backup-sweeper.task';
// APW-07 T17 — provision / refresh / release one App dependency of one App
// Work, on APW-06's isolated `app-cluster-io` queue. It refuses to run in
// production unless the operator attested the worker's isolation
// (`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`).
export * from './app-dependency-provision.task';
// APW-03 T13 — one App spec evaluation of one App Work. Delegates to the
// runtime-neutral handler in `@ever-works/agent/tasks` and resolves
// `AppSpecService` through the internal RPC channel, because FR-90 puts the
// evaluation, its writes and its `app.spec.applied` event in the API process.
export * from './app-spec-evaluate.task';
// APW-06 T32 — the four App cluster tasks, all on APW-06's isolated
// `app-cluster-io` queue (plan §6.2:942, §9.2:1245-1251). Every one of them
// boots `TriggerAppRuntimeModule` (T71), which is what arms T20's
// worker-context flag — the only thing that lets an App cluster call happen
// anywhere. `app-deploy` runs a Deployment through T25's orchestrator;
// `app-smoke` and `app-cluster-op` delegate to T70's service and router (both
// still owed) and refuse by name meanwhile; `app-health-poll` is the
// every-minute tick, guarded by `DistributedTaskLockService` and owed T27's
// health service.
export * from './app-deploy.task';
export * from './app-smoke.task';
export * from './app-cluster-op.task';
export * from './app-health-poll.task';
// APW-06 T32 — the `app-runtime:local-worker` entry point (plan §9.2:1267-1270).
// NOT a Trigger task: it is a plain node process the dev machine and the e2e lane
// start, and it drains the same exported run functions above from a local queue.
export * from './app-runtime-local-worker';
// APW-05 T19 — one prepare of one App Work (plan §7.2). The job that turns a
// build REQUEST into a build PREPARATION: the workflow file and the branch
// protection through the plugin, the build values as repository secrets, the
// §3.1b preparation row, and the requested Builds blocked or dispatched. The
// runner itself is API-side (it writes rows and publishes events), so the task
// resolves it over the internal RPC channel — see the file's header for the two
// registrations that live outside this package.
export * from './app-build-prepare.task';
// APW-05 T20 — one OBSERVATION of one Build (plan §7.3). It claims §7.3's
// two-minute `watchLeaseUntil`, reads the run through the build plugin, re-stamps
// the preparation values the run actually read (`APW05-G03`), finalises the
// terminal transition through §7.8's one writer, removes a verification Build's
// per-run prompted-value secret (§4.10) and releases the lease. The runner is
// API-side, so the task resolves it over the internal RPC channel — see the
// file's header for the two registrations that live outside this package.
export * from './app-build-watch.task';
// APW-05 T21 (first slice) — the Builds sweep, every two minutes (plan §7.4). It
// re-drives a requested Build nothing dispatched (§9.2) and fails a never-adopted
// Build as `lost`; every pass is `AppBuildSweepService.runSweep`, API-side under
// its own `app-builds:sweep` lock, reached over the internal RPC channel. When
// Trigger.dev is not the runtime the API's `AppBuildSweepCronService` runs it.
export * from './app-build-sweep.task';
// C10 — one readiness run of one App Work (APW-02 plan §6.2). The job that turns
// a fork REQUEST into a READY repository: the private-copy push, FR-18's poll
// schedule, Actions hygiene and the setup hand-off. It resolves
// `AppForkReadinessRunner` over the internal RPC channel because the run writes
// the state row and a Trigger worker owns no `DataSource`; the dispatcher that
// queues it (`APP_FORK_READINESS_DISPATCHER`) is bound in the agent-side
// `AppWorksModule` — see the file's header for both registrations.
export * from './app-fork-readiness.task';
