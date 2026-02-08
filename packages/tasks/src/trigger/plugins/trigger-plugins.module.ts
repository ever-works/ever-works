import { Module, Global, DynamicModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import * as path from 'path';

import {
    PLUGINS_MODULE_OPTIONS,
    DEFAULT_PLATFORM_VERSION,
    PluginRepository,
    UserPluginRepository,
    DirectoryPluginRepository,
    PluginRegistryService,
    PluginLoaderService,
    PluginManifestValidatorService,
    PluginVersionCheckerService,
    PluginClassValidatorService,
    PluginLifecycleManagerService,
    PluginSettingsService,
    PluginContextFactoryService,
    CustomCapabilityRegistryService,
    PluginBootstrapService,
} from '@ever-works/agent/plugins';
import type { PluginsModuleOptions } from '@ever-works/agent/plugins';

import { TriggerInternalModule } from '../trigger-internal.module';
import { RemotePluginRepository } from './remote-plugin.repository';
import { RemoteUserPluginRepository } from './remote-user-plugin.repository';
import { RemoteDirectoryPluginRepository } from './remote-directory-plugin.repository';
import { TriggerPluginHydratorService } from './trigger-plugin-hydrator.service';

/**
 * Global plugin module for Trigger.dev context.
 *
 * Provides the same injection tokens as PluginsModule.forRoot() but without TypeORM.
 * Remote repositories serve in-memory data fetched from the API at task start.
 */
@Global()
@Module({})
export class TriggerPluginsModule {
    static forRoot(options: PluginsModuleOptions = {}): DynamicModule {
        return {
            module: TriggerPluginsModule,
            imports: [EventEmitterModule.forRoot(), TriggerInternalModule],
            providers: [
                // Module options
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        pluginPaths: [
                            './plugins', // Production: copied by includePlugins() build extension
                            '../plugins', // Dev mode: resolves to packages/plugins/
                        ],
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: 'production',
                        encryptSecrets: false,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...options,
                    },
                },
                // Remote repositories
                RemotePluginRepository,
                {
                    provide: PluginRepository,
                    useExisting: RemotePluginRepository,
                },
                RemoteUserPluginRepository,
                {
                    provide: UserPluginRepository,
                    useExisting: RemoteUserPluginRepository,
                },
                RemoteDirectoryPluginRepository,
                {
                    provide: DirectoryPluginRepository,
                    useExisting: RemoteDirectoryPluginRepository,
                },
                // Validation services
                PluginManifestValidatorService,
                PluginVersionCheckerService,
                PluginClassValidatorService,
                // Core services (unchanged - they inject repositories via class tokens)
                PluginRegistryService,
                PluginLoaderService,
                PluginLifecycleManagerService,
                PluginSettingsService,
                // Context and capabilities
                PluginContextFactoryService,
                CustomCapabilityRegistryService,
                // Bootstrap
                PluginBootstrapService,
                // Hydrator
                TriggerPluginHydratorService,
            ],
            exports: [
                PluginRepository,
                UserPluginRepository,
                DirectoryPluginRepository,
                RemotePluginRepository,
                RemoteUserPluginRepository,
                RemoteDirectoryPluginRepository,
                PluginRegistryService,
                PluginLoaderService,
                PluginLifecycleManagerService,
                PluginSettingsService,
                PluginContextFactoryService,
                CustomCapabilityRegistryService,
                PluginManifestValidatorService,
                PluginVersionCheckerService,
                PluginClassValidatorService,
                PluginBootstrapService,
                TriggerPluginHydratorService,
                PLUGINS_MODULE_OPTIONS,
            ],
        };
    }
}
