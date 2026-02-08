import { TriggerInternalApiClient } from '../trigger-internal-api.client';

/**
 * Creates a Proxy that forwards method calls to the API via the internal client.
 * Methods in `localMethods` run locally instead of being forwarded.
 */
export function createRemoteProxy(
    apiClient: TriggerInternalApiClient,
    providerName: string,
    localMethods?: object,
): any {
    const target = localMethods ?? {};

    // Return undefined for thenable checks and NestJS lifecycle hooks
    const PASSTHROUGH = new Set([
        'then',
        'catch',
        'finally',
        'constructor',
        'prototype',
        'onModuleInit',
        'onModuleDestroy',
        'onApplicationBootstrap',
        'onApplicationShutdown',
        'beforeApplicationShutdown',
    ]);

    return new Proxy(target, {
        get(obj: any, prop: string | symbol) {
            if (typeof prop === 'symbol') return undefined;

            if (PASSTHROUGH.has(prop)) return undefined;

            if (prop in obj) return obj[prop];

            // Forward to API
            return (...args: unknown[]) => apiClient.callRemote(providerName, prop, args);
        },
    });
}
