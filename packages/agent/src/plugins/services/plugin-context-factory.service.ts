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
 * Service for creating PluginContext instances for plugins.
 * Provides scoped access to platform services.
 */
@Injectable()
export class PluginContextFactoryService {
    private readonly logger = new Logger(PluginContextFactoryService.name);
    private readonly platformVersion: string;
    private readonly environment: 'development' | 'production' | 'test';
    private readonly features: ReadonlySet<string>;

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
     * Create a PluginContext for a plugin
     */
    createContext(
        pluginId: string,
        scopeOptions?: {
            userId?: string;
            directoryId?: string;
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
                return this.settingsService.getSettings(pluginId, options);
            },

            getResolvedSettings: async (
                scope?: SettingScope,
                scopeId?: string,
            ): Promise<ResolvedSettings> => {
                const options = this.buildSettingsOptions(scope, scopeId, scopeOptions);
                return this.settingsService.getResolvedSettings(pluginId, options);
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
     * Create a scoped context for a specific user and/or directory
     */
    createScopedContext(pluginId: string, userId?: string, directoryId?: string): PluginContext {
        return this.createContext(pluginId, { userId, directoryId });
    }

    /**
     * Create a PluginLogger for a plugin
     */
    private createLogger(pluginId: string): PluginLogger {
        const logger = new Logger(`Plugin:${pluginId}`);

        return {
            log: (message: string, ...args: unknown[]) => {
                logger.log(message, ...args);
            },
            error: (message: string, trace?: string, ...args: unknown[]) => {
                logger.error(message, trace, ...args);
            },
            warn: (message: string, ...args: unknown[]) => {
                logger.warn(message, ...args);
            },
            debug: (message: string, ...args: unknown[]) => {
                logger.debug(message, ...args);
            },
            verbose: (message: string, ...args: unknown[]) => {
                logger.verbose(message, ...args);
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
     * Create PluginServices for a plugin
     */
    private createServices(scopeOptions?: {
        userId?: string;
        directoryId?: string;
    }): PluginServices {
        // Basic service stubs - these can be enhanced with actual implementations
        return {
            directory: undefined, // Can be populated by the module if needed
            user: undefined, // Can be populated by the module if needed
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
        defaultScope?: { userId?: string; directoryId?: string },
    ): { scope?: SettingScope; userId?: string; directoryId?: string } {
        const options: { scope?: SettingScope; userId?: string; directoryId?: string } = {
            scope,
        };

        if (scope === 'user' && scopeId) {
            options.userId = scopeId;
        } else if (scope === 'directory' && scopeId) {
            options.directoryId = scopeId;
        }

        // Apply defaults from context scope
        if (defaultScope?.userId && !options.userId) {
            options.userId = defaultScope.userId;
        }
        if (defaultScope?.directoryId && !options.directoryId) {
            options.directoryId = defaultScope.directoryId;
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
