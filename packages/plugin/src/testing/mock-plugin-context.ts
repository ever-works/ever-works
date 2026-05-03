import type {
	PluginContext,
	PluginLogger,
	PluginCache,
	PluginHttpClient,
	PluginServices,
	HttpRequestOptions,
	HttpResponse,
	CustomCapabilityDefinition,
	WorkInfo,
	UserInfo
} from '../contracts/plugin-context.interface.js';
import type { EnvironmentVariables } from '../contracts/plugin-environment.interface.js';
import type {
	PluginSettings,
	PluginSettingsWrite,
	ResolvedSettings,
	SettingScope,
	ResolvedSetting
} from '../settings/settings.types.js';
import type { PluginEventName, PluginEventPayloads, EventHandler, EventSubscription } from '../events/event-types.js';
import {
	createMockPluginEnvironment,
	createMockEnvVars,
	type MockPluginEnvironmentOptions
} from './mock-plugin-environment.js';

/**
 * Mock function type (compatible with vitest/jest)
 */
export type MockFn<T extends (...args: any[]) => any = (...args: any[]) => any> = T & {
	mock: { calls: Parameters<T>[] };
	mockReturnValue: (value: ReturnType<T>) => MockFn<T>;
	mockResolvedValue: (value: Awaited<ReturnType<T>>) => MockFn<T>;
	mockImplementation: (fn: T) => MockFn<T>;
};

/**
 * Create a simple mock function (for use without test framework)
 */
export function createMockFn<T extends (...args: any[]) => any>(): MockFn<T> {
	const calls: Parameters<T>[] = [];
	let implementation: T | undefined;
	let returnValue: ReturnType<T> | undefined;
	let resolvedValue: Awaited<ReturnType<T>> | undefined;

	const fn = ((...args: Parameters<T>) => {
		calls.push(args);
		if (implementation) {
			return implementation(...args);
		}
		if (resolvedValue !== undefined) {
			return Promise.resolve(resolvedValue);
		}
		return returnValue;
	}) as MockFn<T>;

	fn.mock = { calls };
	fn.mockReturnValue = (value) => {
		returnValue = value;
		return fn;
	};
	fn.mockResolvedValue = (value) => {
		resolvedValue = value;
		return fn;
	};
	fn.mockImplementation = (impl) => {
		implementation = impl;
		return fn;
	};

	return fn;
}

/**
 * Create a mock logger for testing
 */
export function createMockLogger(): PluginLogger {
	return {
		log: createMockFn(),
		error: createMockFn(),
		warn: createMockFn(),
		debug: createMockFn(),
		verbose: createMockFn()
	};
}

/**
 * Create a mock cache for testing
 */
export function createMockCache(): PluginCache {
	const store = new Map<string, { value: unknown; expiresAt?: number }>();

	return {
		async get<T>(key: string): Promise<T | undefined> {
			const entry = store.get(key);
			if (!entry) return undefined;
			if (entry.expiresAt && Date.now() > entry.expiresAt) {
				store.delete(key);
				return undefined;
			}
			return entry.value as T;
		},
		async set<T>(key: string, value: T, ttl?: number): Promise<void> {
			store.set(key, {
				value,
				expiresAt: ttl ? Date.now() + ttl * 1000 : undefined
			});
		},
		async delete(key: string): Promise<boolean> {
			return store.delete(key);
		},
		async has(key: string): Promise<boolean> {
			const entry = store.get(key);
			if (!entry) return false;
			if (entry.expiresAt && Date.now() > entry.expiresAt) {
				store.delete(key);
				return false;
			}
			return true;
		},
		async clear(): Promise<void> {
			store.clear();
		}
	};
}

/**
 * Create a mock HTTP client for testing
 */
export function createMockHttpClient(responses?: Map<string, HttpResponse<unknown>>): PluginHttpClient {
	const defaultResponse: HttpResponse<unknown> = {
		status: 200,
		statusText: 'OK',
		headers: {},
		data: {}
	};

	const makeRequest = async <T>(
		method: string,
		url: string,
		_body?: unknown,
		_options?: HttpRequestOptions
	): Promise<HttpResponse<T>> => {
		const key = `${method}:${url}`;
		return (responses?.get(key) ?? defaultResponse) as HttpResponse<T>;
	};

	return {
		get: <T>(url: string, options?: HttpRequestOptions) => makeRequest<T>('GET', url, undefined, options),
		post: <T>(url: string, body?: unknown, options?: HttpRequestOptions) =>
			makeRequest<T>('POST', url, body, options),
		put: <T>(url: string, body?: unknown, options?: HttpRequestOptions) =>
			makeRequest<T>('PUT', url, body, options),
		patch: <T>(url: string, body?: unknown, options?: HttpRequestOptions) =>
			makeRequest<T>('PATCH', url, body, options),
		delete: <T>(url: string, options?: HttpRequestOptions) => makeRequest<T>('DELETE', url, undefined, options)
	};
}

