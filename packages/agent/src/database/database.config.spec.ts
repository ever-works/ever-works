// `database.config.ts` imports the entity barrel (`'../entities'`) which
// transitively pulls in TypeORM. TypeORM's CJS init hits a known
// `path-scurry` initialization bug under Jest. Mock the entity barrels
// to empty class shells so the JIT never loads TypeORM at all.
jest.mock('../entities', () => ({
    ApiKey: class ApiKey {},
    RefreshToken: class RefreshToken {},
    User: class User {},
    Work: class Work {},
    WorkAdvancedPrompts: class WorkAdvancedPrompts {},
    WorkCustomDomain: class WorkCustomDomain {},
    WorkMember: class WorkMember {},
    WorkInvitation: class WorkInvitation {},
    WorkGenerationHistory: class WorkGenerationHistory {},
    SubscriptionPlan: class SubscriptionPlan {},
    UserSubscription: class UserSubscription {},
    WorkSchedule: class WorkSchedule {},
    UsageLedgerEntry: class UsageLedgerEntry {},
    Notification: class Notification {},
    ActivityLog: class ActivityLog {},
    Conversation: class Conversation {},
    ConversationMessage: class ConversationMessage {},
    AuthAccount: class AuthAccount {},
    AuthSession: class AuthSession {},
    AuthVerification: class AuthVerification {},
    GitHubAppInstallation: class GitHubAppInstallation {},
    GitHubAppInstallationRepository: class GitHubAppInstallationRepository {},
    GitHubAppUserLink: class GitHubAppUserLink {},
    OnboardingRequest: class OnboardingRequest {},
    Template: class Template {},
    UserTemplatePreference: class UserTemplatePreference {},
    WebhookSubscription: class WebhookSubscription {},
    WorkProposal: class WorkProposal {},
}));
jest.mock('../entities/cache.entity', () => ({
    CacheEntry: class CacheEntry {},
}));
jest.mock('../plugins/entities', () => ({
    PluginEntity: class PluginEntity {},
    UserPluginEntity: class UserPluginEntity {},
    WorkPluginEntity: class WorkPluginEntity {},
}));
jest.mock('../account-transfer/entities/user-sync-config.entity', () => ({
    UserSyncConfig: class UserSyncConfig {},
}));

// Mock the agent config module so each test can stub out the database
// getters without touching real env vars (jest's process.env mutation is
// global and would leak across the whole suite).
jest.mock('@src/config', () => {
    const databaseGetters = {
        getType: jest.fn(() => 'better-sqlite3' as string),
        isSqlite: jest.fn(() => true),
        getUrl: jest.fn(() => undefined as string | undefined),
        getHost: jest.fn(() => undefined as string | undefined),
        getPort: jest.fn(() => undefined as string | undefined),
        autoMigrate: jest.fn(() => true),
        loggingEnabled: jest.fn(() => false),
        sslMode: jest.fn(() => false),
        databaseCaCert: jest.fn(() => undefined as string | undefined),
        getPath: jest.fn(() => undefined as string | undefined),
        getInMemory: jest.fn(() => false),
        getUsername: jest.fn(() => undefined as string | undefined),
        getPassword: jest.fn(() => undefined as string | undefined),
        getDatabaseName: jest.fn(() => undefined as string | undefined),
    };
    return {
        config: {
            getEnvironment: jest.fn(() => 'development' as string | undefined),
            getAppType: jest.fn(() => 'api' as string | undefined),
            database: databaseGetters,
        },
    };
});

// Mock fs so the file-based-SQLite branch never touches the real disk.
jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
}));

