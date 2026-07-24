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
import { WorkKnowledgeChunk } from '../entities/work-knowledge-chunk.entity';
import { WorkKnowledgeChunkCoordinate } from '../entities/work-knowledge-chunk-coordinate.entity';
import { Mission } from '../entities/mission.entity';
import { Goal } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Tenant } from '../entities/tenant.entity';
import { Organization } from '../entities/organization.entity';
import { Agent } from '../entities/agent.entity';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { Task } from '../entities/task.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { TaskAttachment } from '../entities/task-attachment.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { TaskKbMention } from '../entities/task-kb-mention.entity';
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
import { ComposioTriggerSubscription } from '../entities/composio-trigger-subscription.entity';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';
import { TenantJobRuntimeAudit } from '../entities/tenant-job-runtime-audit.entity';
import { TenantRuntimeProviderAllowlist } from '../entities/tenant-runtime-provider-allowlist.entity';
import { TenantCredentialSnapshot } from '../entities/tenant-credential-snapshot.entity';
import { InboundTrigger } from '../entities/inbound-trigger.entity';
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
    AgentBudget,
    AgentMembership,
    AgentAttachment,
    // Teams & Prebuilt Companies (teams-and-companies spec §2)
    Team,
    TeamMember,
    // Team ↔ resource association (Works/Agents/Missions/Ideas/Tasks belong to Teams)
    TeamResource,
    Skill,
    SkillBinding,
    // Phase 11 — Tasks family
    Task,
    TaskAssignee,
    TaskReviewer,
    TaskApprover,
    TaskBlock,
    TaskRelation,
    TaskChatMessage,
    TaskAttachment,
    TaskWatcher,
    TaskKbMention,
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
];
