import { Global, Module, DynamicModule } from '@nestjs/common';
import { CACHE_MANAGER } from '@ever-works/agent/cache';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

/**
 * Global module that provides CACHE_MANAGER via remote proxy to the API.
 * Replaces TriggerCacheFactory + InternalAPIAdapter with the generic remote-call mechanism.
 */
@Global()
@Module({})
export class TriggerRemoteCacheModule {
    static forRoot(): DynamicModule {
        return {
            module: TriggerRemoteCacheModule,
            global: true,
            imports: [TriggerInternalModule],
            providers: [
                {
                    provide: CACHE_MANAGER,
                    useFactory: (apiClient: TriggerInternalApiClient) =>
                        createRemoteProxy(apiClient, 'CacheManager'),
                    inject: [TriggerInternalApiClient],
                },
            ],
            exports: [CACHE_MANAGER],
        };
    }
}
