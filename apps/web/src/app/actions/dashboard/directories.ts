'use server';

import { z } from 'zod';
import { directoryAPI, CreateDirectoryDto } from '@/lib/api';
import { checkGitHubConnection } from './oauth';
import { RepoProvider } from '@/lib/api/enums';
import { getTranslations } from 'next-intl/server';

const getCreateDirectorySchema = async () => {
    const t = await getTranslations('actions.directories');

    const readmeConfigSchema = z.object({
        header: z.string().optional(),
        overwriteDefaultHeader: z.boolean().optional(),
        footer: z.string().optional(),
        overwriteDefaultFooter: z.boolean().optional(),
    });

    const createDirectorySchema = z.object({
        slug: z
            .string()
            .min(1, t('slug.required'))
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t('slug.format')),
        name: z.string().min(1, t('name.required')).max(100, t('name.maxLength')),
        description: z
            .string()
            .min(1, t('description.required'))
            .max(500, t('description.maxLength')),
        owner: z.string().optional(),
        organization: z.boolean(),
        repoProvider: z.nativeEnum(RepoProvider).optional().default(RepoProvider.GITHUB),
        readmeConfig: readmeConfigSchema.optional(),
    });

    return createDirectorySchema;
};

export async function createDirectory(data: CreateDirectoryDto) {
    const t = await getTranslations('actions.directories');

    const createDirectorySchema = await getCreateDirectorySchema();

    try {
        // Validate input data
        const validation = createDirectorySchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // Check GitHub connection first
        const githubCheck = await checkGitHubConnection();
        if (!githubCheck.connected) {
            return {
                success: false,
                error: t('githubRequired'),
                requiresGitHub: true,
            };
        }

        // Create the directory with validated data
        const directory = await directoryAPI.create(validation.data);

        return {
            success: true,
            directory,
            message: t('createSuccess'),
        };
    } catch (error) {
        console.error('Failed to create directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

export async function createDirectoryWithAI(prompt: string, name: string) {
    const t = await getTranslations('actions.directories');

    // AI prompt validation schema
    const aiPromptSchema = z.object({
        prompt: z.string().min(10, t('prompt.minLength')).max(1000, t('prompt.maxLength')),
        name: z.string().min(1, t('name.required')).max(100, t('name.maxLength')),
    });

    const createDirectorySchema = await getCreateDirectorySchema();

    try {
        // Validate input
        const validation = aiPromptSchema.safeParse({ prompt, name });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // Check GitHub connection first
        const githubCheck = await checkGitHubConnection();
        if (!githubCheck.connected) {
            return {
                success: false,
                error: t('githubRequired'),
                requiresGitHub: true,
            };
        }

        // TODO: Call AI generation endpoint when available
        // For now, we'll create a basic directory based on the prompt
        const slug = validation.data.name
            ? validation.data.name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
            : 'ai-generated-' + Date.now();

        const directoryData: CreateDirectoryDto = {
            name: validation.data.name || 'AI Generated Directory',
            slug,
            description: `Directory created from prompt: ${validation.data.prompt.substring(0, 200)}...`,
            organization: false,
            repoProvider: RepoProvider.GITHUB,
        };

        // Validate the generated directory data
        const directoryValidation = createDirectorySchema.safeParse(directoryData);
        if (!directoryValidation.success) {
            return {
                success: false,
                error: t('invalidGeneratedData'),
            };
        }

        const directory = await directoryAPI.create(directoryValidation.data);

        // TODO: Trigger AI generation process
        // This would typically be an async job that generates items

        return {
            success: true,
            directory,
            message: t('aiGenerationStarted'),
            isGenerating: true,
        };
    } catch (error) {
        console.error('Failed to create directory with AI:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

export async function deleteDirectory(directoryId: string) {
    const t = await getTranslations('actions.directories');

    // Delete directory validation schema
    const deleteDirectorySchema = z.object({
        id: z.string().uuid(t('invalidId')),
    });

    try {
        // Validate the directory ID
        const validation = deleteDirectorySchema.safeParse({ id: directoryId });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        await directoryAPI.delete(validation.data.id, {
            confirmation: true,
        });

        return {
            success: true,
            message: t('deleteSuccess'),
        };
    } catch (error) {
        console.error('Failed to delete directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('deleteFailed'),
        };
    }
}

interface GetDirectoriesParams {
    search?: string;
    limit?: number;
    offset?: number;
}

export async function getDirectories(params: GetDirectoriesParams = {}) {
    const t = await getTranslations('actions.directories');

    try {
        const { directories, total } = await directoryAPI.getAll({
            search: params.search,
            limit: params.limit || 20,
            offset: params.offset || 0,
        });

        return {
            success: true,
            directories,
            total,
        };
    } catch (error) {
        console.error('Failed to fetch directories:', error);
        return {
            success: false,
            directories: [],
            total: 0,
            error: error instanceof Error ? error.message : t('fetchFailed'),
        };
    }
}
