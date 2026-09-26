export * from './database-config.factory';
export * from './database.config';
export * from './database.module';
export * from './ownership-scope';
// Pricing Wave 9 M2 — run-cost settlement seam (token + contract).
export * from './run-cost-settler';
export * from './repositories/api-key.repository';
export * from './repositories/work.repository';
export * from './repositories/work-deployment.repository';
export * from './repositories/work-custom-domain.repository';
export * from './repositories/work-member.repository';
export * from './repositories/user.repository';
export * from './repositories/user-upload.repository';
export * from './repositories/refresh-token.repository';
export * from './repositories/auth-account.repository';
export * from './repositories/work-generation-history.repository';
export * from './repositories/subscription-plan.repository';
export * from './repositories/user-subscription.repository';
export * from './repositories/work-schedule.repository';
export * from './repositories/usage-ledger.repository';
export * from './repositories/plugin-usage.repository';
// Credits ledger + plan entitlements (pricing Wave 9 M1)
export * from './repositories/credit-ledger.repository';
export * from './repositories/plan-entitlement.repository';
// Payment provider bridge (billing PRD §5.3(3)/(4)) — billing profiles
// (customer + payment-method summary + auto-recharge) and the invoice mirror
export * from './repositories/billing-profile.repository';
export * from './repositories/invoice.repository';
export * from './repositories/licence-purchase.repository';
// Streaming-terminal M9 / D1 — append-only terminal transcript chunks.
export * from './repositories/terminal-transcript-chunk.repository';
export * from './repositories/work-budget.repository';
export * from './repositories/work-budget-alert-state.repository';
export * from './repositories/notification.repository';
export * from './repositories/conversation.repository';
export * from './repositories/conversation-participant.repository';
export * from './repositories/github-app-installation.repository';
export * from './repositories/github-app-installation-repository.repository';
export * from './repositories/github-app-user-link.repository';
export * from './repositories/onboarding-checklist.repository';
export * from './repositories/onboarding-request.repository';
export * from './repositories/template.repository';
export * from './repositories/template-customization.repository';
export * from './repositories/user-template-preference.repository';
export * from './repositories/webhook-subscription.repository';
export * from './repositories/webhook-delivery.repository';
export * from './repositories/work-knowledge-document.repository';
export * from './repositories/work-knowledge-upload.repository';
export * from './repositories/work-knowledge-tag.repository';
export * from './repositories/work-knowledge-citation.repository';
export * from './repositories/kb-retrieval-log.repository';
export * from './repositories/work-knowledge-chunk.repository';
export * from './repositories/work-knowledge-chunk-coordinate.repository';
// AW-07 — pgvector chunks for vector namespaces that are not a Work.
export * from './repositories/vector-namespace-chunk.repository';
// Agents/Skills/Tasks PR #1017 — Phase 6. Export Agent repositories
// so the heartbeat worker can resolve remote-proxy versions through
// `TriggerInternalModule`.
export * from './repositories/agent.repository';
export * from './repositories/agent-run.repository';
export * from './repositories/agent-run-log.repository';
export * from './repositories/agent-budget.repository';
export * from './repositories/agent-membership.repository';
export * from './repositories/agent-collaborator.repository';
// Agents/Skills/Tasks PR #1017 — Phase 8. Skill catalog repositories.
export * from './repositories/skill.repository';
export * from './repositories/skill-binding.repository';
// Skill companion files (#2080) — per-skill uploaded file records.
export * from './repositories/skill-file.repository';
// Skills shelf — the queryable copy of each Skill's frontmatter tags.
export * from './repositories/skill-tag.repository';
// Agent Plugins MCP slice — feature-owned repositories, wired by McpModule.
export * from './repositories/mcp-server-connection.repository';
export * from './repositories/agent-mcp-server-binding.repository';
// Tenants & Organizations (EW-651 epic) — Phase 1 / EW-653.
export * from './repositories/tenant.repository';
export * from './repositories/organization.repository';
export * from './repositories/organization-invitation.repository';
export * from './repositories/organization-member.repository';
// Notifications v2 (EW-650 / EW-663 / EW-664) — email + multi-channel
// + per-user preference repositories.
export * from './repositories/tenant-email-address.repository';
export * from './repositories/agent-email-assignment.repository';
export * from './repositories/email-conversation.repository';
export * from './repositories/email-message.repository';
// Agent email (AW-05) — per-Agent approval mode + send ceilings
export * from './repositories/agent-inbox.repository';
// Model accounts (AW-16) — provider accounts + the model ladder
export * from './repositories/model-account.repository';
export * from './repositories/model-policy.repository';
export * from './repositories/notification-channel.repository';
export * from './repositories/notification-channel-delivery-log.repository';
export * from './repositories/notification-event-type.repository';
export * from './repositories/user-notification-subscription.repository';
export * from './repositories/user-notification-preference.repository';
export * from './repositories/user-notification-category-mute.repository';
export * from './repositories/organization-notification-default.repository';
export * from './repositories/organization-onboarding-profile.repository';
export * from './database-init.service';
export * from './repositories/workflow.repository';
export * from './repositories/workflow-run.repository';
// Repository registry (Feature G) — repo connections + agent grants.
export * from './repositories/repo-connection.repository';
export * from './repositories/agent-repo-attachment.repository';
// Memory Files — user-defined folders organizing uploads on /memory.
export * from './repositories/memory-folder.repository';
export * from './repositories/memory-fact.repository';
export * from './repositories/knowledge-document-reader-state.repository';
// AW-14 What's new — per-person product changelog read state.
export * from './repositories/product-changelog-read.repository';
// Repository registry (Feature G) — repo connections + agent grants.
export * from './repositories/repo-connection.repository';
export * from './repositories/agent-repo-attachment.repository';
// AW-22 Workspace backup — the record of one archive attempt, and the
// compare-and-set transitions the runner, the sweeper and the owner race on.
export * from './repositories/workspace-backup.repository';
// APW-11 App Launcher — the personal arrangement (visible / pinned / order)
// behind `GET /api/me/apps` and `PUT /api/me/apps/preferences`. Provided by the
// feature's own `app-launcher.module.ts`, so it is exported here rather than
// listed in `_repository-inventory.ts` — that file is only for the repositories
// `DatabaseModule` itself wires, and its drift check fails on an entry that is
// not a provider there.
export * from './repositories/app-launcher-preference.repository';
// APW-02 Fork lifecycle — the Upstream state of one App Work (readiness,
// Actions hygiene, schedule, divergence, manual-sync allowance). Also
// feature-owned and wired by the App Works module (T15), for the same reason.
export * from './repositories/work-upstream-state.repository';
// APW-06 T17 — the per-App-Work runtime state store behind WORK_APP_RUNTIME_STATES.
export * from './repositories/work-app-runtime-state.repository';
// APW-07 App env & dependencies — the stored Environment values of one App Work
// (T8), and the dependency rows a provider provisions, releases and reports on.
// Both are feature-owned and wired by their own modules (T13 / T16), so neither
// is listed in `_repository-inventory.ts` — that file is only for the
// repositories `DatabaseModule` itself wires, and its drift check fails on an
// entry that is not a provider there.
export * from './repositories/work-app-env-value.repository';
export * from './repositories/work-app-dependency.repository';
// APW-03 App spec & catalog — the App spec state of one App Work, and the
// coalescing arithmetic (`requestedSeq` / `startedSeq` / `evaluatedSeq` and the
// licence pair) that only this repository may touch. Feature-owned and wired by
// the App spec module, so it is exported here rather than listed in
// `_repository-inventory.ts` — that file is only for the repositories
// `DatabaseModule` itself wires, and its drift check fails on an entry that is
// not a provider there.
export * from './repositories/work-app-spec-state.repository';
// APW-05 Builds — the Builds of one App Work (the per-Work number sequence, the
// run-identity upsert, the sweep's silent and orphaned-secret scans) and the
// per-App-Work preparation row the consumer stamps a Build from. Both are
// feature-owned and wired by the App Works module, so they are exported here
// rather than listed in `_repository-inventory.ts` — that file is only for the
// repositories `DatabaseModule` itself wires, and its drift check fails on an
// entry that is not a provider there.
export * from './repositories/app-build.repository';
export * from './repositories/app-build-preparation.repository';
// APW-04 App Provisioner — the provisioning rows of one App Work (the active
// lookup the start path dedupes on, the four lease/attempt compare-and-sets and
// the four sweep scans). Feature-owned and wired by the provisioning module, so
// it is exported here rather than listed in `_repository-inventory.ts` — that
// file is only for the repositories `DatabaseModule` itself wires, and its drift
// check fails on an entry that is not a provider there.
export * from './repositories/work-app-provisioning.repository';
