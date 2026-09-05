/**
 * Concrete entity inventory for the TypeORM DataSource.
 *
 * Split out of `database.config.ts` for two reasons:
 *
 *  1. These imports MUST be concrete per-file paths, never the `../entities`
 *     barrel. Importing the barrel here forces the whole entity graph to
 *     evaluate while the module is still initialising, so `ENTITIES` ends up
 *     holding an `undefined` and `TypeOrmModule.forFeature(ENTITIES)` dies with
 *     "A circular dependency has been detected inside @InjectRepository()".
 *  2. Keeping them in ONE module gives `database.config.spec.ts` a single mock
 *     point. That spec must not load TypeORM at all (TypeORM's CJS init hits a
 *     known `path-scurry` bug under Jest), and it previously achieved that by
 *     mocking the `../entities` barrel - which concrete imports would bypass.
 *     It now mocks this module instead, exactly one entry, in the same spirit
 *     as `_entity-names.ts` (EW-638: one place to edit when adding an entity).
 *
 * Adding an entity = add the concrete import here and list it in ENTITIES.
 */
import { CacheEntry } from '../entities/cache.entity';
import { ApiKey } from '../entities/api-key.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { Work } from '../entities/work.entity';
import { WorkAdvancedPrompts } from '../entities/work-advanced-prompts.entity';
import { WorkCustomDomain } from '../entities/work-custom-domain.entity';
import { WorkDeployment } from '../entities/work-deployment.entity';
import { WorkMember } from '../entities/work-member.entity';
import { WorkInvitation } from '../entities/work-invitation.entity';
import { OrganizationInvitation } from '../entities/organization-invitation.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { WorkGenerationHistory } from '../entities/work-generation-history.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { UserSubscription } from '../entities/user-subscription.entity';
import { WorkSchedule } from '../entities/work-schedule.entity';
import { UsageLedgerEntry } from '../entities/usage-ledger-entry.entity';
import { PluginUsageEvent } from '../entities/plugin-usage-event.entity';
import { WorkBudget } from '../entities/work-budget.entity';
import { WorkBudgetAlertState } from '../entities/work-budget-alert-state.entity';
import { Notification } from '../entities/notification.entity';
import { ActivityLog } from '../entities/activity-log.entity';
import { Conversation } from '../entities/conversation.entity';
import { ConversationMessage } from '../entities/conversation-message.entity';
import { AuthAccount } from '../entities/auth-account.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthVerification } from '../entities/auth-verification.entity';
import { TermsAcceptance } from '../entities/terms-acceptance.entity';
import { GitHubAppInstallation } from '../entities/github-app-installation.entity';
import { GitHubAppInstallationRepository } from '../entities/github-app-installation-repository.entity';
import { GitHubAppUserLink } from '../entities/github-app-user-link.entity';
import { OnboardingRequest } from '../entities/onboarding-request.entity';
import { Template } from '../entities/template.entity';
import { TemplateCustomization } from '../entities/template-customization.entity';
import { UserTemplatePreference } from '../entities/user-template-preference.entity';
import { WebhookSubscription } from '../entities/webhook-subscription.entity';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { WorkAgentPreference } from '../entities/work-agent-preference.entity';
import { WorkBuildRequest } from '../entities/work-build-request.entity';
import { WorkAgentRun } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog } from '../entities/work-agent-run-log.entity';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { WorkKnowledgeTag } from '../entities/work-knowledge-tag.entity';
import { WorkKnowledgeCitation } from '../entities/work-knowledge-citation.entity';
import { KbRetrievalLog } from '../entities/kb-retrieval-log.entity';
import { WorkKnowledgeChunk } from '../entities/work-knowledge-chunk.entity';
import { WorkKnowledgeChunkCoordinate } from '../entities/work-knowledge-chunk-coordinate.entity';
import { Mission } from '../entities/mission.entity';
import { Goal } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { GoalEvent } from '../entities/goal-event.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Tenant } from '../entities/tenant.entity';
import { Organization } from '../entities/organization.entity';
import { Agent } from '../entities/agent.entity';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentEscalation } from '../entities/agent-escalation.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { AgentCollaborator } from '../entities/agent-collaborator.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { SkillFile } from '../entities/skill-file.entity';
import { Task } from '../entities/task.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskReviewRejection } from '../entities/task-review-rejection.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { TaskAttachment } from '../entities/task-attachment.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { TaskKbMention } from '../entities/task-kb-mention.entity';
import { TaskTemplate } from '../entities/task-template.entity';
import { TaskTemplateStep } from '../entities/task-template-step.entity';
import { UserTaskCounter } from '../entities/user-task-counter.entity';
import { MissionAttachment } from '../entities/mission-attachment.entity';
import { MissionWork } from '../entities/mission-work.entity';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { IdeaWork } from '../entities/idea-work.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { TenantEmailAddress } from '../entities/tenant-email-address.entity';
import { AgentEmailAssignment } from '../entities/agent-email-assignment.entity';
import { EmailConversation } from '../entities/email-conversation.entity';
import { EmailMessage } from '../entities/email-message.entity';
import { NotificationChannel } from '../entities/notification-channel.entity';
import { NotificationChannelDeliveryLog } from '../entities/notification-channel-delivery-log.entity';
import { NotificationEventType } from '../entities/notification-event-type.entity';
import { UserNotificationSubscription } from '../entities/user-notification-subscription.entity';
import { UserNotificationPreference } from '../entities/user-notification-preference.entity';
import { UserNotificationCategoryMute } from '../entities/user-notification-category-mute.entity';
import { OrganizationNotificationDefault } from '../entities/organization-notification-default.entity';
import { OrganizationOnboardingProfile } from '../entities/organization-onboarding-profile.entity';
import { ComposioTriggerSubscription } from '../entities/composio-trigger-subscription.entity';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';
import { TenantJobRuntimeAudit } from '../entities/tenant-job-runtime-audit.entity';
import { TenantRuntimeProviderAllowlist } from '../entities/tenant-runtime-provider-allowlist.entity';
import { TenantCredentialSnapshot } from '../entities/tenant-credential-snapshot.entity';
import { InboundTrigger } from '../entities/inbound-trigger.entity';
import { InboundTriggerFire } from '../entities/inbound-trigger-fire.entity';
import { IngestedEvent } from '../entities/ingested-event.entity';
import { IngestCursor } from '../entities/ingest-cursor.entity';
import { IngestInstallBinding } from '../entities/ingest-install-binding.entity';
import { InboxItem } from '../entities/inbox-item.entity';
import { ExternalIssueLink } from '../entities/external-issue-link.entity';
import { Meeting } from '../entities/meeting.entity';
import { CreditLedgerEntry } from '../entities/credit-ledger-entry.entity';
import { PlanEntitlement } from '../entities/plan-entitlement.entity';
import { BillingProfile } from '../entities/billing-profile.entity';
import { Invoice } from '../entities/invoice.entity';
import { LicencePurchase } from '../entities/licence-purchase.entity';
import { CreditMeterEvent } from '../entities/credit-meter-event.entity';
import { FleetNode } from '../entities/fleet-node.entity';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import { TerminalTranscriptChunk } from '../entities/terminal-transcript-chunk.entity';

