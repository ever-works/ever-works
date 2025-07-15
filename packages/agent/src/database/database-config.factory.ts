import { DatabaseModule } from './database.module';

/**
 * Helper to create DatabaseModule with specific environment variables
 * This is the recommended way to configure the database for different environments
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
 * Predefined database module configurations for common use cases
 * These all use the same DatabaseModule with different environment variables
 */
export const DatabaseConfigurations = {
	/**
	 * CLI configuration - uses persistent SQLite file in user's home directory
	 */
	cli: () =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'cli',
			DATABASE_TYPE: 'sqlite'
		}),

	/**
	 * API development configuration - uses in-memory SQLite by default
	 */
	apiDevelopment: () =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'api',
			DATABASE_TYPE: 'sqlite',
			DATABASE_IN_MEMORY: 'true',
			DATABASE_LOGGING: 'true'
		}),

	/**
	 * API production configuration - uses persistent SQLite file
	 */
	apiProduction: (databasePath?: string) =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'api',
			DATABASE_TYPE: 'sqlite',
			DATABASE_IN_MEMORY: 'false',
			DATABASE_LOGGING: 'false',
			...(databasePath && { DATABASE_PATH: databasePath })
		}),

	/**
	 * Test configuration - always uses in-memory database
	 */
	test: () =>
		createDatabaseModuleWithEnv({
			NODE_ENV: 'test',
			DATABASE_LOGGING: 'false',
			DATABASE_TYPE: 'sqlite'
		}),

	/**
	 * PostgreSQL configuration for production
	 */
	postgres: (
		options: {
			host?: string;
			port?: number;
			username?: string;
			password?: string;
			databaseName?: string;
			logging?: boolean;
		} = {}
	) =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'api',
			DATABASE_TYPE: 'postgres',
			DATABASE_HOST: options.host || 'localhost',
			DATABASE_PORT: (options.port || 5432).toString(),
			DATABASE_USERNAME: options.username || 'postgres',
			DATABASE_PASSWORD: options.password || '',
			DATABASE_NAME: options.databaseName || 'ever_works',
			DATABASE_LOGGING: (options.logging || false).toString()
		}),

	/**
	 * MySQL configuration for production
	 */
	mysql: (
		options: {
			host?: string;
			port?: number;
			username?: string;
			password?: string;
			databaseName?: string;
			logging?: boolean;
		} = {}
	) =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'api',
			DATABASE_TYPE: 'mysql',
			DATABASE_HOST: options.host || 'localhost',
			DATABASE_PORT: (options.port || 3306).toString(),
			DATABASE_USERNAME: options.username || 'root',
			DATABASE_PASSWORD: options.password || '',
			DATABASE_NAME: options.databaseName || 'ever_works',
			DATABASE_LOGGING: (options.logging || false).toString()
		}),

	/**
	 * MariaDB configuration for production
	 */
	mariadb: (
		options: {
			host?: string;
			port?: number;
			username?: string;
			password?: string;
			databaseName?: string;
			logging?: boolean;
		} = {}
	) =>
		createDatabaseModuleWithEnv({
			APP_TYPE: 'api',
			DATABASE_TYPE: 'mariadb',
			DATABASE_HOST: options.host || 'localhost',
			DATABASE_PORT: (options.port || 3306).toString(),
			DATABASE_USERNAME: options.username || 'root',
			DATABASE_PASSWORD: options.password || '',
			DATABASE_NAME: options.databaseName || 'ever_works',
			DATABASE_LOGGING: (options.logging || false).toString()
		})
};