// Mock the database utils so we don't need a real ssl/url parser.
jest.mock('./utils', () => ({
    getTlsOptions: jest.fn(() => ({ rejectUnauthorized: false, ca: undefined })),
    parseDatabaseUrl: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { databaseConfig, getDatabaseConfig, ENTITIES } from './database.config';
import { config } from '@src/config';
import { getTlsOptions, parseDatabaseUrl } from './utils';

const fsMock = fs as jest.Mocked<typeof fs>;
const cfgMock = config as unknown as {
    getEnvironment: jest.Mock;
    getAppType: jest.Mock;
    database: {
        getType: jest.Mock;
        isSqlite: jest.Mock;
        getUrl: jest.Mock;
        getHost: jest.Mock;
        getPort: jest.Mock;
        autoMigrate: jest.Mock;
        loggingEnabled: jest.Mock;
        sslMode: jest.Mock;
        databaseCaCert: jest.Mock;
        getPath: jest.Mock;
        getInMemory: jest.Mock;
        getUsername: jest.Mock;
        getPassword: jest.Mock;
        getDatabaseName: jest.Mock;
    };
};
const tlsMock = getTlsOptions as jest.MockedFunction<typeof getTlsOptions>;
const parseMock = parseDatabaseUrl as jest.MockedFunction<typeof parseDatabaseUrl>;

function resetMocks() {
    cfgMock.getEnvironment.mockReturnValue('development');
    cfgMock.getAppType.mockReturnValue('api');
    cfgMock.database.getType.mockReturnValue('better-sqlite3');
    cfgMock.database.isSqlite.mockReturnValue(true);
    cfgMock.database.getUrl.mockReturnValue(undefined);
    cfgMock.database.getHost.mockReturnValue(undefined);
    cfgMock.database.getPort.mockReturnValue(undefined);
    cfgMock.database.autoMigrate.mockReturnValue(true);
    cfgMock.database.loggingEnabled.mockReturnValue(false);
    cfgMock.database.sslMode.mockReturnValue(false);
    cfgMock.database.databaseCaCert.mockReturnValue(undefined);
    cfgMock.database.getPath.mockReturnValue(undefined);
    cfgMock.database.getInMemory.mockReturnValue(false);
    cfgMock.database.getUsername.mockReturnValue(undefined);
    cfgMock.database.getPassword.mockReturnValue(undefined);
    cfgMock.database.getDatabaseName.mockReturnValue(undefined);
    fsMock.existsSync.mockReturnValue(true);
    fsMock.mkdirSync.mockReset();
    tlsMock.mockReturnValue({ rejectUnauthorized: false, ca: undefined } as any);
    parseMock.mockReturnValue(undefined as any);
}

describe('database.config', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetMocks();
    });

    describe('ENTITIES list', () => {
        it('exposes a stable, non-empty list of entity classes', () => {
            // The exact identities are dependent on entity-class import resolution
            // and would drift; instead pin the list shape contracts:
            // - All entries are functions (entity classes).
            // - Every entry is unique (no accidental duplicate registration).
            expect(ENTITIES).toBeInstanceOf(Array);
            expect(ENTITIES.length).toBeGreaterThan(20);
            for (const e of ENTITIES) {
                expect(typeof e).toBe('function');
            }
            const unique = new Set(ENTITIES);
            expect(unique.size).toBe(ENTITIES.length);
        });
    });

    describe('SQLite branch (default)', () => {
        it('returns better-sqlite3 with :memory: under test environment + no DATABASE_PATH', () => {
            cfgMock.getEnvironment.mockReturnValue('test');
            const result = (databaseConfig as any)();
            expect(result).toMatchObject({
                type: 'better-sqlite3',
                database: ':memory:',
                synchronize: true,
                logging: false,
            });
        });

        it('uses DATABASE_PATH literally when set', () => {
            cfgMock.database.getPath.mockReturnValue('/var/lib/test.db');
            const result = (databaseConfig as any)();
            expect(result).toMatchObject({ type: 'better-sqlite3', database: '/var/lib/test.db' });
        });

        it('CLI app type composes ~/.ever-works/ever-works.db', () => {
            cfgMock.getAppType.mockReturnValue('cli');
            const result = (databaseConfig as any)();
            const expected = path.join(os.homedir(), '.ever-works', 'ever-works.db');
            expect(result.database).toBe(expected);
        });

        it('API in development uses tmpdir-based file unless DATABASE_IN_MEMORY=true', () => {
            cfgMock.getAppType.mockReturnValue('api');
            cfgMock.getEnvironment.mockReturnValue('development');
            cfgMock.database.getInMemory.mockReturnValue(false);
            const result = (databaseConfig as any)();
            expect(result.database).toBe(path.join(os.tmpdir(), 'ever-works-api.db'));
        });

        it('API in development uses :memory: when DATABASE_IN_MEMORY=true', () => {
            cfgMock.getAppType.mockReturnValue('api');
            cfgMock.getEnvironment.mockReturnValue('development');
            cfgMock.database.getInMemory.mockReturnValue(true);
            const result = (databaseConfig as any)();
            expect(result.database).toBe(':memory:');
        });

        it('falls back to development semantics when getEnvironment returns falsy', () => {
            // getEnvironment() || 'development' branch.
            cfgMock.getEnvironment.mockReturnValue(undefined);
            const result = (databaseConfig as any)();
            // appType=api (default) + non-test env + in-memory=false → tmpdir file.
            expect(result.database).toBe(path.join(os.tmpdir(), 'ever-works-api.db'));
        });

        it('falls back to API semantics when getAppType returns falsy', () => {
            // getAppType() || 'api' branch.
            cfgMock.getAppType.mockReturnValue(undefined);
            cfgMock.getEnvironment.mockReturnValue('test');
            const result = (databaseConfig as any)();
            expect(result.database).toBe(':memory:');
        });

        it('creates the parent dir for file-based SQLite when missing', () => {
            cfgMock.database.getPath.mockReturnValue('/missing/dir/db.sqlite');
            fsMock.existsSync.mockReturnValue(false);
            (databaseConfig as any)();
            expect(fsMock.mkdirSync).toHaveBeenCalledWith('/missing/dir', { recursive: true });
        });

        it('does NOT mkdir when the parent dir already exists', () => {
            cfgMock.database.getPath.mockReturnValue('/existing/dir/db.sqlite');
            fsMock.existsSync.mockReturnValue(true);
            (databaseConfig as any)();
            expect(fsMock.mkdirSync).not.toHaveBeenCalled();
        });

        it('skips mkdir entirely for :memory: databases', () => {
            cfgMock.getEnvironment.mockReturnValue('test');
            (databaseConfig as any)();
            // existsSync should NOT be called at all because the path starts with ':'.
            expect(fsMock.mkdirSync).not.toHaveBeenCalled();
        });

        it('skips mkdir for any path starting with ":" (defence beyond literal :memory:)', () => {
            cfgMock.database.getPath.mockReturnValue(':custom-shared');
            (databaseConfig as any)();
            expect(fsMock.mkdirSync).not.toHaveBeenCalled();
        });

        it('coerces sqlite/sqlite3 type aliases to better-sqlite3', () => {
            cfgMock.database.getType.mockReturnValue('sqlite');
            cfgMock.getEnvironment.mockReturnValue('test');
            const r1 = (databaseConfig as any)();
            expect(r1.type).toBe('better-sqlite3');

            cfgMock.database.getType.mockReturnValue('sqlite3');
            const r2 = (databaseConfig as any)();
            expect(r2.type).toBe('better-sqlite3');
        });
    });

    describe('SSL mode', () => {
        it('attaches ssl options via getTlsOptions when sslMode=true', () => {
            cfgMock.database.sslMode.mockReturnValue(true);
            cfgMock.database.databaseCaCert.mockReturnValue('LS0tLS1CRUdJTg==');
            cfgMock.getEnvironment.mockReturnValue('test');

            const result = (databaseConfig as any)();

            expect(tlsMock).toHaveBeenCalledWith(true, 'LS0tLS1CRUdJTg==');
            expect(result.ssl).toEqual({ rejectUnauthorized: false, ca: undefined });
        });

        it('omits ssl entirely when sslMode=false', () => {
            cfgMock.database.sslMode.mockReturnValue(false);
            cfgMock.getEnvironment.mockReturnValue('test');
            const result = (databaseConfig as any)();
            expect(result.ssl).toBeUndefined();
            expect(tlsMock).not.toHaveBeenCalled();
        });

        it('respects autoMigrate=false → synchronize: false', () => {
            cfgMock.database.autoMigrate.mockReturnValue(false);
            cfgMock.getEnvironment.mockReturnValue('test');
            const result = (databaseConfig as any)();
            expect(result.synchronize).toBe(false);
        });

        it('respects loggingEnabled=true', () => {
            cfgMock.database.loggingEnabled.mockReturnValue(true);
            cfgMock.getEnvironment.mockReturnValue('test');
            const result = (databaseConfig as any)();
            expect(result.logging).toBe(true);
        });
    });

    describe('DATABASE_URL branch (overrides host config)', () => {
        it('parses URL and forwards both `url` and resolved `database` field', () => {
            cfgMock.database.getType.mockReturnValue('postgres');
            cfgMock.database.getUrl.mockReturnValue('postgres://u:p@h:5432/mydb');
            parseMock.mockReturnValue({ database: 'mydb' } as any);

            const result = (databaseConfig as any)();

            expect(parseMock).toHaveBeenCalledWith('postgres://u:p@h:5432/mydb');
            expect(result).toMatchObject({
                type: 'postgres',
                url: 'postgres://u:p@h:5432/mydb',
                database: 'mydb',
            });
        });

        it('passes through `database: undefined` when URL parser returns null', () => {
            cfgMock.database.getType.mockReturnValue('postgres');
            cfgMock.database.getUrl.mockReturnValue('postgres://invalid');
            parseMock.mockReturnValue(null as any);

            const result = (databaseConfig as any)();

            expect(result).toMatchObject({ url: 'postgres://invalid', database: undefined });
        });

        it('honours URL even when DATABASE_TYPE is mysql', () => {
            cfgMock.database.getType.mockReturnValue('mysql');
            cfgMock.database.getUrl.mockReturnValue('mysql://u:p@h:3306/mydb');
            parseMock.mockReturnValue({ database: 'mydb' } as any);

            const result = (databaseConfig as any)();

            expect(result.type).toBe('mysql');
            expect(result.url).toBe('mysql://u:p@h:3306/mydb');
        });
    });

    describe('PostgreSQL host config', () => {
        beforeEach(() => {
            cfgMock.database.getType.mockReturnValue('postgres');
            cfgMock.database.getUrl.mockReturnValue(undefined);
        });

        it('applies the documented localhost / 5432 / postgres / "" / ever_works defaults', () => {
            const result = (databaseConfig as any)();
            expect(result).toMatchObject({
                type: 'postgres',
                host: 'localhost',
                port: 5432,
                username: 'postgres',
                password: '',
                database: 'ever_works',
            });
        });

        it('overrides every default from env-backed config getters', () => {
            cfgMock.database.getHost.mockReturnValue('db.internal');
            cfgMock.database.getPort.mockReturnValue('6543');
            cfgMock.database.getUsername.mockReturnValue('appuser');
            cfgMock.database.getPassword.mockReturnValue('s3cret');
            cfgMock.database.getDatabaseName.mockReturnValue('production');

            const result = (databaseConfig as any)();

            expect(result).toMatchObject({
                host: 'db.internal',
                port: 6543,
                username: 'appuser',
                password: 's3cret',
                database: 'production',
            });
        });

        it('parses the port via parseInt (so trailing-non-digits are accepted but coerced)', () => {
            cfgMock.database.getPort.mockReturnValue('5433x'); // parseInt strips trailing
            const result = (databaseConfig as any)();
            expect(result.port).toBe(5433);
        });
    });

    describe('MySQL/MariaDB host config', () => {
        it('treats `mariadb` as a `mysql` driver alias', () => {
            cfgMock.database.getType.mockReturnValue('mariadb');
            const result = (databaseConfig as any)();
            // Output type is normalised to 'mysql' regardless of input alias.
            expect(result.type).toBe('mysql');
        });

        it('applies the documented MySQL defaults (3306 / root / "" / ever_works)', () => {
            cfgMock.database.getType.mockReturnValue('mysql');
            const result = (databaseConfig as any)();
            expect(result).toMatchObject({
                type: 'mysql',
                host: 'localhost',
                port: 3306,
                username: 'root',
                password: '',
                database: 'ever_works',
            });
        });

        it('overrides every default from env-backed config getters', () => {
            cfgMock.database.getType.mockReturnValue('mysql');
            cfgMock.database.getHost.mockReturnValue('mysql.internal');
            cfgMock.database.getPort.mockReturnValue('33060');
            cfgMock.database.getUsername.mockReturnValue('app');
            cfgMock.database.getPassword.mockReturnValue('p');
            cfgMock.database.getDatabaseName.mockReturnValue('app_db');

            const result = (databaseConfig as any)();

            expect(result).toMatchObject({
                host: 'mysql.internal',
                port: 33060,
                username: 'app',
                password: 'p',
                database: 'app_db',
            });
        });
    });

    describe('Unknown/unsupported type fallback', () => {
        it('falls back to better-sqlite3 :memory: when type is unknown', () => {
            cfgMock.database.getType.mockReturnValue('cassandra' as any);
            const result = (databaseConfig as any)();
            expect(result).toMatchObject({ type: 'better-sqlite3', database: ':memory:' });
        });
    });

    describe('getDatabaseConfig wrapper', () => {
        it('proxies to the registered factory and returns a TypeORM-compatible options object', () => {
            cfgMock.database.getType.mockReturnValue('postgres');
            const result = getDatabaseConfig();
            expect(result).toMatchObject({
                type: 'postgres',
                host: 'localhost',
                port: 5432,
            });
        });
    });
});