/**
 * Create mock plugin services for testing
 */
export function createMockServices(
	works?: Map<string, WorkInfo>,
	users?: Map<string, UserInfo>,
	currentUser?: UserInfo
): PluginServices {
	return {
		work: {
			async getById(id: string): Promise<WorkInfo | null> {
				return works?.get(id) ?? null;
			},
			async getBySlug(slug: string): Promise<WorkInfo | null> {
				for (const dir of works?.values() ?? []) {
					if (dir.slug === slug) return dir;
				}
				return null;
			}
		},
		user: {
			async getById(id: string): Promise<UserInfo | null> {
				return users?.get(id) ?? null;
			},
			async getCurrentUser(): Promise<UserInfo | null> {
				return currentUser ?? null;
			}
		}
	};
}

/**
 * Options for creating a mock plugin context
 */
export interface MockPluginContextOptions {
	pluginId?: string;
	settings?: PluginSettings;
	env?: MockPluginEnvironmentOptions;
	envVars?: Record<string, string>;
	works?: Map<string, WorkInfo>;
	users?: Map<string, UserInfo>;
	currentUser?: UserInfo;
	httpResponses?: Map<string, HttpResponse<unknown>>;
}

/**
 * Create a mock plugin context for testing
 */
export function createMockPluginContext(options: MockPluginContextOptions = {}): PluginContext & {
	/** Access to event handlers for testing */
	_eventHandlers: Map<string, Set<EventHandler<any>>>;
	/** Access to custom capabilities for testing */
	_customCapabilities: Map<string, { def: CustomCapabilityDefinition; impl: unknown }>;
	/** Emit an event and call handlers (for testing) */
	_triggerEvent: <T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]) => void;
} {
	const eventHandlers = new Map<string, Set<EventHandler<any>>>();
	const customCapabilities = new Map<string, { def: CustomCapabilityDefinition; impl: unknown }>();
	const settings = options.settings ?? {};

	const context = {
		pluginId: options.pluginId ?? 'test-plugin',
		logger: createMockLogger(),
		cache: createMockCache(),
		http: createMockHttpClient(options.httpResponses),
		env: createMockPluginEnvironment(options.env),
		envVars: createMockEnvVars({ variables: options.envVars }),
		services: createMockServices(options.works, options.users, options.currentUser),

		async getSettings(_scope?: SettingScope, _scopeId?: string): Promise<PluginSettings> {
			return settings;
		},

		async getResolvedSettings(_scope?: SettingScope, _scopeId?: string): Promise<ResolvedSettings> {
			const resolved: ResolvedSettings = {};
			for (const [key, value] of Object.entries(settings)) {
				resolved[key] = {
					key,
					value,
					source: 'admin',
					isFallback: false
				};
			}
			return resolved;
		},

		async updateSettings(
			_scope: 'user' | 'work',
			_scopeId: string | undefined,
			data: PluginSettingsWrite
		): Promise<void> {
			Object.assign(settings, data.settings ?? {}, data.secretSettings ?? {});
		},

		onEvent<T extends PluginEventName>(event: T, handler: EventHandler<T>): EventSubscription {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, new Set());
			}
			eventHandlers.get(event)!.add(handler);

			return {
				unsubscribe: () => {
					eventHandlers.get(event)?.delete(handler);
				}
			};
		},

		emitEvent<T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]): void {
			const handlers = eventHandlers.get(event);
			if (handlers) {
				for (const handler of handlers) {
					handler(payload);
				}
			}
		},

		registerCustomCapability(def: CustomCapabilityDefinition, impl: unknown): void {
			customCapabilities.set(def.name, { def, impl });
		},

		getCustomCapability<T>(name: string): T | undefined {
			return customCapabilities.get(name)?.impl as T | undefined;
		},

		hasCustomCapability(name: string): boolean {
			return customCapabilities.has(name);
		},

		listCustomCapabilities(): readonly CustomCapabilityDefinition[] {
			return Array.from(customCapabilities.values()).map((c) => c.def);
		},

		// Test helpers
		_eventHandlers: eventHandlers,
		_customCapabilities: customCapabilities,
		_triggerEvent<T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]): void {
			const handlers = eventHandlers.get(event);
			if (handlers) {
				for (const handler of handlers) {
					handler(payload);
				}
			}
		}
	};

	return context;
}
