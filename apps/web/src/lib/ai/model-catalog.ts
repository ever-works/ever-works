import { fetchModels } from '@/app/actions/plugins';

/**
 * Shared client-side loader for a provider plugin's model catalogue.
 *
 * Extracted from `PluginModelSelect` so the chat composer's model picker and
 * the plugin-settings model field read the SAME cache. Both surfaces ask for
 * the same provider within a session — a user picks `openrouter` in Settings
 * and then opens the composer picker — and a per-component cache would fetch
 * the (large) catalogue twice.
 */
export interface AiModel {
    id: string;
    name: string;
    description?: string;
    capabilities: {
        maxContextLength: number;
        maxOutputTokens?: number;
    };
    inputCostPer1k?: number;
    outputCostPer1k?: number;
}

export type ModelLoadResult = {
    models: AiModel[];
    error: string | null;
};

const modelCache = new Map<string, AiModel[]>();
const inFlightModelRequests = new Map<string, Promise<ModelLoadResult>>();

/** Already-resolved catalogue for a plugin, or `null` if it has not loaded yet. */
export function cachedModels(pluginId: string): AiModel[] | null {
    return pluginId ? (modelCache.get(pluginId) ?? null) : null;
}

/**
 * Fetch a plugin's models, deduplicating concurrent callers.
 *
 * Two pickers mounted at once (composer + settings) would otherwise each fire
 * their own request on the same frame, so in-flight promises are shared by
 * plugin id and only the resolved list is cached.
 */
export async function loadPluginModels(
    pluginId: string,
    loadErrorMessage: string,
): Promise<ModelLoadResult> {
    const cached = modelCache.get(pluginId);
    if (cached) {
        return { models: cached, error: null };
    }

    const existingRequest = inFlightModelRequests.get(pluginId);
    if (existingRequest) {
        return existingRequest;
    }

    const request = fetchModels(pluginId)
        .then((response) => {
            if (response.success && Array.isArray(response.data)) {
                const models = response.data as AiModel[];
                modelCache.set(pluginId, models);
                return { models, error: null };
            }

            return {
                models: [],
                error: response.error || loadErrorMessage,
            };
        })
        .catch(() => ({
            models: [],
            error: loadErrorMessage,
        }))
        .finally(() => {
            inFlightModelRequests.delete(pluginId);
        });

    inFlightModelRequests.set(pluginId, request);
    return request;
}

/** Compact context-window label, e.g. `128K` / `1M`. */
export function formatContextLength(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
    return String(tokens);
}
