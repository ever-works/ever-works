import type { PluginEnvironment, EnvironmentVariables } from './plugin-environment.interface.js';
import type {
	PluginSettings,
	PluginSettingsWrite,
	ResolvedSettings,
	SettingScope
} from '../settings/settings.types.js';
import type { PluginEventName, PluginEventPayloads, EventHandler, EventSubscription } from '../events/event-types.js';

/**
 * Logger interface for plugins (minimal, framework-agnostic)
 */
export interface PluginLogger {
	log(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	verbose?(message: string, ...args: unknown[]): void;
}

/**
 * Cache interface for plugins
 */
export interface PluginCache {
	/** Get a cached value */
	get<T>(key: string): Promise<T | undefined>;
	/** Set a cached value with optional TTL in seconds */
	set<T>(key: string, value: T, ttl?: number): Promise<void>;
	/** Delete a cached value */
	delete(key: string): Promise<boolean>;
	/** Check if a key exists */
	has(key: string): Promise<boolean>;
	/** Clear all cached values for this plugin */
	clear(): Promise<void>;
}

/**
 * HTTP client interface for plugins
 */
export interface PluginHttpClient {
	get<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
	post<T>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
	put<T>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
	patch<T>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
	delete<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
}

/**
 * HTTP request options
 */
export interface HttpRequestOptions {
	readonly headers?: Record<string, string>;
	readonly timeout?: number;
	readonly params?: Record<string, string | number | boolean>;
	readonly responseType?: 'json' | 'text' | 'arraybuffer' | 'stream';
}

/**
 * HTTP response
 */
export interface HttpResponse<T> {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Record<string, string>;
	readonly data: T;
}

/**
 * Service references available to plugins
 */
export interface PluginServices {
	/** Directory service (limited interface) */
	readonly directory?: DirectoryServiceRef;
	/** User service (limited interface) */
	readonly user?: UserServiceRef;
}

/**
 * Limited directory service interface for plugins
 */
export interface DirectoryServiceRef {
	getById(id: string): Promise<DirectoryInfo | null>;
	getBySlug(slug: string): Promise<DirectoryInfo | null>;
}

/**
 * Basic directory information
 */
export interface DirectoryInfo {
	readonly id: string;
	readonly name: string;
	readonly slug: string;
	readonly description?: string;
	readonly settings?: Record<string, unknown>;
}

/**
 * Limited user service interface for plugins
 */
export interface UserServiceRef {
	getById(id: string): Promise<UserInfo | null>;
	getCurrentUser(): Promise<UserInfo | null>;
}

/**
 * Basic user information
 */
export interface UserInfo {
	readonly id: string;
	readonly email: string;
	readonly name?: string;
}

/**
 * Custom capability registration
 */
export interface CustomCapabilityDefinition {
	/** Capability name */
	readonly name: string;
	/** Capability description */
	readonly description?: string;
	/** Capability version */
	readonly version?: string;
	/** Capability interface methods */
	readonly methods: readonly string[];
}

/**
 * Context provided to plugins for accessing platform services
 */
export interface PluginContext {
	/** The plugin's ID */
	readonly pluginId: string;

	/** Logger instance scoped to this plugin */
	readonly logger: PluginLogger;

	/** Cache instance scoped to this plugin */
	readonly cache: PluginCache;

	/** HTTP client for making external requests */
	readonly http: PluginHttpClient;

	/** Environment information */
	readonly env: PluginEnvironment;

	/** Environment variables */
	readonly envVars: EnvironmentVariables;

	/** Platform services */
	readonly services: PluginServices;

	/**
	 * Get resolved settings for this plugin
	 * @param scope - Optional scope to get settings from
	 * @param scopeId - Directory or user ID if scope is 'directory' or 'user'
	 */
	getSettings(scope?: SettingScope, scopeId?: string): Promise<PluginSettings>;

	/**
	 * Get fully resolved settings with source information
	 */
	getResolvedSettings(scope?: SettingScope, scopeId?: string): Promise<ResolvedSettings>;

	/**
	 * Persist settings for this plugin at the requested scope.
	 * Secret settings are stored through the platform secret-settings layer.
	 */
	updateSettings(scope: 'user' | 'directory', scopeId: string | undefined, data: PluginSettingsWrite): Promise<void>;

	/**
	 * Subscribe to a platform event
	 */
	onEvent<T extends PluginEventName>(event: T, handler: EventHandler<T>): EventSubscription;

	/**
	 * Emit an event (for plugin-to-plugin communication)
	 */
	emitEvent<T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]): void;

	/**
	 * Register a custom capability
	 */
	registerCustomCapability(capability: CustomCapabilityDefinition, implementation: unknown): void;

	/**
	 * Get a custom capability implementation
	 */
	getCustomCapability<T>(name: string): T | undefined;

	/**
	 * Check if a custom capability is registered
	 */
	hasCustomCapability(name: string): boolean;

	/**
	 * List all registered custom capabilities
	 */
	listCustomCapabilities(): readonly CustomCapabilityDefinition[];
}
