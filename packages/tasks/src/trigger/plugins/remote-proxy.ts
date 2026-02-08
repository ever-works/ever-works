import { TriggerInternalApiClient } from '../trigger-internal-api.client';

/**
 * Creates a JavaScript Proxy that forwards method calls on any injectable
 * to the API via the Trigger internal API client.
 *
 * This enables Trigger.dev tasks to use services that depend on classes
 * unavailable in the Trigger process (e.g. TypeORM repositories, DB-backed
 * services) by transparently routing calls through the internal API.
 *
 * @param apiClient  The internal API client used to forward calls
 * @param providerName  The name used to look up the real instance on the API side
 * @param localMethods  Optional map of methods to run locally (for sync/pure-logic methods)
 */
export function createRemoteProxy(
    apiClient: TriggerInternalApiClient,
    providerName: string,
    localMethods?: Record<string, Function>,
): any {
    const target = localMethods ?? {};

    // Properties that must return undefined so the proxy behaves as a plain
    // object — not as a thenable (then), not as a NestJS lifecycle hook
    // (onModuleInit/onModuleDestroy), and not as something with a custom
    // constructor or prototype.
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
        get(obj: Record<string, Function>, prop: string | symbol) {
            if (typeof prop === 'symbol') return undefined;

            if (PASSTHROUGH.has(prop)) return undefined;

            // Use local implementation if provided (e.g. for sync methods)
            if (prop in obj) return obj[prop];

            // Otherwise return a dynamic async function that forwards to the API
            return (...args: unknown[]) =>
                apiClient.callRemote(providerName, prop, args);
        },
    });
}
