import { z } from 'zod';
import { tool } from 'ai';
import { getGlobalFormSchema, getFormSchema } from '@/app/actions/dashboard/generator-form';

export const listAvailablePipelines = tool({
    description: [
        'List available generation pipelines and their configurable providers.',
        'Each pipeline has different provider requirements — some need AI, search, screenshot, etc.',
        'Call this BEFORE generating to present options to the user.',
        'Pass a pipelineId to see the specific providers that pipeline supports.',
    ].join(' '),
    inputSchema: z.object({
        directoryId: z.string().optional().describe('Work ID for Work-specific schema'),
        pipelineId: z.string().optional().describe('Pipeline ID to see its specific providers'),
    }),
    execute: async ({ directoryId, pipelineId }) => {
        const result = directoryId
            ? await getFormSchema(directoryId, pipelineId)
            : await getGlobalFormSchema(pipelineId);

        if (!result.success || !result.data) {
            return { success: false, error: 'Failed to load pipelines' };
        }

        const schema = result.data;
        const formatProviders = (
            list: Array<{ id: string; name: string; configured: boolean; isDefault?: boolean }>,
        ) =>
            list.map((p) => ({
                id: p.id,
                name: p.name,
                configured: p.configured,
                isDefault: p.isDefault ?? false,
            }));

        // Build providers map dynamically — only includes categories the pipeline supports
        const availableProviders: Record<
            string,
            Array<{ id: string; name: string; configured: boolean; isDefault: boolean }>
        > = {};
        const providerEntries = Object.entries(schema.providers) as Array<
            [string, Array<{ id: string; name: string; configured: boolean; isDefault?: boolean }>]
        >;

        for (const [category, options] of providerEntries) {
            if (options?.length > 0) {
                availableProviders[category] = formatProviders(options);
            }
        }

        return {
            success: true,
            resolvedPipeline: schema.resolvedPipelineId,
            availableProviders,
            hasPluginConfig: schema.pluginFields.length > 0,
        };
    },
});
