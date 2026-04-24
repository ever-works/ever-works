const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 10_000;
const QUANT_PATTERN = /[-_](?:q\d[_a-z0-9]*|fp16|fp32|bf16|f16|f32|gguf|iq\d[_a-z0-9]*)$/i;
const PARAM_SIZE_PATTERN = /^(\d+\.?\d*[bm](?:-a\d+[bm])?)/i;

export interface ModelCatalogEntry {
    id: string;
    modelId: string;
    name?: string;
    providerId?: string;
    providerName?: string;
    maxContextLength?: number;
    maxOutputTokens?: number;
    inputCostPer1k?: number;
    outputCostPer1k?: number;
    source: 'openrouter' | 'models.dev';
}

interface OpenRouterModelsResponse {
    data?: Array<Record<string, unknown>>;
}

function normalizeModelId(modelId: string): string {
    return modelId.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
    const parsed =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim()
              ? Number(value)
              : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function perTokenToPer1k(value: unknown): number | undefined {
    const parsed = asPositiveNumber(value);
    return parsed !== undefined ? parsed * 1000 : undefined;
}

function perMillionToPer1k(value: unknown): number | undefined {
    const parsed = asPositiveNumber(value);
    return parsed !== undefined ? parsed / 1000 : undefined;
}

function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    return fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
    }).finally(() => {
        clearTimeout(timer);
    });
}

function buildOpenRouterEntry(raw: Record<string, unknown>): ModelCatalogEntry | null {
    const id = asNonEmptyString(raw.id);
    if (!id) return null;

    const pricing = asRecord(raw.pricing);
    const maxContextLength = asPositiveNumber(raw.context_length);
    const maxOutputTokens = asPositiveNumber(raw.max_output_tokens);
    const slashIndex = id.indexOf('/');
    const providerId = slashIndex > 0 ? normalizeModelId(id.slice(0, slashIndex)) : undefined;
    const modelId = slashIndex > 0 ? id.slice(slashIndex + 1) : id;

    return {
        id,
        modelId,
        name: asNonEmptyString(raw.name),
        providerId,
        maxContextLength,
        maxOutputTokens,
        inputCostPer1k: perTokenToPer1k(pricing?.prompt),
        outputCostPer1k: perTokenToPer1k(pricing?.completion),
        source: 'openrouter',
    };
}

function buildModelsDevEntries(body: unknown): ModelCatalogEntry[] {
    const providers = asRecord(body);
    if (!providers) return [];

    const entries: ModelCatalogEntry[] = [];

    for (const [providerKey, providerValue] of Object.entries(providers)) {
        const provider = asRecord(providerValue);
        if (!provider) continue;

        const providerId = normalizeModelId(asNonEmptyString(provider.id) ?? providerKey);
        const providerName = asNonEmptyString(provider.name);
        const models = asRecord(provider.models);
        if (!models) continue;

        for (const [modelKey, modelValue] of Object.entries(models)) {
            const model = asRecord(modelValue);
            if (!model) continue;

            const rawModelId = asNonEmptyString(model.id) ?? modelKey;
            const limit = asRecord(model.limit);
            const cost = asRecord(model.cost);

            entries.push({
                id: `${providerId}/${rawModelId}`,
                modelId: rawModelId,
                name: asNonEmptyString(model.name) ?? rawModelId,
                providerId,
                providerName,
                maxContextLength: asPositiveNumber(limit?.context),
                maxOutputTokens: asPositiveNumber(limit?.output),
                inputCostPer1k: perMillionToPer1k(cost?.input),
                outputCostPer1k: perMillionToPer1k(cost?.output),
                source: 'models.dev',
            });
        }
    }

    return entries;
}

function metadataScore(candidate: ModelCatalogEntry): number {
    let score = 0;
    if (candidate.maxContextLength) score += 4;
    if (candidate.maxOutputTokens) score += 2;
    if (candidate.inputCostPer1k !== undefined) score += 2;
    if (candidate.outputCostPer1k !== undefined) score += 2;
    if (candidate.name) score += 1;
    return score;
}

function pickRichest(candidates: readonly ModelCatalogEntry[]): ModelCatalogEntry | null {
    if (candidates.length === 0) return null;

    let best = candidates[0];
    let bestScore = metadataScore(best);

    for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        const score = metadataScore(candidate);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    return best;
}

function buildCandidates(modelId: string): string[] {
    const baseName = extractBaseName(modelId);

    if (!baseName.includes(':')) {
        return [baseName];
    }

    const [base, tag] = baseName.split(':', 2);
    if (!tag || tag === 'latest') {
        return [base];
    }

    const cleanTag = tag.replace(QUANT_PATTERN, '').replace(/-$/, '');
    const paramMatch = cleanTag.match(PARAM_SIZE_PATTERN);
    const candidates: string[] = [];

    if (paramMatch) {
        const paramSize = paramMatch[1];
        const rest = cleanTag.slice(paramSize.length).replace(/^-/, '');

        if (rest) {
            candidates.push(`${base}-${paramSize}-${rest}`);
        }

        candidates.push(`${base}-${paramSize}`);
    } else if (cleanTag) {
        candidates.push(`${base}-${cleanTag}`);
    }

    candidates.push(base);

    return [...new Set(candidates)];
}

