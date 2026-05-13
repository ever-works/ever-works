import type { Logger } from '@nestjs/common';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';

/**
 * Returns the user's enabled plugins for a capability, ordered with
 * `defaultForCapabilities`-first (same convention as BaseFacadeService).
 */
export async function resolveProviderChain(
    registry: PluginRegistryService,
    capability: string,
    userId: string,
): Promise<RegisteredPlugin[]> {
    const plugins = await registry.getEnabledPluginsScoped(capability, undefined, userId);
    return plugins.sort((a, b) => {
        const ad = a.manifest.defaultForCapabilities?.includes(capability) ? 0 : 1;
        const bd = b.manifest.defaultForCapabilities?.includes(capability) ? 0 : 1;
        return ad - bd;
    });
}

/** Cap how many providers we try per call so a flapping vendor can't burn through every key. */
export function capChain<T>(chain: T[], max: number): T[] {
    if (max <= 0) return chain;
    return chain.slice(0, Math.max(1, max));
}

export async function tryInOrder<T>(
    chain: RegisteredPlugin[],
    attempt: (plugin: RegisteredPlugin) => Promise<T>,
    isRetryable: (err: unknown) => boolean,
    logger?: Logger,
): Promise<T> {
    if (chain.length === 0) {
        throw new Error('No providers available');
    }
    let lastErr: unknown;
    for (const p of chain) {
        try {
            return await attempt(p);
        } catch (err) {
            if (!isRetryable(err)) throw err;
            logger?.warn(
                `provider ${p.plugin.id} failed (retryable): ${(err as Error)?.message ?? err}`,
            );
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('all providers failed');
}

/**
 * Heuristic classifier for "the next provider might succeed" — covers the
 * usual rate-limit / quota / 5xx / network shapes across LLM + search APIs.
 * Auth/config errors are NOT retryable (don't burn the next provider on a
 * bad key).
 */
export function isTransientProviderError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    if (
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('invalid api key') ||
        msg.includes('invalid_api_key')
    ) {
        return false;
    }
    return (
        msg.includes('rate limit') ||
        msg.includes('rate_limit') ||
        msg.includes('rate-limit') ||
        msg.includes('429') ||
        msg.includes('quota') ||
        msg.includes('timeout') ||
        msg.includes('etimedout') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up') ||
        msg.includes('overloaded') ||
        msg.includes('service unavailable') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504')
    );
}
