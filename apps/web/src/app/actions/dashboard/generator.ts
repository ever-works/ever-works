'use server';

import {
    itemsGeneratorAPI,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    directoryAPI,
    authAPI,
    ConnectionInfo,
} from '@/lib/api';
import { getTranslations } from 'next-intl/server';
import { checkOAuthConnection } from './oauth';
import {
    sanitizeName,
    sanitizeDescription,
    sanitizePrompt,
    sanitizeStringArray,
} from '@/lib/utils/sanitize';

export async function generateItems(directoryId: string, data: CreateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');
    const tDirectories = await getTranslations('actions.directories');

    try {
        // Sanitize input data
        const sanitizedData: CreateItemsGeneratorDto = {
            ...data,
            name: sanitizeName(data.name, 200),
            prompt: sanitizePrompt(data.prompt, 5000),
            repository_description: data.repository_description
                ? sanitizeDescription(data.repository_description, 500)
                : undefined,
            initial_categories: data.initial_categories
                ? sanitizeStringArray(data.initial_categories)
                : undefined,
            priority_categories: data.priority_categories
                ? sanitizeStringArray(data.priority_categories)
                : undefined,
            target_keywords: data.target_keywords
                ? sanitizeStringArray(data.target_keywords)
                : undefined,
            source_urls: data.source_urls
                ? data.source_urls.map((url) => url.trim()).filter(Boolean)
                : undefined,
            company: data.company
                ? {
                      name: sanitizeName(data.company.name, 200),
                      website: data.company.website.trim(),
                  }
                : undefined,
        };

        // Validate required fields
        if (!sanitizedData.prompt || sanitizedData.prompt.trim() === '') {
            return {
                success: false,
                error: t('promptRequired'),
            };
        }

        if (!sanitizedData.name || sanitizedData.name.trim() === '') {
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

        const oauthInfo = oauthCheck as ConnectionInfo;

        // Get organizations
        const orgs = await authAPI.oauth_connections.getGitHubOrgs();

        if (directory.owner && oauthInfo.username !== directory.owner) {
            if (!orgs.some((org) => org.login === directory.owner)) {
                return {
                    success: false,
                    error: t('notAuthorizedToAccessOrganization', { owner: directory.owner }),
                };
            }
        }

        // Call the API to generate items with sanitized data
        const result = await itemsGeneratorAPI.generate(directoryId, sanitizedData);

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
