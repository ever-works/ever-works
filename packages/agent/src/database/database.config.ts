import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CacheEntry } from '../entities/cache.entity';
import {
    RefreshToken,
    OAuthToken,
    ChatHistory,
    ChatMessage,
    User,
    Directory,
    DirectoryAdvancedPrompts,
    DirectoryMember,
    DirectoryGenerationHistory,
    SubscriptionPlan,
    UserSubscription,
    DirectorySchedule,
    UsageLedgerEntry,
    Notification,
} from '../entities';
import { PluginEntity, UserPluginEntity, DirectoryPluginEntity } from '../plugins/entities';
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
    Directory,
    DirectoryAdvancedPrompts,
    DirectoryMember,
    User,
    RefreshToken,
    OAuthToken,
    ChatHistory,
    ChatMessage,
    CacheEntry,
    DirectoryGenerationHistory,
    SubscriptionPlan,
    UserSubscription,
    DirectorySchedule,
    UsageLedgerEntry,
    Notification,
    // Plugin entities
    PluginEntity,
    UserPluginEntity,
    DirectoryPluginEntity,
];

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
    const environment = config.getEnvironment() || 'development';
    const appType = config.getAppType() || 'api';
    let dbType = config.database.getType();

    const baseConfig: any = {
        entities: ENTITIES,
        synchronize: config.database.autoMigrate(),
        logging: config.database.loggingEnabled(),
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

        // Ensure directory exists for file-based SQLite databases (SQLite-specific logic)
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
