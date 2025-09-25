'use server';

import {
    itemsGeneratorAPI,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    directoryAPI,
    authAPI,
} from '@/lib/api';
import { getTranslations } from 'next-intl/server';
import { checkOAuthConnection } from './oauth';

export async function generateItems(directoryId: string, data: CreateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');
    const tDirectories = await getTranslations('actions.directories');

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

        const { directory } = await directoryAPI.get(directoryId);

        // We need to ensure that oauth connection is valid or revoke it if not
        await authAPI.oauth_connections.ensureConnection(directory.repoProvider);

        // Check GitHub connection first
        const oauthCheck = await checkOAuthConnection(directory.repoProvider);
        if (!oauthCheck.connected) {
            return {
                success: false,
                error: tDirectories('oauthRequired', { provider: directory.repoProvider }),
                requiresGitHub: true,
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

export async function updateItems(directoryId: string, data: UpdateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');

    try {
        // Call the API to update items
        const result = await itemsGeneratorAPI.update(directoryId, data);

        return {
            success: true,
            data: result,
            message: t('updateStartedSuccessfully'),
        };
    } catch (error) {
        console.error('Failed to update items:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToUpdateItems'),
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
