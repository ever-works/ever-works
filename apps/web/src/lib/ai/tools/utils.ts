import { getGlobalFormSchema, getFormSchema } from '@/app/actions/dashboard/generator-form';
import { buildSelectedProviders } from '@ever-works/plugin';
import { directoryAPI } from '@/lib/api/directory';
import type { ProvidersDto } from '@ever-works/contracts/api';

export interface ResolvedGenerationConfig {
    providers?: ProvidersDto;
    pluginConfig?: Record<string, unknown>;
    pipelineId?: string;
}

/**
 * Resolve generation config — providers + pluginConfig.
 *
 * - With directoryId: reuses last request config if available,
 *   then falls back to directory-scoped schema via getFormSchema().
 * - Without directoryId: uses global schema via getGlobalFormSchema().
 *
 * Mirrors the same logic as:
 * - DirectoryAICreator (new directory) → getGlobalFormSchema
 * - GeneratorForm (existing directory) → getFormSchema(directoryId)
 */
export async function resolveGenerationConfig(
    directoryId?: string,
): Promise<ResolvedGenerationConfig> {
    // For existing directories, try to reuse last request data first
    if (directoryId) {
        try {
            const configRes = await directoryAPI.getConfig(directoryId);
            const lastRequest = configRes?.config?.metadata?.last_request_data;

            if (lastRequest) {
                return {
                    providers: lastRequest.providers,
                    pluginConfig: lastRequest.pluginConfig,
                    pipelineId: lastRequest.providers?.pipeline ?? undefined,
                };
            }
        } catch {
            // Fall through to schema resolution
        }
    }

    // Resolve from form schema — directory-scoped or global
    try {
        const result = directoryId ? await getFormSchema(directoryId) : await getGlobalFormSchema();

        if (!result.success || !result.data) return {};

        const providers = buildSelectedProviders({}, result.data);
        return {
            providers: providers as ProvidersDto | undefined,
            pluginConfig: result.data.defaultValues,
            pipelineId: result.data.resolvedPipelineId,
        };
    } catch {
        return {};
    }
}
