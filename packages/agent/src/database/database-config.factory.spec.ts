// Mock the DatabaseModule import so this spec stays a pure factory test —
// it does NOT pull TypeORM / @nestjs/typeorm into the JIT, and does NOT
// run any module-init side-effect. The factory is contractually meant to
// (a) mutate process.env and (b) return the SAME DatabaseModule reference,
// regardless of the input. Mocking the module to a sentinel object lets us
// assert (b) by reference equality.
jest.mock('./database.module', () => ({
    __esModule: true,
    DatabaseModule: { __mock: 'DatabaseModule' },
}));

import { createDatabaseModuleWithEnv, DatabaseConfigurations } from './database-config.factory';
import { DatabaseModule } from './database.module';

describe('database-config.factory', () => {
    // Snapshot every env var the factory writes so each test starts clean
    // and the suite leaves no global state behind.
    const TRACKED_KEYS = [
        'APP_TYPE',
        'NODE_ENV',
        'DATABASE_TYPE',
        'DATABASE_IN_MEMORY',
        'DATABASE_LOGGING',
        'DATABASE_PATH',
        'DATABASE_URL',
        'DATABASE_HOST',
        'DATABASE_PORT',
        'DATABASE_USERNAME',
        'DATABASE_PASSWORD',
        'DATABASE_NAME',
    ] as const;
    const ORIGINAL_ENV: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of TRACKED_KEYS) {
            ORIGINAL_ENV[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of TRACKED_KEYS) {
            const original = ORIGINAL_ENV[key];
            if (original === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original;
            }
        }
    });

    describe('createDatabaseModuleWithEnv', () => {
        it('writes every entry into process.env and returns the DatabaseModule reference', () => {
            const result = createDatabaseModuleWithEnv({
                APP_TYPE: 'cli',
                DATABASE_TYPE: 'sqlite',
                DATABASE_LOGGING: 'true',
            });
            expect(process.env.APP_TYPE).toBe('cli');
            expect(process.env.DATABASE_TYPE).toBe('sqlite');
            expect(process.env.DATABASE_LOGGING).toBe('true');
            expect(result).toBe(DatabaseModule);
        });

        it('overwrites pre-existing env values (last write wins)', () => {
            process.env.APP_TYPE = 'cli';
            createDatabaseModuleWithEnv({ APP_TYPE: 'api' });
            expect(process.env.APP_TYPE).toBe('api');
        });

        it('returns the SAME DatabaseModule reference even when the env map is empty', () => {
            expect(createDatabaseModuleWithEnv({})).toBe(DatabaseModule);
        });
    });

    describe('DatabaseConfigurations.cli', () => {
        it('sets APP_TYPE=cli + DATABASE_TYPE=sqlite and returns the DatabaseModule', () => {
            const result = DatabaseConfigurations.cli();
            expect(process.env.APP_TYPE).toBe('cli');
            expect(process.env.DATABASE_TYPE).toBe('sqlite');
            expect(result).toBe(DatabaseModule);
        });
    });

    describe('DatabaseConfigurations.apiDevelopment', () => {
        it('sets the API + in-memory + logging-on env shape', () => {
            DatabaseConfigurations.apiDevelopment();
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('sqlite');
            expect(process.env.DATABASE_IN_MEMORY).toBe('true');
            expect(process.env.DATABASE_LOGGING).toBe('true');
        });

        it('returns the DatabaseModule reference', () => {
            expect(DatabaseConfigurations.apiDevelopment()).toBe(DatabaseModule);
        });
    });

    describe('DatabaseConfigurations.apiProduction', () => {
        it('sets the API + persistent + logging-off env shape WITHOUT a DATABASE_PATH when no arg is passed', () => {
            DatabaseConfigurations.apiProduction();
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('sqlite');
            expect(process.env.DATABASE_IN_MEMORY).toBe('false');
            expect(process.env.DATABASE_LOGGING).toBe('false');
            expect(process.env.DATABASE_PATH).toBeUndefined();
        });

        it('sets DATABASE_PATH only when the arg is truthy', () => {
            DatabaseConfigurations.apiProduction('/var/lib/ever-works/db.sqlite');
            expect(process.env.DATABASE_PATH).toBe('/var/lib/ever-works/db.sqlite');
        });

        it('does NOT set DATABASE_PATH when the arg is the empty string (falsy)', () => {
            DatabaseConfigurations.apiProduction('');
            expect(process.env.DATABASE_PATH).toBeUndefined();
        });
    });

    describe('DatabaseConfigurations.test', () => {
        it('sets NODE_ENV=test + sqlite + logging-off', () => {
            DatabaseConfigurations.test();
            expect(process.env.NODE_ENV).toBe('test');
            expect(process.env.DATABASE_TYPE).toBe('sqlite');
            expect(process.env.DATABASE_LOGGING).toBe('false');
        });

        it('does NOT set DATABASE_IN_MEMORY (relies on agent default)', () => {
            DatabaseConfigurations.test();
            expect(process.env.DATABASE_IN_MEMORY).toBeUndefined();
        });
    });

    describe('DatabaseConfigurations.postgres', () => {
        it('uses DATABASE_URL when options.url is provided (skips host/port/etc.)', () => {
            DatabaseConfigurations.postgres({
                url: 'postgres://u:p@db.example.com:6432/app',
                logging: true,
            });
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('postgres');
            expect(process.env.DATABASE_URL).toBe('postgres://u:p@db.example.com:6432/app');
            expect(process.env.DATABASE_LOGGING).toBe('true');
            // The url branch must NOT also set the per-field env vars.
            expect(process.env.DATABASE_HOST).toBeUndefined();
            expect(process.env.DATABASE_PORT).toBeUndefined();
            expect(process.env.DATABASE_USERNAME).toBeUndefined();
            expect(process.env.DATABASE_PASSWORD).toBeUndefined();
            expect(process.env.DATABASE_NAME).toBeUndefined();
        });

        it('coerces logging to "false" when omitted from the url branch', () => {
            DatabaseConfigurations.postgres({ url: 'postgres://localhost/db' });
            expect(process.env.DATABASE_LOGGING).toBe('false');
        });

        it('uses the per-field defaults when no options object is passed', () => {
            DatabaseConfigurations.postgres();
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('postgres');
            expect(process.env.DATABASE_HOST).toBe('localhost');
            expect(process.env.DATABASE_PORT).toBe('5432');
            expect(process.env.DATABASE_USERNAME).toBe('postgres');
            expect(process.env.DATABASE_PASSWORD).toBe('');
            expect(process.env.DATABASE_NAME).toBe('ever_works');
            expect(process.env.DATABASE_LOGGING).toBe('false');
            expect(process.env.DATABASE_URL).toBeUndefined();
        });

        it('overrides every per-field default when options are provided', () => {
            DatabaseConfigurations.postgres({
                host: 'pg.internal',
                port: 6543,
                username: 'app',
                password: 's3cret',
                databaseName: 'ever_works_prod',
                logging: true,
            });
            expect(process.env.DATABASE_HOST).toBe('pg.internal');
            expect(process.env.DATABASE_PORT).toBe('6543');
            expect(process.env.DATABASE_USERNAME).toBe('app');
            expect(process.env.DATABASE_PASSWORD).toBe('s3cret');
            expect(process.env.DATABASE_NAME).toBe('ever_works_prod');
            expect(process.env.DATABASE_LOGGING).toBe('true');
        });

        it('preserves a literal `0` port via the `||` fallback (defaults to 5432 because 0 is falsy)', () => {
            // This pins the current `||` semantics — port: 0 falls through to
            // the default. A future refactor to `??` would let 0 through and
            // is therefore a deliberate API change.
            DatabaseConfigurations.postgres({ port: 0 });
            expect(process.env.DATABASE_PORT).toBe('5432');
        });
    });

    describe('DatabaseConfigurations.mysql', () => {
        it('uses DATABASE_URL when options.url is provided (skips host/port/etc.)', () => {
            DatabaseConfigurations.mysql({
                url: 'mysql://root:secret@db.example.com:3306/app',
                logging: true,
            });
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('mysql');
            expect(process.env.DATABASE_URL).toBe('mysql://root:secret@db.example.com:3306/app');
            expect(process.env.DATABASE_LOGGING).toBe('true');
            expect(process.env.DATABASE_HOST).toBeUndefined();
            expect(process.env.DATABASE_PORT).toBeUndefined();
        });

        it('coerces logging to "false" when omitted from the url branch', () => {
            DatabaseConfigurations.mysql({ url: 'mysql://localhost/db' });
            expect(process.env.DATABASE_LOGGING).toBe('false');
        });

        it('uses the per-field defaults when no options object is passed', () => {
            DatabaseConfigurations.mysql();
            expect(process.env.APP_TYPE).toBe('api');
            expect(process.env.DATABASE_TYPE).toBe('mysql');
            expect(process.env.DATABASE_HOST).toBe('localhost');
            expect(process.env.DATABASE_PORT).toBe('3306');
            expect(process.env.DATABASE_USERNAME).toBe('root');
            expect(process.env.DATABASE_PASSWORD).toBe('');
            expect(process.env.DATABASE_NAME).toBe('ever_works');
            expect(process.env.DATABASE_LOGGING).toBe('false');
            expect(process.env.DATABASE_URL).toBeUndefined();
        });

        it('overrides every per-field default when options are provided', () => {
            DatabaseConfigurations.mysql({
                host: 'mysql.internal',
                port: 33060,
                username: 'app',
                password: 's3cret',
                databaseName: 'ever_works_prod',
                logging: true,
            });
            expect(process.env.DATABASE_HOST).toBe('mysql.internal');
            expect(process.env.DATABASE_PORT).toBe('33060');
            expect(process.env.DATABASE_USERNAME).toBe('app');
            expect(process.env.DATABASE_PASSWORD).toBe('s3cret');
            expect(process.env.DATABASE_NAME).toBe('ever_works_prod');
            expect(process.env.DATABASE_LOGGING).toBe('true');
        });

        it('preserves a literal `0` port via the `||` fallback (defaults to 3306 because 0 is falsy)', () => {
            DatabaseConfigurations.mysql({ port: 0 });
            expect(process.env.DATABASE_PORT).toBe('3306');
        });
    });

    describe('cross-configuration contract', () => {
        it.each([
            ['cli', () => DatabaseConfigurations.cli()],
            ['apiDevelopment', () => DatabaseConfigurations.apiDevelopment()],
            ['apiProduction', () => DatabaseConfigurations.apiProduction()],
            ['test', () => DatabaseConfigurations.test()],
            ['postgres', () => DatabaseConfigurations.postgres()],
            ['mysql', () => DatabaseConfigurations.mysql()],
        ])('%s returns the same DatabaseModule reference', (_name, run) => {
            expect(run()).toBe(DatabaseModule);
        });
    });
});
