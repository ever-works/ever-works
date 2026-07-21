import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
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
// Goals & Metrics (PR-8)
import { Goal } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
// Tenants & Organizations (EW-651 epic) — Phase 1 / EW-653
import { Tenant } from '../entities/tenant.entity';
import { Organization } from '../entities/organization.entity';
// Agents/Skills/Tasks (PR #1017 specs)
import { Agent } from '../entities/agent.entity';
// Agent Action Approval Queue — human-in-the-loop gate.
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
// Notifications v2 (EW-650 + siblings)
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
// Tenant-scoped job-runtime overlay (EW-742 P1)
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';
import { TenantJobRuntimeAudit } from '../entities/tenant-job-runtime-audit.entity';
// Per-tenant runtime provider allow-list overlay (EW-752 P5.1)
import { TenantRuntimeProviderAllowlist } from '../entities/tenant-runtime-provider-allowlist.entity';
// Per-version credential snapshot history (EW-742 P1 T11 follow-up)
import { TenantCredentialSnapshot } from '../entities/tenant-credential-snapshot.entity';
// Inbound Triggers (Trigger Schedules) — signed webhook/API triggers
import { InboundTrigger } from '../entities/inbound-trigger.entity';
import {
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    PluginAllowlistEntity,
} from '../plugins/entities';
import { UserSyncConfig } from '../account-transfer/entities/user-sync-config.entity';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { config } from '@src/config';
import { getTlsOptions, parseDatabaseUrl } from './utils';

export type DatabaseType =
    | 'better-sqlite3'
    | 'sqlite'
    | 'sqlite3'
    | 'postgres'
    | 'mysql'
    | 'mariadb';

export interface DatabaseConfig extends Omit<TypeOrmModuleOptions, 'type'> {
    type: DatabaseType;
    // SQLite specific
    database?: string;
    // PostgreSQL/MySQL|MariaDB specific
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    // Common properties
    entities: any[];
    synchronize: boolean;
    logging: boolean;
    ssl?: any;
}

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

/**
 * Resolve TypeORM migration globs for the runtime path. TypeORM accepts
 * an array of globs and silently ignores any that don't match files, so
 * listing the candidate layouts is safe and idempotent.
 *
 * **Only `.js` patterns**, intentionally. TypeORM 0.3.x's
 * `DirectoryExportedClassesLoader` loads matched files via
 * `Promise.all(import(file))`. On Node ≥ 22, requiring `.ts` files (even
 * after Nest+SWC transpilation) goes through the ESM loader and
 * `Promise.all`-importing several at once trips Node's internal
 * "Unexpected module status 0" assertion (a known race between
 * `require()` and dynamic `import()` on the same module). Compiled JS
 * doesn't hit this path. The manual `pnpm typeorm migration:generate /
 * migration:run` commands keep their own `'.ts'` glob in
 * `apps/api/typeorm.config.ts` and run under `ts-node`, which loads
 * synchronously and is unaffected.
 *
 * Paths are absolute and use forward slashes (TypeORM's underlying glob
 * engine — `globby` / `fast-glob` — handles forward-slash absolute paths
 * correctly on Windows too).
 *
 *   - Docker / prod:        `/app/dist/migrations/*.js` (cwd = /app)
 *   - Local API workspace:  `apps/api/dist/migrations/*.js` (from repo root)
 *   - From apps/api cwd:    `dist/migrations/*.js`
 *
 * For local dev: run `pnpm build --filter ever-works-api` (or `pnpm dev`
 * which builds before watching) to populate `apps/api/dist/migrations/`,
 * then the API will pick up pending migrations on next boot. Authoring
 * a new migration still goes through `pnpm typeorm migration:generate`
 * (which produces `.ts` next to the existing ones) — the build step
 * compiles it to `.js` automatically.
 */
