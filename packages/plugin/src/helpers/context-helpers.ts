import type {
	PluginContext,
	PluginLogger,
	PluginCache,
	PluginHttpClient
} from '../contracts/plugin-context.interface.js';
import type { PluginEnvironment, EnvironmentVariables } from '../contracts/plugin-environment.interface.js';
import type { PluginSettings } from '../settings/settings.types.js';

/**
 * Assert that context is defined
 * @throws Error if context is undefined
 */
export function assertContext(context: PluginContext | undefined, pluginId?: string): asserts context is PluginContext {
	if (!context) {
		const message = pluginId
			? `Plugin "${pluginId}" is not loaded - context is undefined`
			: 'Plugin is not loaded - context is undefined';
		throw new Error(message);
	}
}

/**
 * Safely get logger from context
 */
export function getLogger(context: PluginContext | undefined): PluginLogger | undefined {
	return context?.logger;
}

/**
 * Safely get cache from context
 */
export function getCache(context: PluginContext | undefined): PluginCache | undefined {
	return context?.cache;
}

/**
 * Safely get HTTP client from context
 */
export function getHttp(context: PluginContext | undefined): PluginHttpClient | undefined {
	return context?.http;
}

/**
 * Safely get environment from context
 */
export function getEnv(context: PluginContext | undefined): PluginEnvironment | undefined {
	return context?.env;
}

/**
 * Safely get environment variables from context
 */
export function getEnvVars(context: PluginContext | undefined): EnvironmentVariables | undefined {
	return context?.envVars;
}

/**
 * Get settings with fallback to empty object
 */
export async function getSettingsSafe(context: PluginContext | undefined): Promise<PluginSettings> {
	if (!context) {
		return {};
	}
	try {
		return await context.getSettings();
	} catch {
		return {};
	}
}

/**
 * Get a specific setting value
 */
export async function getSetting<T>(context: PluginContext | undefined, key: string, defaultValue: T): Promise<T> {
	const settings = await getSettingsSafe(context);
	return (settings[key] as T) ?? defaultValue;
}

/**
 * Get a required setting value
 * @throws Error if setting is not defined
 */
export async function getRequiredSetting<T>(context: PluginContext | undefined, key: string): Promise<T> {
	assertContext(context);
	const settings = await context.getSettings();
	if (!(key in settings) || settings[key] === undefined) {
		throw new Error(`Required setting "${key}" is not defined`);
	}
	return settings[key] as T;
}

/**
 * Create a scoped logger with prefix
 */
export function createScopedLogger(logger: PluginLogger | undefined, prefix: string): PluginLogger {
	const formatMessage = (message: string) => `[${prefix}] ${message}`;

	return {
		log: (message: string, ...args: unknown[]) => logger?.log(formatMessage(message), ...args),
		error: (message: string, ...args: unknown[]) => logger?.error(formatMessage(message), ...args),
		warn: (message: string, ...args: unknown[]) => logger?.warn(formatMessage(message), ...args),
		debug: (message: string, ...args: unknown[]) => logger?.debug(formatMessage(message), ...args),
		verbose: logger?.verbose
			? (message: string, ...args: unknown[]) => logger.verbose!(formatMessage(message), ...args)
			: undefined
	};
}

/**
 * Create a scoped cache with key prefix
 */
export function createScopedCache(cache: PluginCache | undefined, prefix: string): PluginCache {
	const prefixKey = (key: string) => `${prefix}:${key}`;

	return {
		get: async <T>(key: string) => cache?.get<T>(prefixKey(key)),
		set: async <T>(key: string, value: T, ttl?: number) => cache?.set(prefixKey(key), value, ttl),
		delete: async (key: string) => cache?.delete(prefixKey(key)) ?? false,
		has: async (key: string) => cache?.has(prefixKey(key)) ?? false,
		clear: async () => {
			// Note: This only clears what we can access - may not clear all prefixed keys
			// depending on implementation
			// A full implementation would need to track keys
		}
	};
}

/**
 * Check if plugin is in production environment
 */
export function isProduction(context: PluginContext | undefined): boolean {
	return context?.env?.isProduction ?? false;
}

/**
 * Check if plugin is in development environment
 */
export function isDevelopment(context: PluginContext | undefined): boolean {
	return context?.env?.isDevelopment ?? false;
}

/**
 * Check if plugin is in test environment
 */
export function isTest(context: PluginContext | undefined): boolean {
	return context?.env?.isTest ?? false;
}

/**
 * Get platform version
 */
export function getPlatformVersion(context: PluginContext | undefined): string | undefined {
	return context?.env?.platformVersion;
}

/**
 * Check if a feature flag is enabled
 */
export function hasFeature(context: PluginContext | undefined, feature: string): boolean {
	return context?.env?.features?.has(feature) ?? false;
}
