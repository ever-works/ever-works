import superjson from 'superjson';
import { TriggerInternalApiClient } from './services/trigger-internal-api.client';

/**
 * Maximum depth `stripAbortSignals` walks. Call arguments here are shallow
 * option bags; a bound keeps a cyclic or pathological payload from stalling
 * the worker before the request is even sent.
 */
const MAX_STRIP_DEPTH = 4;

/**
 * True for a "plain" container we may safely rebuild — an object literal or an
 * array. Everything else (Date, Map, Set, class instances) is returned by
 * reference so SuperJSON still sees the exact value it knows how to encode.
 * Rebuilding those would silently downgrade rich types to bare objects.
 */
function isPlainContainer(value: unknown): boolean {
    if (Array.isArray(value)) return true;
    if (typeof value !== 'object' || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Remove `AbortSignal` values from an argument tree, returning a copy.
 *
 * An `AbortSignal` cannot survive this hop: SuperJSON has no transformer for
 * it, so it encodes to `{}` and the API deserializes a plain object whose
 * `.aborted` is `undefined`. That is worse than useless. It silently disables
 * the signal half of `createAgentRunAbortSource`, and the same `{}` is then
 * threaded onward as a request signal into the AI provider chain, where a
 * truthy non-signal is a latent `signal.addEventListener is not a function`.
 *
 * Dropping it restores the honest shape — the callee sees `undefined`, every
 * `signal?.aborted` guard short-circuits, and cancellation runs through the
 * path that actually works across this boundary: the `readStatus` poll of
 * `agent_runs.status` that `createAgentRunAbortSource` already wires up.
 *
 * Worker-side only, so it carries no producer/consumer version-skew risk.
 */
function stripAbortSignals(value: unknown, depth = 0): unknown {
    if (value instanceof AbortSignal) return undefined;
    if (depth >= MAX_STRIP_DEPTH || !isPlainContainer(value)) return value;

    if (Array.isArray(value)) {
        return value.map((entry) => stripAbortSignals(entry, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry instanceof AbortSignal) continue;
        out[key] = stripAbortSignals(entry, depth + 1);
    }
    return out;
}

/**
 * Creates a Proxy that forwards method calls to the API via the internal client.
 * Methods in `localMethods` run locally instead of being forwarded.
 *
 * Uses SuperJSON for serialization so Date, Map, Set, etc. survive the round-trip.
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

            // Forward to API with SuperJSON-serialized args
            return (...args: unknown[]) => {
                const serialized = superjson.serialize(stripAbortSignals(args));
                return apiClient.callRemote(providerName, prop, serialized);
            };
        },
    });
}
