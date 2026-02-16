const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;

export interface OpenRouterModelEntry {
    id: string;
    context_length?: number;
    name?: string;
}

interface OpenRouterModelsResponse {
    data: OpenRouterModelEntry[];
}

/** Fetch model list from OpenRouter. Returns `null` on any failure. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModelEntry[] | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(OPENROUTER_MODELS_URL, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });

        clearTimeout(timer);

        if (!response.ok) return null;

        const body = (await response.json()) as OpenRouterModelsResponse;
        return Array.isArray(body?.data) ? body.data : null;
    } catch {
        return null;
    }
}

/** Last segment after `/`, or the full string if no `/`. */
export function extractBaseName(id: string): string {
    const slashIdx = id.lastIndexOf('/');
    return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

/** Match a model ID against OpenRouter entries (exact ID first, then base-name). */
export function fuzzyMatchModel(
    modelId: string,
    candidates: readonly OpenRouterModelEntry[],
): OpenRouterModelEntry | null {
    if (!modelId || candidates.length === 0) return null;

    const lowerInput = modelId.toLowerCase();

    // Priority 1: exact match on full ID (case-insensitive)
    for (const candidate of candidates) {
        if (candidate.id.toLowerCase() === lowerInput) {
            return candidate;
        }
    }

    // Priority 2: base-name match
    const inputBase = extractBaseName(lowerInput);
    for (const candidate of candidates) {
        if (extractBaseName(candidate.id.toLowerCase()) === inputBase) {
            return candidate;
        }
    }

    return null;
}
