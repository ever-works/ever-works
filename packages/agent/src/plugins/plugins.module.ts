import {
    Module,
    Global,
    DynamicModule,
    Provider,
    OnModuleInit,
    OnModuleDestroy,
    Logger,
    Inject,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { CacheModule, CACHE_MANAGER } from '@nestjs/cache-manager';

// Entities
import { PluginEntity } from './entities/plugin.entity';
import { UserPluginEntity } from './entities/user-plugin.entity';
import { DirectoryPluginEntity } from './entities/directory-plugin.entity';

// Repositories
import { PluginRepository } from './repositories/plugin.repository';
import { UserPluginRepository } from './repositories/user-plugin.repository';
import { DirectoryPluginRepository } from './repositories/directory-plugin.repository';

// Services
import { PluginRegistryService } from './services/plugin-registry.service';
import { PluginLoaderService } from './services/plugin-loader.service';
import { PluginManifestValidatorService } from './services/plugin-manifest-validator.service';
import { PluginVersionCheckerService } from './services/plugin-version-checker.service';
import { PluginClassValidatorService } from './services/plugin-class-validator.service';
import { PluginLifecycleManagerService } from './services/plugin-lifecycle-manager.service';
import { PluginSettingsService } from './services/plugin-settings.service';
import { PluginContextFactoryService } from './services/plugin-context-factory.service';
import { CustomCapabilityRegistryService } from './services/custom-capability-registry.service';

// Constants and interfaces
import { PLUGINS_MODULE_OPTIONS, DEFAULT_PLATFORM_VERSION } from './plugins.constants';
import type {
    PluginsModuleOptions,
    PluginsModuleAsyncOptions,
    PluginsModuleOptionsFactory,
} from './interfaces/plugins-module-options.interface';

/**
 * Plugin entities for TypeORM registration
 */
export const PLUGIN_ENTITIES = [PluginEntity, UserPluginEntity, DirectoryPluginEntity];

/**
 * All plugin-related providers
 */
const PROVIDERS = [
    // Repositories
    PluginRepository,
    UserPluginRepository,
    DirectoryPluginRepository,
    // Validation services
    PluginManifestValidatorService,
    PluginVersionCheckerService,
    PluginClassValidatorService,
    // Core services
    PluginRegistryService,
    PluginLoaderService,
    // Lifecycle and settings
    PluginLifecycleManagerService,
    PluginSettingsService,
    // Context and capabilities
    PluginContextFactoryService,
    CustomCapabilityRegistryService,
];

/**
 * Exported services for consumers
 */
const EXPORTS = [
    // Repositories
    PluginRepository,
    UserPluginRepository,
    DirectoryPluginRepository,
    // Core services
    PluginRegistryService,
    PluginLoaderService,
    PluginLifecycleManagerService,
    PluginSettingsService,
    PluginContextFactoryService,
    CustomCapabilityRegistryService,
    // Validation services
    PluginManifestValidatorService,
    PluginVersionCheckerService,
    PluginClassValidatorService,
];

/**
 * Global module for the plugin system.
 * Provides plugin discovery, loading, lifecycle management, and settings resolution.
 */
@Global()
@Module({})
export class PluginsModule implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PluginsModule.name);

    constructor(
        private readonly pluginLoader: PluginLoaderService,
        private readonly lifecycleManager: PluginLifecycleManagerService,
        private readonly contextFactory: PluginContextFactoryService,
        @Inject(PLUGINS_MODULE_OPTIONS)
        private readonly options: PluginsModuleOptions,
    ) {}

    /**
     * Configure the module with static options
     */
    static forRoot(options: PluginsModuleOptions = {}): DynamicModule {
        return {
            module: PluginsModule,
            imports: [
                TypeOrmModule.forFeature(PLUGIN_ENTITIES),
                EventEmitterModule.forRoot(),
                CacheModule.register(),
            ],
            providers: [
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: 'development',
                        encryptSecrets: true,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...options,
                    },
                },
                ...PROVIDERS,
            ],
            exports: [...EXPORTS, PLUGINS_MODULE_OPTIONS],
        };
    }

    /**
     * Configure the module with async options
     */
    static forRootAsync(options: PluginsModuleAsyncOptions): DynamicModule {
        const asyncProviders = this.createAsyncProviders(options);

        return {
            module: PluginsModule,
            imports: [
                ...(options.imports || []),
                TypeOrmModule.forFeature(PLUGIN_ENTITIES),
                EventEmitterModule.forRoot(),
                CacheModule.register(),
            ],
            providers: [...asyncProviders, ...PROVIDERS],
            exports: [...EXPORTS, PLUGINS_MODULE_OPTIONS],
        };
    }

    /**
     * Create async providers for module options
     */
    private static createAsyncProviders(options: PluginsModuleAsyncOptions): Provider[] {
        if (options.useExisting || options.useFactory) {
            return [this.createAsyncOptionsProvider(options)];
        }

        if (options.useClass) {
            return [
                this.createAsyncOptionsProvider(options),
                {
                    provide: options.useClass,
                    useClass: options.useClass,
                },
            ];
        }

        return [];
    }

    /**
     * Create the async options provider
     */
    private static createAsyncOptionsProvider(options: PluginsModuleAsyncOptions): Provider {
        if (options.useFactory) {
            return {
                provide: PLUGINS_MODULE_OPTIONS,
                useFactory: async (...args: unknown[]) => {
                    const result = await options.useFactory!(...args);
                    return {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: 'development',
                        encryptSecrets: true,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...result,
                    };
                },
                inject: (options.inject || []) as any[],
            };
        }

        if (options.useExisting) {
            return {
                provide: PLUGINS_MODULE_OPTIONS,
                useFactory: async (optionsFactory: PluginsModuleOptionsFactory) => {
                    const result = await optionsFactory.createPluginsModuleOptions();
                    return {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: 'development',
                        encryptSecrets: true,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...result,
                    };
                },
                inject: [options.useExisting],
            };
        }

        if (options.useClass) {
            return {
                provide: PLUGINS_MODULE_OPTIONS,
                useFactory: async (optionsFactory: PluginsModuleOptionsFactory) => {
                    const result = await optionsFactory.createPluginsModuleOptions();
                    return {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: 'development',
                        encryptSecrets: true,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...result,
                    };
                },
                inject: [options.useClass],
            };
        }

        throw new Error('Invalid async options configuration');
    }

    /**
     * Called when the module is initialized
     */
    async onModuleInit(): Promise<void> {
        this.logger.log('Initializing plugin system...');

        // Connect the context factory to the lifecycle manager
        this.lifecycleManager.setContextFactory(this.contextFactory);

        // Discover and load plugins
        const result = await this.pluginLoader.discoverAndLoadAll();
        this.logger.log(
            `Plugin discovery complete: ${result.loaded} loaded, ${result.failed} failed`,
        );

        // Call onLoad for all loaded plugins
        for (const loadResult of result.results) {
            if (loadResult.success && loadResult.pluginId) {
                await this.lifecycleManager.callOnLoad(loadResult.pluginId);
            }
        }

        // Auto-enable if configured
        if (this.options.autoEnableOnLoad) {
            const enableResults = await this.lifecycleManager.enableAll();
            const enabled = enableResults.filter((r) => r.success).length;
            this.logger.log(`Auto-enabled ${enabled} plugins`);
        }

        this.logger.log('Plugin system initialized');
    }

    /**
     * Called when the module is being destroyed
     */
    async onModuleDestroy(): Promise<void> {
        this.logger.log('Shutting down plugin system...');
        await this.lifecycleManager.shutdownAll();
        this.logger.log('Plugin system shutdown complete');
    }
}