function resolveMigrationGlobs(): string[] {
    const cwd = process.cwd().replace(/\\/g, '/');
    return [`${cwd}/dist/migrations/*.js`, `${cwd}/apps/api/dist/migrations/*.js`];
}

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
    const environment = config.getEnvironment() || 'development';
    const appType = config.getAppType() || 'api';
    let dbType = config.database.getType();

    // `migrationsRun` is gated on:
    //   - API app type only — CLI uses synchronize for its local SQLite
    //     (`DatabaseInitService` does that), so it has no use for the
    //     migrations table.
    //   - `!autoMigrate()` — when synchronize is ON (test / E2E), TypeORM's
    //     `DataSource.initialize()` runs `migrationsRun` BEFORE
    //     `synchronize`, so any ALTER-style migration would fail against
    //     the still-empty schema. Synchronize bootstraps the full schema
    //     from entities and the migrations table catches up implicitly;
    //     migrations are only needed in environments with real persisted
    //     data (prod/stage).
    const migrationsRun =
        appType === 'api' && config.database.runMigrations() && !config.database.autoMigrate();

    const baseConfig: any = {
        entities: ENTITIES,
        synchronize: config.database.autoMigrate(),
        logging: config.database.loggingEnabled(),
        migrations: resolveMigrationGlobs(),
        migrationsRun,
        migrationsTableName: 'migrations',
        // `'all'` = all pending migrations in ONE shared transaction. If
        // migration N fails, migrations 1..N-1 are rolled back too and the
        // whole batch is retried on the next boot. Use `'each'` if you ever
        // need partial-progress semantics; we want atomic-batch behaviour so
        // a half-applied schema can't escape between pod restarts.
        migrationsTransactionMode: 'all' as const,
    };

    if (config.database.sslMode()) {
        baseConfig.ssl = getTlsOptions(true, config.database.databaseCaCert());
    }

    if (dbType === 'sqlite' || dbType === 'sqlite3') {
        dbType = 'better-sqlite3';
    }

    // SQLite configuration
    if (dbType === 'better-sqlite3') {
        let database: string;

        if (config.database.getPath()) {
            const rawPath = config.database.getPath();
            // Defensive normalization: collapse any relative traversal
            // (e.g. `../../etc/...`) in DATABASE_PATH down to an absolute
            // path. SQLite's special pseudo-paths (`:memory:`,
            // `:custom-shared`, …) are NOT filesystem paths, so they are
            // passed through untouched. Absolute file paths are unaffected
            // (path.resolve is an identity op for already-absolute inputs).
            database = rawPath.startsWith(':') ? rawPath : path.resolve(rawPath);
        } else if (appType === 'cli') {
            const dbDir = path.join(os.homedir(), '.ever-works');
            database = path.join(dbDir, 'ever-works.db');
        } else if (environment === 'test') {
            database = ':memory:';
        } else {
            // API apps default to in-memory for development, can be overridden
            database = !config.database.getInMemory()
                ? path.join(os.tmpdir(), 'ever-works-api.db')
                : ':memory:';
        }

        // Ensure work exists for file-based SQLite databases (SQLite-specific logic)
        if (database !== ':memory:' && !database.startsWith(':')) {
            const dbDir = path.dirname(database);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }
        }

        return {
            ...baseConfig,
            type: 'better-sqlite3',
            database,
        };
    }

    // Handle Database URL if provided
    if (config.database.getUrl()) {
        const parsedUrl = parseDatabaseUrl(config.database.getUrl());
        // Security/misconfig guard (EW-721): fail fast instead of silently
        // starting a DataSource with an undefined database name.
        if (parsedUrl === null) {
            throw new Error(
                'DATABASE_URL could not be parsed; refusing to start with undefined database name.',
            );
        }

        return {
            ...baseConfig,
            type: dbType,
            url: config.database.getUrl(),
            database: parsedUrl.database,
        };
    }

    // PostgreSQL configuration
    if (dbType === 'postgres') {
        return {
            ...baseConfig,
            type: 'postgres',
            host: config.database.getHost() || 'localhost',
            port: parseInt(config.database.getPort() || '5432'),
            username: config.database.getUsername() || 'postgres',
            password: config.database.getPassword() || '',
            database: config.database.getDatabaseName() || 'ever_works',
        };
    }

    // MySQL configuration
    if (['mysql', 'mariadb'].includes(dbType)) {
        return {
            ...baseConfig,
            type: 'mysql',
            host: config.database.getHost() || 'localhost',
            port: parseInt(config.database.getPort() || '3306'),
            username: config.database.getUsername() || 'root',
            password: config.database.getPassword() || '',
            database: config.database.getDatabaseName() || 'ever_works',
        };
    }

    // Default to SQLite if unknown type
    return {
        ...baseConfig,
        type: 'better-sqlite3',
        database: ':memory:',
    };
});

export const getDatabaseConfig = (): TypeOrmModuleOptions => {
    const config = databaseConfig();
    return config as TypeOrmModuleOptions;
};
