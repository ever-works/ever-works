import { DatabaseModule } from './database.module';

/**
 * Side-effecting helper: writes every entry of `envVars` into
 * `process.env` and returns the standard {@link DatabaseModule}.
 *
 * **Side-effect warning.** The returned module is the same singleton
 * regardless of input — the meaningful work happens in the env-var
 * mutation. Consequences a future caller needs to know:
 *
 * - **Order of calls matters.** Calling `cli()` then `apiProduction()`
 *   leaves you with apiProduction's env vars; the second call
 *   overwrites whatever the first set.
 * - **Process-wide pollution.** Anything in the process (including
 *   unrelated services and other plugins) that reads `process.env`
 *   after this call sees the last-applied values.
 * - **Not reversible.** There is no reset; env vars stay for the
 *   process lifetime. Test suites that mix configurations across
 *   tests must restore `process.env` themselves.
 * - **`DatabaseConfigurations.cli()` activates the destructive path
 *   in {@link DatabaseInitService}** by setting `APP_TYPE=cli`.
 *   That env var is the only gate on `dataSource.synchronize()`,
 *   which drops columns not present in entities. NEVER call `cli()`
 *   in a process that touches a production database (see the DANGER
 *   block on `DatabaseInitService` and NN #16 in CLAUDE.md).
 */
export function createDatabaseModuleWithEnv(envVars: Record<string, string>) {
    // Set environment variables
    Object.entries(envVars).forEach(([key, value]) => {
        process.env[key] = value;
    });

    // Return the standard DatabaseModule which will use the environment variables
    return DatabaseModule;
}

/**
 * Predefined env-var profiles for {@link createDatabaseModuleWithEnv}.
 * Despite the name, these are NOT in-memory configuration objects —
 * each call mutates `process.env`. See the side-effect warning on
 * `createDatabaseModuleWithEnv` before mixing profiles in one process.
 */
export const DatabaseConfigurations = {
    /**
     * CLI configuration - uses persistent SQLite file in user's home work
     */
    cli: () => {
        return createDatabaseModuleWithEnv({
            APP_TYPE: 'cli',
            DATABASE_TYPE: 'sqlite',
        });
    },

    /**
     * API development configuration - uses in-memory SQLite by default
     */
    apiDevelopment: () => {
        return createDatabaseModuleWithEnv({
            APP_TYPE: 'api',
            DATABASE_TYPE: 'sqlite',
            DATABASE_IN_MEMORY: 'true',
            DATABASE_LOGGING: 'true',
        });
    },

    /**
     * API production configuration - uses persistent SQLite file
     */
    apiProduction: (databasePath?: string) => {
        return createDatabaseModuleWithEnv({
            APP_TYPE: 'api',
            DATABASE_TYPE: 'sqlite',
            DATABASE_IN_MEMORY: 'false',
            DATABASE_LOGGING: 'false',
            ...(databasePath && { DATABASE_PATH: databasePath }),
        });
    },

    /**
     * Test configuration - always uses in-memory database
     */
    test: () => {
        return createDatabaseModuleWithEnv({
            NODE_ENV: 'test',
            DATABASE_LOGGING: 'false',
            DATABASE_TYPE: 'sqlite',
        });
    },

    /**
     * PostgreSQL configuration for production
     */
    postgres: (
        options: {
            host?: string;
            port?: number;
            url?: string;
            username?: string;
            password?: string;
            databaseName?: string;
            logging?: boolean;
        } = {},
    ) => {
        if (options.url) {
            return createDatabaseModuleWithEnv({
                APP_TYPE: 'api',
                DATABASE_TYPE: 'postgres',
                DATABASE_URL: options.url,
                DATABASE_LOGGING: (options.logging || false).toString(),
            });
        }

        return createDatabaseModuleWithEnv({
            APP_TYPE: 'api',
            DATABASE_TYPE: 'postgres',
            DATABASE_HOST: options.host || 'localhost',
            DATABASE_PORT: (options.port || 5432).toString(),
            DATABASE_USERNAME: options.username || 'postgres',
            DATABASE_PASSWORD: options.password || '',
            DATABASE_NAME: options.databaseName || 'ever_works',
            DATABASE_LOGGING: (options.logging || false).toString(),
        });
    },

    /**
     * MySQL configuration for production
     */
    mysql: (
        options: {
            host?: string;
            port?: number;
            url?: string;
            username?: string;
            password?: string;
            databaseName?: string;
            logging?: boolean;
        } = {},
    ) => {
        if (options.url) {
            return createDatabaseModuleWithEnv({
                APP_TYPE: 'api',
                DATABASE_TYPE: 'mysql',
                DATABASE_URL: options.url,
                DATABASE_LOGGING: (options.logging || false).toString(),
            });
        }

        return createDatabaseModuleWithEnv({
            APP_TYPE: 'api',
            DATABASE_TYPE: 'mysql',
            DATABASE_HOST: options.host || 'localhost',
            DATABASE_PORT: (options.port || 3306).toString(),
            DATABASE_USERNAME: options.username || 'root',
            DATABASE_PASSWORD: options.password || '',
            DATABASE_NAME: options.databaseName || 'ever_works',
            DATABASE_LOGGING: (options.logging || false).toString(),
        });
    },
};
