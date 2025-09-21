'use server';

import { itemsGeneratorAPI, CreateItemsGeneratorDto } from '@/lib/api';
import { getTranslations } from 'next-intl/server';

export async function generateItems(directoryId: string, data: CreateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');

    try {
        // Validate required fields
        if (!data.prompt || data.prompt.trim() === '') {
            return {
                success: false,
                error: t('promptRequired'),
            };
        }

        if (!data.name || data.name.trim() === '') {
            return {
                success: false,
                error: t('nameRequired'),
            };
        }

        // Call the API to generate items
        const result = await itemsGeneratorAPI.generate(directoryId, data);

        return {
            success: true,
            data: result,
            message: t('generationStartedSuccessfully'),
        };
    } catch (error) {
        console.error('Failed to generate items:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToGenerateItems'),
        };
    }
}

export async function regenerateMarkdown(directoryId: string) {
    const t = await getTranslations('actions.generator');

    try {
        const result = await itemsGeneratorAPI.regenerateMarkdown(directoryId);

        return {
            success: true,
            data: result,
            message: t('markdownRegeneratedSuccessfully'),
        };
    } catch (error) {
        console.error('Failed to regenerate markdown:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToRegenerateMarkdown'),
        };
    }
}