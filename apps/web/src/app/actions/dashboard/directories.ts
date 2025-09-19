'use server';

import { z } from 'zod';
import { directoryAPI, CreateDirectoryDto, itemsGeneratorAPI } from '@/lib/api';
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

    const createDirectorySchema = z
        .object({
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
        })
        .refine(
            (data) => {
                // If owner is provided and not empty, organization should be true
                if (data.owner && data.owner.trim() !== '' && !data.organization) {
                    return false;
                }
                return true;
            },
            {
                message: t('organization.requiredWhenOwnerProvided'),
                path: ['organization'],
            },
        );

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

interface AIDirectoryOptions {
    name: string;
    prompt: string;
    organization?: boolean;
    owner?: string;
}

export async function createDirectoryWithAI({
    name,
    prompt,
    organization,
    owner,
}: AIDirectoryOptions) {
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

        const directoryDetails = await directoryAPI.generateDetails({
            directory_name: validation.data.name,
            prompt: validation.data.prompt,
        });

        // Determine organization settings
        const isOrganization = Boolean(organization || (owner && owner.trim() !== ''));

        const directoryData: CreateDirectoryDto = {
            name: validation.data.name,
            slug: directoryDetails.slug,
            description: directoryDetails.description,
            organization: isOrganization,
            owner: isOrganization ? owner : undefined,
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

        const { directory } = await directoryAPI.create(directoryValidation.data);

        await itemsGeneratorAPI.generate(directory.id, {
            name: validation.data.name,
            prompt: validation.data.prompt,
            target_keywords: directoryDetails.keywords,
        });

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
