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
    PluginSecretEncService,
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
    /**
     * The one option-less `forRoot()` module, handed to every importer.
     *
     * Nest 11 keys a dynamic module **by reference** (`ByReferenceModuleOpaqueKeyFactory`, the
     * default `moduleIdGeneratorAlgorithm`), so two `forRoot()` calls that return two objects are
     * two module instances — two `PluginRegistryService`s in one context. A worker context that
     * imports two modules which each import `forRoot()` (`app-dependency-provision`:
     * `TriggerWorkerModule` + `TriggerAppRuntimeModule`) then bootstrapped one registry and read
     * the other: the runtime facade found the `apps-tier` plugin and prepared the namespace, and
     * `AppDependencyFacadeService.resolve('k8s-apps-tier', …)` answered `null` from the empty
     * twin — `providerNotSupported` on prod (worker 20261018.5, runs
     * `run_cmvdsnwul27sl2x2viw5z0cu0` / `run_cmvdsnx6o1jos2z1rfg425oup`).
     *
     * Returning the same object makes every option-less import ONE module, so a context has one
     * registry however many of its modules import this one. A call WITH options (the
     * run-plugin-operation module's) is its own module, as before.
     */
    private static defaultModule: DynamicModule | null = null;

    static forRoot(options?: PluginsModuleOptions): DynamicModule {
        if (options === undefined || Object.keys(options).length === 0) {
            TriggerPluginsModule.defaultModule ??= TriggerPluginsModule.build({});
            return TriggerPluginsModule.defaultModule;
        }
        return TriggerPluginsModule.build(options);
    }

    private static build(options: PluginsModuleOptions): DynamicModule {
        // Read once, when the module object is built — as before: every importer evaluates
        // `forRoot()` in its `@Module` decorator, i.e. at import time, so the shared object reads
        // the environment at the same moment the per-importer objects did.
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
                // C-08: plugin secrets (API keys & co.) are stored AES-GCM-encrypted
                // (`enc::v1::…`). PluginSettingsService takes this service as an OPTIONAL
                // dependency and passes envelopes through untouched when it is missing —
                // which is exactly what happened here: the worker sent
                // `Authorization: Bearer enc::v1::…` to OpenRouter ("Missing Authentication
                // header") and every generation failed. Must be registered BEFORE
                // PluginSettingsService; needs PLUGIN_SECRET_ENCRYPTION_KEY in the worker env
                // (same key as the API).
                PluginSecretEncService,
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
                PluginSecretEncService,
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
