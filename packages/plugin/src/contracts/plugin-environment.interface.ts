/**
 * Platform environment information available to plugins
 */
export interface PluginEnvironment {
	/** Platform name (e.g., 'ever-works') */
	readonly platform: string;
	/** Platform version */
	readonly platformVersion: string;
	/** Node.js version */
	readonly nodeVersion: string;
	/** Whether running in production */
	readonly isProduction: boolean;
	/** Whether running in development */
	readonly isDevelopment: boolean;
	/** Whether running in test */
	readonly isTest: boolean;
	/** Base URL of the platform */
	readonly baseUrl?: string;
	/** API base URL */
	readonly apiBaseUrl?: string;
	/** Temporary directory path */
	readonly tempDir: string;
	/** Plugin data directory path */
	readonly dataDir: string;
	/** Available features/flags */
	readonly features: ReadonlySet<string>;
}

/**
 * Environment variable access interface
 */
export interface EnvironmentVariables {
	/** Get an environment variable value */
	get(key: string): string | undefined;
	/** Get an environment variable with a default value */
	getOrDefault(key: string, defaultValue: string): string;
	/** Check if an environment variable exists */
	has(key: string): boolean;
	/** Get required environment variable (throws if not set) */
	getRequired(key: string): string;
}
