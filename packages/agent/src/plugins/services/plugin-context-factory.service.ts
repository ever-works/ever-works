import { Injectable, Inject, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import type {
    PluginContext,
    PluginLogger,
    PluginCache,
    PluginHttpClient,
    PluginEnvironment,
    EnvironmentVariables,
    PluginSettings,
    PluginSettingsWrite,
    ResolvedSettings,
    SettingScope,
    PluginEventName,
    EventHandler,
    EventSubscription,
    CustomCapabilityDefinition,
    PluginServices,
    HttpResponse,
} from '@ever-works/plugin';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginSettingsService } from './plugin-settings.service';
import { CustomCapabilityRegistryService } from './custom-capability-registry.service';
import { PLUGINS_MODULE_OPTIONS, DEFAULT_PLATFORM_VERSION } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';

/**
 * Callback that receives intercepted log calls from plugin loggers.
 * Used to capture ALL logger output during pipeline execution.
 */
export type LogInterceptorFn = (level: string, message: string, ...args: unknown[]) => void;

/**
 * Service for creating PluginContext instances for plugins.
 * Provides scoped access to platform services.
 */
@Injectable()
export class PluginContextFactoryService {
    private readonly logger = new Logger(PluginContextFactoryService.name);
    private readonly platformVersion: string;
    private readonly environment: 'development' | 'production' | 'test';
    private readonly features: ReadonlySet<string>;
    private injectedServices: Partial<PluginServices> = {};
    /** Per-plugin log interceptors — keyed by pluginId */
    private readonly logInterceptors = new Map<string, Set<LogInterceptorFn>>();

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        private readonly options: PluginsModuleOptions,
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        private readonly customCapabilityRegistry: CustomCapabilityRegistryService,
        private readonly eventEmitter: EventEmitter2,
        @Inject(CACHE_MANAGER)
        private readonly cacheManager: Cache,
    ) {
        this.platformVersion = options.platformVersion || DEFAULT_PLATFORM_VERSION;
        this.environment = options.environment || 'development';
        this.features = new Set(options.features || []);
    }

    /**
     * Inject platform services into plugin context.
     * Call this during module initialization to provide access to UserService, WorkService, etc.
     */
    injectServices(services: Partial<PluginServices>): void {
        this.injectedServices = { ...this.injectedServices, ...services };
        this.logger.debug(
            `Injected ${Object.keys(services).length} service(s) into plugin context`,
        );
    }

    /**
     * Create a PluginContext for a plugin
     */
    createContext(
        pluginId: string,
        scopeOptions?: {
            userId?: string;
            workId?: string;
        },
    ): PluginContext {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            throw new Error(`Plugin "${pluginId}" not found`);
        }

        const context: PluginContext = {
            pluginId,
            logger: this.createLogger(pluginId),
            cache: this.createCache(pluginId),
            http: this.createHttpClient(pluginId),
            env: this.createEnvironment(),
            envVars: this.createEnvVars(),
            services: this.createServices(scopeOptions),

            getSettings: async (
                scope?: SettingScope,
                scopeId?: string,
            ): Promise<PluginSettings> => {
                const options = this.buildSettingsOptions(scope, scopeId, scopeOptions);
                return this.settingsService.getSettings(pluginId, {
                    ...options,
                    includeSecrets: true,
                });
            },

            getResolvedSettings: async (
                scope?: SettingScope,
                scopeId?: string,
            ): Promise<ResolvedSettings> => {
                const options = this.buildSettingsOptions(scope, scopeId, scopeOptions);
                return this.settingsService.getResolvedSettings(pluginId, {
                    ...options,
                    includeSecrets: true,
                });
            },

            updateSettings: async (
                scope: 'user' | 'work',
                scopeId: string | undefined,
                data: PluginSettingsWrite,
            ): Promise<void> => {
                const settings = data.settings ?? {};
                const secretSettings = data.secretSettings ?? {};
                const combined = { ...settings, ...secretSettings };
                const secretKeys = Object.keys(secretSettings);

                if (Object.keys(combined).length === 0) {
                    return;
                }

                if (scope === 'user') {
                    const targetUserId = scopeId ?? scopeOptions?.userId;
                    if (!targetUserId) {
                        throw new Error(
                            `Plugin "${pluginId}" attempted to update user settings without a userId`,
                        );
                    }

                    await this.settingsService.updateUserSettings(
                        pluginId,
                        targetUserId,
                        combined,
                        {
                            secretKeys,
                        },
                    );
                    return;
                }

                const targetWorkId = scopeId ?? scopeOptions?.workId;
                if (!targetWorkId) {
                    throw new Error(
                        `Plugin "${pluginId}" attempted to update work settings without a workId`,
                    );
                }

                await this.settingsService.updateWorkSettings(pluginId, targetWorkId, combined, {
                    secretKeys,
                });
            },

            onEvent: <T extends PluginEventName>(
                event: T,
                handler: EventHandler<T>,
            ): EventSubscription => {
                const listener = (payload: unknown) => {
                    try {
                        handler(payload as Parameters<EventHandler<T>>[0]);
                    } catch (error) {
                        this.logger.error(
                            `Error in event handler for ${event} in plugin ${pluginId}:`,
                            error,
                        );
                    }
                };

                this.eventEmitter.on(event, listener);

                return {
                    unsubscribe: () => {
                        this.eventEmitter.off(event, listener);
                    },
                };
            },

            emitEvent: <T extends PluginEventName>(event: T, payload: unknown): void => {
                // Add standard fields to payload
                const enrichedPayload = {
                    ...(payload as object),
                    timestamp: Date.now(),
                    correlationId: this.generateCorrelationId(),
                };
                this.eventEmitter.emit(event, enrichedPayload);
            },

            registerCustomCapability: (
                capability: CustomCapabilityDefinition,
                implementation: unknown,
            ): void => {
                this.customCapabilityRegistry.register(capability, implementation, pluginId);
            },

            getCustomCapability: <T>(name: string): T | undefined => {
                return this.customCapabilityRegistry.getImplementation<T>(name);
            },

            hasCustomCapability: (name: string): boolean => {
                return this.customCapabilityRegistry.has(name);
            },

            listCustomCapabilities: (): readonly CustomCapabilityDefinition[] => {
                return this.customCapabilityRegistry.list();
            },
        };

        return context;
    }

    /**
     * Create a scoped context for a specific user and/or work
     */
    createScopedContext(pluginId: string, userId?: string, workId?: string): PluginContext {
        return this.createContext(pluginId, { userId, workId });
    }

    /**
     * Add a log interceptor for a plugin.
     * All logger.log/warn/error/debug/verbose calls will also be forwarded to the interceptor.
     * Returns an unsubscribe function.
     */
    addLogInterceptor(pluginId: string, fn: LogInterceptorFn): () => void {
        let set = this.logInterceptors.get(pluginId);
        if (!set) {
            set = new Set();
            this.logInterceptors.set(pluginId, set);
        }
        set.add(fn);
        return () => {
            set!.delete(fn);
            if (set!.size === 0) {
                this.logInterceptors.delete(pluginId);
            }
        };
    }

    /**
     * Create a PluginLogger for a plugin.
     * Each call is forwarded to both the NestJS logger and any active interceptors.
     */
    private createLogger(pluginId: string): PluginLogger {
        const logger = new Logger(`Plugin:${pluginId}`);
        const interceptors = this.logInterceptors;

        const fireInterceptors = (level: string, message: string, ...args: unknown[]) => {
            const set = interceptors.get(pluginId);
            if (set && set.size > 0) {
                for (const fn of set) {
                    try {
                        fn(level, message, ...args);
                    } catch {
                        // never let interceptor errors break the plugin
                    }
                }
            }
        };

        return {
            log: (message: string, ...args: unknown[]) => {
                logger.log(message, ...args);
                fireInterceptors('info', message, ...args);
            },
            error: (message: string, trace?: string, ...args: unknown[]) => {
                logger.error(message, trace, ...args);
                fireInterceptors('error', message, ...args);
            },
            warn: (message: string, ...args: unknown[]) => {
                logger.warn(message, ...args);
                fireInterceptors('warn', message, ...args);
            },
            debug: (message: string, ...args: unknown[]) => {
                logger.debug(message, ...args);
                fireInterceptors('debug', message, ...args);
            },
            verbose: (message: string, ...args: unknown[]) => {
                logger.verbose(message, ...args);
                fireInterceptors('debug', message, ...args);
            },
        };
    }

    /**
     * Create a PluginCache for a plugin
     */
    private createCache(pluginId: string): PluginCache {
        const keyPrefix = `plugin:${pluginId}:`;

        return {
            get: async <T>(key: string): Promise<T | undefined> => {
                return this.cacheManager.get<T>(`${keyPrefix}${key}`);
            },
            set: async <T>(key: string, value: T, ttl?: number): Promise<void> => {
                await this.cacheManager.set(`${keyPrefix}${key}`, value, ttl);
            },
            delete: async (key: string): Promise<boolean> => {
                await this.cacheManager.del(`${keyPrefix}${key}`);
                return true;
            },
            has: async (key: string): Promise<boolean> => {
                const value = await this.cacheManager.get(`${keyPrefix}${key}`);
                return value !== undefined;
            },
            clear: async (): Promise<void> => {
                // Cache manager doesn't support prefix-based clearing
                // This would need a custom implementation
                this.logger.warn(`Cache clear requested for plugin ${pluginId}`);
            },
        };
    }

    /**
     * Create a PluginHttpClient for a plugin
     */
    private createHttpClient(pluginId: string): PluginHttpClient {
        const makeRequest = async <T>(
            method: string,
            url: string,
            body?: unknown,
            options?: { headers?: Record<string, string>; timeout?: number },
        ): Promise<HttpResponse<T>> => {
            const response = await fetch(url, {
                method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...options?.headers,
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
            });

            let data: T;
            try {
                data = (await response.json()) as T;
            } catch {
                data = undefined as T;
            }

            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });

            return {
                data,
                status: response.status,
                statusText: response.statusText,
                headers,
            };
        };

        return {
            get: <T>(
                url: string,
                options?: { headers?: Record<string, string>; timeout?: number },
            ) => makeRequest<T>('GET', url, undefined, options),

            post: <T>(
                url: string,
                body?: unknown,
                options?: { headers?: Record<string, string>; timeout?: number },
            ) => makeRequest<T>('POST', url, body, options),

            put: <T>(
                url: string,
                body?: unknown,
                options?: { headers?: Record<string, string>; timeout?: number },
            ) => makeRequest<T>('PUT', url, body, options),

            patch: <T>(
                url: string,
                body?: unknown,
                options?: { headers?: Record<string, string>; timeout?: number },
            ) => makeRequest<T>('PATCH', url, body, options),

            delete: <T>(
                url: string,
                options?: { headers?: Record<string, string>; timeout?: number },
            ) => makeRequest<T>('DELETE', url, undefined, options),
        };
    }

    /**
     * Create PluginServices for a plugin.
     */
    private createServices(_scopeOptions?: { userId?: string; workId?: string }): PluginServices {
        return {
            work: this.injectedServices.work,
            user: this.injectedServices.user,
        };
    }

    /**
     * Create a PluginEnvironment
     */
    private createEnvironment(): PluginEnvironment {
        return {
            platform: 'ever-works',
            platformVersion: this.platformVersion,
            nodeVersion: process.version,
            isProduction: this.environment === 'production',
            isDevelopment: this.environment === 'development',
            isTest: this.environment === 'test',
            baseUrl: this.options.baseUrl || '',
            apiBaseUrl: this.options.apiBaseUrl || '',
            tempDir: this.options.tempDir || '/tmp',
            dataDir: this.options.dataDir || '/data',
            features: this.features,
        };
    }

    /**
     * Create an EnvironmentVariables accessor
     */
    private createEnvVars(): EnvironmentVariables {
        return {
            get: (key: string): string | undefined => {
                return process.env[key];
            },
            getOrDefault: (key: string, defaultValue: string): string => {
                return process.env[key] ?? defaultValue;
            },
            has: (key: string): boolean => {
                return key in process.env;
            },
            getRequired: (key: string): string => {
                const value = process.env[key];
                if (value === undefined) {
                    throw new Error(`Required environment variable "${key}" is not set`);
                }
                return value;
            },
        };
    }

    /**
     * Build settings options from scope and IDs
     */
    private buildSettingsOptions(
        scope?: SettingScope,
        scopeId?: string,
        defaultScope?: { userId?: string; workId?: string },
    ): { scope?: SettingScope; userId?: string; workId?: string } {
        const options: { scope?: SettingScope; userId?: string; workId?: string } = {
            scope,
        };

        if (scope === 'user' && scopeId) {
            options.userId = scopeId;
        } else if (scope === 'work' && scopeId) {
            options.workId = scopeId;
        }

        // Apply defaults from context scope
        if (defaultScope?.userId && !options.userId) {
            options.userId = defaultScope.userId;
        }
        if (defaultScope?.workId && !options.workId) {
            options.workId = defaultScope.workId;
        }

        return options;
    }

    /**
     * Generate a correlation ID for event tracking
     */
    private generateCorrelationId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
}
