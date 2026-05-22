import { Logger } from '@nestjs/common';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import type { AiFacadeService } from '../facades/ai.facade';

const DEFAULT_PROVIDER_FALLBACK_MAX = 2;

function getProviderFallbackMax(): number {
    const raw = process.env.USER_RESEARCH_PROVIDER_FALLBACK_MAX;
    if (!raw) return DEFAULT_PROVIDER_FALLBACK_MAX;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PROVIDER_FALLBACK_MAX;
}

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

/**
 * Returns ordered plugin IDs of the user's enabled search providers, capped
 * by USER_RESEARCH_PROVIDER_FALLBACK_MAX. Convenience over
 * resolveProviderChain + capChain + .map(p.plugin.id) at the call site.
 */
export async function resolveSearchProviderIds(
    registry: PluginRegistryService,
    userId: string,
): Promise<string[]> {
    const chain = capChain(
        await resolveProviderChain(registry, PLUGIN_CAPABILITIES.SEARCH, userId),
        getProviderFallbackMax(),
    );
    return chain.map((p) => p.plugin.id);
}

/**
 * Auth / invalid-key shapes. Treated separately from transient errors so a
 * bad key surfaces loudly instead of being masked by silently trying the
 * next provider.
 */
export function isAuthOrConfigError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('invalid api key') ||
        msg.includes('invalid_api_key')
    );
}

/**
 * Heuristic classifier for "the next provider might succeed" — covers the
 * usual rate-limit / quota / 5xx / network shapes across LLM + search APIs.
 * Auth/config errors are NOT retryable (don't burn the next provider on a
 * bad key).
 */
export function isTransientProviderError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (isAuthOrConfigError(err)) return false;
    const msg = err.message.toLowerCase();
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
        msg.includes('internal server error') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504')
    );
}

export interface ResolvedAiProvider {
    model: LanguageModel;
    providerId: string;
    providerName: string;
    modelName: string;
}

async function resolveAiProviderFromChain(
    aiFacade: AiFacadeService,
    chain: RegisteredPlugin[],
    userId: string | undefined,
    logger?: Logger,
): Promise<ResolvedAiProvider | null> {
    for (const candidate of chain) {
        try {
            const cfg = await aiFacade.getProviderConfig({
                userId,
                providerOverride: candidate.plugin.id,
            });
            if (!cfg.baseUrl || !cfg.apiKey) continue;
            const modelName =
                cfg.routing.complexModel ?? cfg.routing.mediumModel ?? cfg.defaultModel;
            if (!modelName) continue;

            const provider = createOpenAICompatible({
                name: cfg.providerId,
                baseURL: cfg.baseUrl,
                apiKey: cfg.apiKey,
            });
            return {
                model: provider(modelName),
                providerId: cfg.providerId,
                providerName: cfg.providerName ?? cfg.providerId,
                modelName,
            };
        } catch (err) {
            if (isAuthOrConfigError(err)) throw err;
            logger?.warn(`ai-provider ${candidate.plugin.id} unusable: ${(err as Error).message}`);
        }
    }
    return null;
}

/**
 * Walks the user's enabled ai-provider plugins in priority order and returns
 * the first one with a usable config (baseUrl + apiKey + model). Capped by
 * USER_RESEARCH_PROVIDER_FALLBACK_MAX so one bad provider chain can't burn
 * through every configured key. System plugins are included through the same
 * scoped enablement rules as user-installed plugins. Auth-shape errors re-throw
 * so misconfigured keys aren't silently masked by trying the next provider.
 */
export async function resolveAiProviderForResearch(
    aiFacade: AiFacadeService,
    registry: PluginRegistryService,
    userId: string,
    logger?: Logger,
): Promise<ResolvedAiProvider | null> {
    const chain = capChain(
        await resolveProviderChain(registry, PLUGIN_CAPABILITIES.AI_PROVIDER, userId),
        getProviderFallbackMax(),
    );
    return resolveAiProviderFromChain(aiFacade, chain, userId, logger);
}
