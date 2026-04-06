const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;
const QUANT_PATTERN = /[-_](?:q\d[_a-z0-9]*|fp16|fp32|bf16|f16|f32|gguf|iq\d[_a-z0-9]*)$/i;
const PARAM_SIZE_PATTERN = /^(\d+\.?\d*[bm](?:-a\d+[bm])?)/i;

export interface OpenRouterModelEntry {
    id: string;
    context_length?: number;
    name?: string;
}

interface OpenRouterModelsResponse {
    data: OpenRouterModelEntry[];
}

function normalizeModelId(modelId: string): string {
    return modelId.trim().toLowerCase();
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

function hasContextLength(candidate: OpenRouterModelEntry): boolean {
    return typeof candidate.context_length === 'number' && candidate.context_length > 0;
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

/** Fetch model list from OpenRouter. Returns `null` on any failure. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModelEntry[] | null> {
    try {
        const response = await fetchWithTimeout(OPENROUTER_MODELS_URL);
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
    const baseName = slashIdx === -1 ? id : id.slice(slashIdx + 1);
    return normalizeModelId(baseName);
}

/** Match a model ID against OpenRouter entries (exact full ID first, then normalized base-name candidates). */
export function fuzzyMatchModel(
    modelId: string,
    candidates: readonly OpenRouterModelEntry[],
): OpenRouterModelEntry | null {
    if (!modelId || candidates.length === 0) return null;

    const normalizedModelId = normalizeModelId(modelId);
    const baseCandidates = buildCandidates(normalizedModelId);

    for (const candidate of candidates) {
        if (!hasContextLength(candidate)) {
            continue;
        }

        if (normalizeModelId(candidate.id) === normalizedModelId) {
            return candidate;
        }
    }

    for (const baseCandidate of baseCandidates) {
        for (const candidate of candidates) {
            if (!hasContextLength(candidate)) {
                continue;
            }

            if (extractBaseName(candidate.id) === baseCandidate) {
                return candidate;
            }
        }

        for (const candidate of candidates) {
            if (!hasContextLength(candidate)) {
                continue;
            }

            if (isMatch(extractBaseName(candidate.id), baseCandidate)) {
                return candidate;
            }
        }
    }

    return null;
}
