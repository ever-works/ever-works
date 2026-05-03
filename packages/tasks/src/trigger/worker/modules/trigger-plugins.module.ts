import { Module, Global, DynamicModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import {
    PLUGINS_MODULE_OPTIONS,
    DEFAULT_PLATFORM_VERSION,
    PluginRepository,
    UserPluginRepository,
    WorkPluginRepository,
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

import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';
import { LocalPluginStore } from '../services/local-plugin-store';
import { TriggerPluginHydratorService } from '../services/trigger-plugin-hydrator.service';

/**
 * Global plugin module for Trigger.dev context.
 * Repositories use remote proxies; PluginRepository has local writes for bootstrap.
 */
@Global()
@Module({})
export class TriggerPluginsModule {
    static forRoot(options: PluginsModuleOptions = {}): DynamicModule {
        const nodeEnv = process.env.NODE_ENV || 'development';
        return {
            module: TriggerPluginsModule,
            imports: [EventEmitterModule.forRoot(), TriggerInternalModule],
            providers: [
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        platformVersion: DEFAULT_PLATFORM_VERSION,
                        pluginPaths: nodeEnv === 'development' ? ['../plugins'] : ['./plugins'], // ['./plugins'] Copied by prepare:plugins script before deployment
                        autoLoadBuiltIn: true,
                        autoEnableOnLoad: false,
                        environment: nodeEnv,
                        encryptSecrets: false,
                        maxConcurrentLoads: 5,
                        loadTimeout: 30000,
                        ...options,
                    },
                },
                {
                    provide: PluginRepository,
                    useFactory: (apiClient: TriggerInternalApiClient) => {
                        const store = new LocalPluginStore();
                        return createRemoteProxy(apiClient, 'PluginRepository', store);
                    },
                    inject: [TriggerInternalApiClient],
                },
                {
                    provide: UserPluginRepository,
                    useFactory: (apiClient: TriggerInternalApiClient) =>
                        createRemoteProxy(apiClient, 'UserPluginRepository'),
                    inject: [TriggerInternalApiClient],
                },
                {
                    provide: WorkPluginRepository,
                    useFactory: (apiClient: TriggerInternalApiClient) =>
                        createRemoteProxy(apiClient, 'WorkPluginRepository'),
                    inject: [TriggerInternalApiClient],
                },
                PluginManifestValidatorService,
                PluginVersionCheckerService,
                PluginClassValidatorService,
                PluginRegistryService,
                PluginLoaderService,
                PluginLifecycleManagerService,
                PluginSettingsService,
                PluginContextFactoryService,
                CustomCapabilityRegistryService,
                PluginBootstrapService,
                TriggerPluginHydratorService,
            ],
            exports: [
                PluginRepository,
                UserPluginRepository,
                WorkPluginRepository,
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