function isMatch(registryBaseName: string, candidate: string): boolean {
    if (registryBaseName === candidate) {
        return true;
    }

    if (registryBaseName.startsWith(candidate)) {
        const nextChar = registryBaseName[candidate.length];
        return nextChar === '-' || nextChar === '.' || nextChar === ':' || nextChar === undefined;
    }

    return false;
}

/**
 * Last segment after `/`, or the full string if no `/`.
 */
export function extractBaseName(id: string): string {
    const slashIdx = id.lastIndexOf('/');
    const baseName = slashIdx === -1 ? id : id.slice(slashIdx + 1);
    return normalizeModelId(baseName);
}

/**
 * Fetch model metadata from OpenRouter. Returns `null` on any failure.
 */
export async function fetchOpenRouterModelCatalog(): Promise<ModelCatalogEntry[] | null> {
    try {
        const response = await fetchWithTimeout(OPENROUTER_MODELS_URL);
        if (!response.ok) return null;

        const body = (await response.json()) as OpenRouterModelsResponse;
        const data = Array.isArray(body?.data) ? body.data : null;
        if (!data) return null;

        const entries = data
            .map(buildOpenRouterEntry)
            .filter((entry): entry is ModelCatalogEntry => entry !== null);
        return entries.length > 0 ? entries : null;
    } catch {
        return null;
    }
}

/**
 * Fetch model metadata from models.dev. Returns `null` on any failure.
 */
export async function fetchModelsDevCatalog(): Promise<ModelCatalogEntry[] | null> {
    try {
        const response = await fetchWithTimeout(MODELS_DEV_URL);
        if (!response.ok) return null;

        const body = await response.json();
        const entries = buildModelsDevEntries(body);
        return entries.length > 0 ? entries : null;
    } catch {
        return null;
    }
}

/**
 * Fetch generic model metadata, preferring OpenRouter and falling back to models.dev.
 */
export async function fetchModelCatalog(): Promise<ModelCatalogEntry[] | null> {
    const openRouterModels = await fetchOpenRouterModelCatalog();
    if (openRouterModels) {
        return openRouterModels;
    }

    return fetchModelsDevCatalog();
}

/**
 * Match a model ID against the generic catalog (exact full ID first, then normalized base-name candidates).
 */
export function matchModelCatalogEntry(
    modelId: string,
    candidates: readonly ModelCatalogEntry[],
    providerHint?: string,
): ModelCatalogEntry | null {
    if (!modelId || candidates.length === 0) return null;

    const normalizedModelId = normalizeModelId(modelId);
    const normalizedProviderHint = providerHint ? normalizeModelId(providerHint) : undefined;
    const baseCandidates = buildCandidates(normalizedModelId);

    const exactMatches = candidates.filter(
        (candidate) => normalizeModelId(candidate.id) === normalizedModelId,
    );
    const exactMatch = pickRichest(exactMatches);
    if (exactMatch) {
        return exactMatch;
    }

    for (const baseCandidate of baseCandidates) {
        if (normalizedProviderHint) {
            const providerBaseMatches = candidates.filter((candidate) => {
                return (
                    candidate.providerId &&
                    normalizeModelId(candidate.providerId) === normalizedProviderHint &&
                    extractBaseName(candidate.modelId) === baseCandidate
                );
            });
            const providerBaseMatch = pickRichest(providerBaseMatches);
            if (providerBaseMatch) {
                return providerBaseMatch;
            }
        }

        const baseMatches = candidates.filter(
            (candidate) => extractBaseName(candidate.modelId) === baseCandidate,
        );
        const baseMatch = pickRichest(baseMatches);
        if (baseMatch) {
            return baseMatch;
        }

        if (normalizedProviderHint) {
            const providerLooseMatches = candidates.filter((candidate) => {
                return (
                    candidate.providerId &&
                    normalizeModelId(candidate.providerId) === normalizedProviderHint &&
                    isMatch(extractBaseName(candidate.modelId), baseCandidate)
                );
            });
            const providerLooseMatch = pickRichest(providerLooseMatches);
            if (providerLooseMatch) {
                return providerLooseMatch;
            }
        }

        const looseMatches = candidates.filter((candidate) =>
            isMatch(extractBaseName(candidate.modelId), baseCandidate),
        );
        const looseMatch = pickRichest(looseMatches);
        if (looseMatch) {
            return looseMatch;
        }
    }

    return null;
}
