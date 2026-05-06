'use server';

import {
    itemsGeneratorAPI,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    CancelGenerationResponse,
    workAPI,
    gitProvidersAPI,
} from '@/lib/api';
import { getTranslations } from 'next-intl/server';
import { checkGitProviderConnection } from './oauth';
import {
    sanitizeName,
    sanitizePrompt,
    sanitizeStringArray,
    sanitizeText,
} from '@/lib/utils/sanitize';

/**
 * Sanitize plugin-specific configuration values.
 * Applies sanitization to common patterns (string arrays, URLs) while
 * leaving other values unchanged.
 */
function sanitizePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
            continue;
        }

        // String arrays (categories, keywords, tags, etc.)
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
            // URL arrays get trimmed, other string arrays get sanitized
            if (key.includes('url')) {
                sanitized[key] = value.map((v: string) => v.trim()).filter(Boolean);
            } else {
                sanitized[key] = sanitizeStringArray(value);
            }
        }
        // Pass through all other values
        else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

type CancelGenerationActionResult =
    | {
          success: true;
          data: CancelGenerationResponse;
          message: string;
      }
    | {
          success: false;
          error: string;
      };

export async function generateItems(workId: string, data: CreateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');
    const tWorks = await getTranslations('actions.works');

    try {
        // Sanitize core data
        const sanitizedData: CreateItemsGeneratorDto = {
            name: sanitizeName(data.name, 200),
            prompt: sanitizePrompt(data.prompt, 5000),
            model: sanitizeText(data.model, { maxLength: 200 }) || undefined,
            generation_method: data.generation_method,
            update_with_pull_request: data.update_with_pull_request,
            website_repository_creation_method: data.website_repository_creation_method,
            providers: data.providers,
            // Pass pluginConfig through (sanitization is plugin-specific)
            pluginConfig: data.pluginConfig ? sanitizePluginConfig(data.pluginConfig) : undefined,
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

        const { work } = await workAPI.get(workId);

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(work.gitProvider);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: tWorks('oauthRequired', { provider: work.gitProvider }),
                requiresGitProvider: true,
            };
        }

        // Get organizations from the git provider
        const orgsResult = await gitProvidersAPI.getOrganizations(work.gitProvider);
        const orgs = orgsResult.organizations || [];

        // connectionCheck.username is available when connected is true
        const username = 'username' in connectionCheck ? connectionCheck.username : undefined;
        if (work.owner && username !== work.owner) {
            if (!orgs.some((org) => org.login === work.owner)) {
                return {
                    success: false,
                    error: t('notAuthorizedToAccessOrganization', { owner: work.owner }),
                };
            }
        }

        // Call the API to generate items with sanitized data
        const result = await itemsGeneratorAPI.generate(workId, sanitizedData);

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

export async function updateItems(workId: string, data: UpdateItemsGeneratorDto) {
    const t = await getTranslations('actions.generator');

    try {
        // Call the API to update items
        const result = await itemsGeneratorAPI.update(workId, data);

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

export async function cancelGeneration(workId: string): Promise<CancelGenerationActionResult> {
    const t = await getTranslations('actions.generator');

    try {
        const result = await itemsGeneratorAPI.cancel(workId);

        return {
            success: true,
            data: result,
            message: result.message || t('generationCancellationRequested'),
        };
    } catch (error) {
        console.error('Failed to cancel generation:', error);

        return {
            success: false,
            error: error instanceof Error ? error.message : t('failedToCancelGeneration'),
        };
    }
}

export async function regenerateMarkdown(workId: string) {
    const t = await getTranslations('actions.generator');

    try {
        const result = await itemsGeneratorAPI.regenerateMarkdown(workId);

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