import { FleetJob } from '../entities/fleet-job.entity';
import { FleetExecutionPreference } from '../entities/fleet-execution-preference.entity';
import { FleetCostPolicy } from '../entities/fleet-cost-policy.entity';
import { ToolGrant } from '../entities/tool-grant.entity';
import { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { AgentMcpServerBinding } from '../entities/agent-mcp-server-binding.entity';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowRun } from '../entities/workflow-run.entity';
import { Environment } from '../entities/environment.entity';
import { MemoryFolder } from '../entities/memory-folder.entity';
// Repository registry (Feature G)
import { AgentPluginPackage } from '../entities/agent-plugin-package.entity';
import { AgentPluginPackageAllowlist } from '../entities/agent-plugin-package-allowlist.entity';
import { RepoConnection } from '../entities/repo-connection.entity';
import { AgentRepoAttachment } from '../entities/agent-repo-attachment.entity';

import {
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    PluginAllowlistEntity,
} from '../plugins/entities';
import { UserSyncConfig } from '../account-transfer/entities/user-sync-config.entity';

export const ENTITIES = [
    ApiKey,
    UserUpload,
    Work,
    WorkAdvancedPrompts,
    WorkCustomDomain,
    WorkDeployment,
    WorkMember,
    WorkInvitation,
    OrganizationInvitation,
    OrganizationMember,
    User,
    RefreshToken,
    CacheEntry,
    WorkGenerationHistory,
    SubscriptionPlan,
    UserSubscription,
    WorkSchedule,
    UsageLedgerEntry,
    PluginUsageEvent,
    WorkBudget,
    WorkBudgetAlertState,
    Notification,
    ActivityLog,
    Conversation,
    ConversationMessage,
    AuthAccount,
    AuthSession,
    AuthVerification,
    TermsAcceptance,
    GitHubAppInstallation,
    GitHubAppInstallationRepository,
    GitHubAppUserLink,
    OnboardingRequest,
    Template,
    TemplateCustomization,
    UserTemplatePreference,
    WebhookSubscription,
    WebhookDelivery,
    WorkProposal,
    WorkAgentPreference,
    WorkBuildRequest,
    WorkAgentRun,
    WorkAgentRunLog,
    // Missions / Ideas / Works (spec 2026-05-24, Phase 0 PR 0.2)
    Mission,
    // Goals & Metrics (PR-8) — goals + append-only samples + Mission link.
    // Registered here AND in entities/index.ts (bug-class: a
    // forFeature'd-but-unregistered entity throws
    // EntityMetadataNotFoundError → unmapped 500 on every query).
    Goal,
    GoalMetricSample,
    // Autonomy layer — append-only orchestrator log.
    GoalEvent,
    MissionGoal,
    // Tenants & Organizations (EW-651 epic) — Phase 1 / EW-653
    Tenant,
    Organization,
    // Agents / Skills / Tasks (PR #1017 specs, Phase 1 + Phase 8)
    Agent,
    // Agent Action Approval Queue — human-in-the-loop gate for side-effectful actions.
    AgentActionProposal,
    AgentRun,
    AgentRunLog,
    // Judgment layer G3 - structured escalation records.
    AgentEscalation,
    AgentBudget,
    AgentMembership,
    // Agent Collaborators — per-agent sub-agent delegation allow-list.
    AgentCollaborator,
    AgentAttachment,
    // Teams & Prebuilt Companies (teams-and-companies spec §2)
    Team,
    TeamMember,
    // Team ↔ resource association (Works/Agents/Missions/Ideas/Tasks belong to Teams)
    TeamResource,
    Skill,
    SkillBinding,
    SkillFile,
    // Phase 11 — Tasks family
    Task,
    TaskAssignee,
    TaskReviewer,
    // Orchestration M9 - durable rejection feedback for resume.
    TaskReviewRejection,
    TaskApprover,
    TaskBlock,
    TaskRelation,
    TaskChatMessage,
    TaskAttachment,
    TaskWatcher,
    TaskKbMention,
    // Tasks upgrades — workflow templates (parent + steps).
    TaskTemplate,
    TaskTemplateStep,
    UserTaskCounter,
    // PR #1044 — Mission/Idea attachment edge tables
    MissionAttachment,
    MissionWork,
    WorkProposalAttachment,
    IdeaWork,
    // Knowledge Base entities (EW-639 / EW-640)
    WorkKnowledgeDocument,
    WorkKnowledgeUpload,
    WorkKnowledgeTag,
    WorkKnowledgeCitation,
    WorkKnowledgeChunk,
    WorkKnowledgeChunkCoordinate,
    // Memory eval loop (memory upgrades M10) — append-only retrieval log
    // joined against citation rows to compute the recall-hit rate and
    // the zero-result gap topics that feed consolidation synthesis.
    KbRetrievalLog,
    // Plugin entities
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    // EW-693 — dynamic plugin distribution allowlist (gates non-first-party installs)
    PluginAllowlistEntity,
    // Composio Triggers (EW-684 PR-D) — webhook trigger subscriptions
    ComposioTriggerSubscription,
    // Account transfer entities
    UserSyncConfig,
    // Notifications v2 (EW-650 + siblings)
    TenantEmailAddress,
    AgentEmailAssignment,
    EmailConversation,
    EmailMessage,
    NotificationChannel,
    NotificationChannelDeliveryLog,
    NotificationEventType,
    UserNotificationSubscription,
    UserNotificationPreference,
    UserNotificationCategoryMute,
    OrganizationNotificationDefault,
    // Onboarding "What do you do" answers, mirrored at org level (A53)
    OrganizationOnboardingProfile,
    // Tenant-scoped job-runtime overlay (EW-742 P1)
    TenantJobRuntimeConfig,
    TenantJobRuntimeAudit,
    // Per-tenant runtime provider allow-list overlay (EW-752 P5.1)
    TenantRuntimeProviderAllowlist,
    // Per-version credential snapshot history (EW-742 P1 T11 follow-up) —
    // backs CredentialVersionService.resolveSnapshot for v < current so
    // in-flight runs can bind to their captured credentials after a
    // rotation (ADR-017 §3 Q4).
    TenantCredentialSnapshot,
    // Inbound Triggers (Trigger Schedules) — signed webhook/API triggers
    // that spawn Tasks on verified HMAC deliveries.
    InboundTrigger,
    InboundTriggerFire,
    // Event-ingest spine (Wave 6) — normalized external events awaiting
    // Activity/Memory fan-out.
    IngestedEvent,
    // Event-ingest pull path (Wave 8) — per-(user, plugin) event-source
    // pull watermarks + continuation cursors.
    IngestCursor,
    // Inbound receivers — external workspace/installation → platform user
    // binding, so Slack/GitHub deliveries are attributed to the account
    // that actually owns the workspace instead of the oldest install.
    IngestInstallBinding,
    // Event-ingest spine — external tracker issue → platform Task
    // mapping, so an ingested Linear/Jira/GitHub issue can be bound to
    // the Task that mirrors it.
    ExternalIssueLink,
    // Meetings v1 (Wave 8, feature a) — captured meetings with
    // transcripts, summaries and provider dedupe.
    Meeting,
    // Credits ledger + plan entitlements (pricing Wave 9 M1) — credits
    // are the usage currency layered on the costCents metering.
    CreditLedgerEntry,
    PlanEntitlement,
    // Payment provider bridge (billing PRD §5.3(3)/(4)) — provider
    // customer mapping + default payment-method SUMMARY (brand/last4/exp
    // only, never a PAN) + auto-recharge state, and the invoice mirror
    // written exclusively by the signature-verified webhook.
    BillingProfile,
    Invoice,
    LicencePurchase,
    CreditMeterEvent,
    // Fleet (Wave 12, slice 1) — enrolled execution nodes (desktop /
    // headless) with hashed credentials + heartbeat status.
    FleetNode,
    // Organization-scoped Agent scheduling intent selecting one user-owned
    // Fleet node. Future jobs snapshot this row; existing jobs are unchanged.
    FleetAgentNodeAffinity,
    // Streaming-terminal M9 / founder decision D1 — append-only,
    // redacted, retention-capped terminal transcript chunks.
    TerminalTranscriptChunk,

    // Fleet job runtime (Desktop PRD M4) — the lease-able work queue
    // whose workers are the enrolled nodes above.
    FleetJob,
    // Inbox (operator message center) — messages addressed to the human:
    // blocking questions, approval requests, escalation mirrors, notices.
    InboxItem,
    // Fleet local-runner routing — per Work / Goal / account preference
    // for local-runner vs cloud execution.
    FleetExecutionPreference,
    // Fleet cost accounting (EW-777) — per-owner fleet-wide daily
    // model-spend ceiling + its one-notice trip marker.
    FleetCostPolicy,
    // Tool-grant matrix (audit item G4) — one row per (owner, scope)
    // carrying that scope's tool allow/deny contribution.
    ToolGrant,
    // Agent Plugins MCP slice — manual external MCP server registry +
    // per-agent/tenant bindings (plan §2.4/§2.5).
    McpServerConnection,
    AgentMcpServerBinding,
    // Workflows (judgment layer G5) — saved graphs. Until this row
    // existed a graph could be executed but never KEPT.
    Workflow,
    // One execution of a saved graph. The row is created `queued` by the
    // API and finished by the `workflow-run` Trigger.dev task.
    WorkflowRun,
    // Environments (Settings → Environments) — named, reusable runtime
    // recipes (packages + networking) assigned per-Agent.
    Environment,
    // Memory Files — user-defined folders organizing uploads on /memory.
    MemoryFolder,
    // Repository registry (Feature G) — account-level repo records plus
    // the Agent → repo grant edge rows.
    AgentPluginPackage,
    AgentPluginPackageAllowlist,
    RepoConnection,
    AgentRepoAttachment,
];
