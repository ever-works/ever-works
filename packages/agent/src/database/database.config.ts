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
    WorkProposal,
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
    WorkProposal,
    // Plugin entities
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    // Account transfer entities
    UserSyncConfig,
];

/**
 * Resolve TypeORM migration globs that work in both dev (TS source) and
 * Docker / k8s (compiled JS). TypeORM accepts an array of globs and
 * silently ignores any that don't match files, so listing all known
 * layouts is safe and idempotent.
 *
 * Paths are absolute and use forward slashes (TypeORM's glob loader is
 * cross-platform but a few internals trip on backslashes on Windows).
 *
 *   - Docker / prod:        `/app/dist/migrations/*.js` (cwd = /app)
 *   - Local API workspace:  `apps/api/dist/migrations/*.js` (from repo root)
 *   - Local API workspace:  `apps/api/src/migrations/*.ts` (ts-node / SWC)
 *   - From apps/api cwd:    `src/migrations/*.ts` and `dist/migrations/*.js`
 *
 * Windows note: `process.cwd()` returns `C:\…` on Windows; the `.replace`
 * below normalises to forward slashes. TypeORM's underlying glob engine
 * (`globby` / `fast-glob`) treats forward-slash absolute paths on Windows
 * correctly, so `C:/Users/…/migrations/*.ts` resolves. If a Windows dev
 * ever sees zero migrations loaded despite running `pnpm dev:api`, check
 * `databaseConfig().migrations` and confirm the cwd path.
 */
function resolveMigrationGlobs(): string[] {
    const cwd = process.cwd().replace(/\\/g, '/');
    return [
        `${cwd}/dist/migrations/*.js`,
        `${cwd}/src/migrations/*.ts`,
        `${cwd}/apps/api/dist/migrations/*.js`,
        `${cwd}/apps/api/src/migrations/*.ts`,
    ];
}

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
    const environment = config.getEnvironment() || 'development';
    const appType = config.getAppType() || 'api';
    let dbType = config.database.getType();

    // `migrationsRun` is gated on the API app type — CLI uses synchronize
    // for its local SQLite (`DatabaseInitService` does that), so it has no
    // use for the migrations table.
    const migrationsRun = appType === 'api' && config.database.runMigrations();

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
