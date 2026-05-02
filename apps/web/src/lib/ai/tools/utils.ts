import { getGlobalFormSchema, getFormSchema } from '@/app/actions/dashboard/generator-form';
import { buildSelectedProviders } from '@ever-works/plugin';
import { workAPI } from '@/lib/api/work';
import type { ProvidersDto } from '@ever-works/contracts/api';

export interface ResolvedGenerationConfig {
    providers?: ProvidersDto;
    pluginConfig?: Record<string, unknown>;
    pipelineId?: string;
}

/**
 * Resolve generation config — providers + pluginConfig.
 *
 * - With workId: reuses last request config if available,
 *   then falls back to work-scoped schema via getFormSchema().
 * - Without workId: uses global schema via getGlobalFormSchema().
 *
 * Mirrors the same logic as:
 * - WorkAICreator (new work) → getGlobalFormSchema
 * - GeneratorForm (existing work) → getFormSchema(workId)
 */
export async function resolveGenerationConfig(workId?: string): Promise<ResolvedGenerationConfig> {
    // For existing works, try to reuse last request data first
    if (workId) {
        try {
            const configRes = await workAPI.getConfig(workId);
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

    // Resolve from form schema — work-scoped or global
    try {
        const result = workId ? await getFormSchema(workId) : await getGlobalFormSchema();

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
