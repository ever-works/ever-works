import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CacheEntry } from '../entities/cache.entity';
import {
    ApiKey,
    RefreshToken,
    User,
    Work,
    WorkAdvancedPrompts,
    WorkCustomDomain,
    WorkDeployment,
    WorkMember,
    WorkInvitation,
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
    WorkAgentGoal,
    WorkAgentRun,
    WorkAgentRunLog,
    WorkKnowledgeDocument,
    WorkKnowledgeUpload,
    WorkKnowledgeTag,
    WorkKnowledgeCitation,
    WorkKnowledgeChunk,
    Mission,
    // Agents/Skills/Tasks (PR #1017 specs)
    Agent,
    AgentRun,
    AgentRunLog,
    AgentBudget,
    AgentMembership,
} from '../entities';
import { PluginEntity, UserPluginEntity, WorkPluginEntity } from '../plugins/entities';
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
    WorkAgentGoal,
    WorkAgentRun,
    WorkAgentRunLog,
    // Missions / Ideas / Works (spec 2026-05-24, Phase 0 PR 0.2)
    Mission,
    // Agents / Skills / Tasks (PR #1017 specs, Phase 1)
    Agent,
    AgentRun,
    AgentRunLog,
    AgentBudget,
    AgentMembership,
    // Knowledge Base entities (EW-639 / EW-640)
    WorkKnowledgeDocument,
    WorkKnowledgeUpload,
    WorkKnowledgeTag,
    WorkKnowledgeCitation,
    WorkKnowledgeChunk,
    // Plugin entities
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    // Account transfer entities
    UserSyncConfig,
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
            database = config.database.getPath();
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

        return {
            ...baseConfig,
            type: dbType,
            url: config.database.getUrl(),
            database: parsedUrl?.database,
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
