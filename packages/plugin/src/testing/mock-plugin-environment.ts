import type { PluginEnvironment, EnvironmentVariables } from '../contracts/plugin-environment.interface.js';

/**
 * Options for creating a mock plugin environment
 */
export interface MockPluginEnvironmentOptions {
	platform?: string;
	platformVersion?: string;
	nodeVersion?: string;
	isProduction?: boolean;
	isDevelopment?: boolean;
	isTest?: boolean;
	baseUrl?: string;
	apiBaseUrl?: string;
	tempDir?: string;
	dataDir?: string;
	features?: Set<string> | string[];
}

/**
 * Create a mock plugin environment for testing
 */
export function createMockPluginEnvironment(options: MockPluginEnvironmentOptions = {}): PluginEnvironment {
	return {
		platform: options.platform ?? 'ever-works',
		platformVersion: options.platformVersion ?? '1.0.0',
		nodeVersion: options.nodeVersion ?? process.version,
		isProduction: options.isProduction ?? false,
		isDevelopment: options.isDevelopment ?? true,
		isTest: options.isTest ?? true,
		baseUrl: options.baseUrl ?? 'http://localhost:3000',
		apiBaseUrl: options.apiBaseUrl ?? 'http://localhost:3100',
		tempDir: options.tempDir ?? '/tmp/plugin-test',
		dataDir: options.dataDir ?? '/tmp/plugin-test/data',
		features: options.features instanceof Set ? options.features : new Set(options.features ?? [])
	};
}

/**
 * Options for creating mock environment variables
 */
export interface MockEnvVarsOptions {
	variables?: Record<string, string>;
}

/**
 * Create mock environment variables for testing
 */
export function createMockEnvVars(options: MockEnvVarsOptions = {}): EnvironmentVariables {
	const vars = new Map<string, string>(Object.entries(options.variables ?? {}));

	return {
		get(key: string): string | undefined {
			return vars.get(key);
		},
		getOrDefault(key: string, defaultValue: string): string {
			return vars.get(key) ?? defaultValue;
		},
		has(key: string): boolean {
			return vars.has(key);
		},
		getRequired(key: string): string {
			const value = vars.get(key);
			if (value === undefined) {
				throw new Error(`Environment variable "${key}" is required but not set`);
			}
			return value;
		}
	};
}

/**
 * Create a production-like environment for testing
 */
export function createProductionEnvironment(overrides: MockPluginEnvironmentOptions = {}): PluginEnvironment {
	return createMockPluginEnvironment({
		isProduction: true,
		isDevelopment: false,
		isTest: false,
		baseUrl: 'https://example.com',
		apiBaseUrl: 'https://api.example.com',
		...overrides
	});
}

/**
 * Create a development-like environment for testing
 */
export function createDevelopmentEnvironment(overrides: MockPluginEnvironmentOptions = {}): PluginEnvironment {
	return createMockPluginEnvironment({
		isProduction: false,
		isDevelopment: true,
		isTest: false,
		...overrides
	});
}
