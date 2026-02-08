'use server';

import { itemsGeneratorAPI, GeneratorFormSchema } from '@/lib/api';
import { getTranslations } from 'next-intl/server';

/**
 * Fetch the generator form schema for a directory.
 * The schema includes provider options and dynamic plugin fields.
 */
export async function getFormSchema(
    directoryId: string,
    pipelineId?: string,
): Promise<{
    success: boolean;
    data?: GeneratorFormSchema;
    error?: string;
}> {
    const t = await getTranslations('actions.generator');

    try {
        const schema = await itemsGeneratorAPI.getFormSchema(directoryId, pipelineId);

        return {
            success: true,
            data: schema,
        };
    } catch (error) {
        console.error('Failed to fetch form schema:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToLoadFormSchema'),
        };
    }
}

/**
 * Fetch the global generator form schema (no directory context).
 * Used by the "Create with AI" flow to show provider/pipeline selection.
 */
export async function getGlobalFormSchema(pipelineId?: string): Promise<{
    success: boolean;
    data?: GeneratorFormSchema;
    error?: string;
}> {
    const t = await getTranslations('actions.generator');

    try {
        const schema = await itemsGeneratorAPI.getFormSchemaGlobal(pipelineId);

        return {
            success: true,
            data: schema,
        };
    } catch (error) {
        console.error('Failed to fetch global form schema:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToLoadFormSchema'),
        };
    }
}
