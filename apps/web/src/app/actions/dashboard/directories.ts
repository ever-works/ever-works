'use server';

import { z } from 'zod';
import {
    directoryAPI,
    CreateDirectoryDto,
    itemsGeneratorAPI,
    UpdateDirectoryDto,
    ConnectionInfo,
} from '@/lib/api';
import { checkOAuthConnection } from './oauth';
import { RepoProvider } from '@/lib/api/enums';
import { getTranslations } from 'next-intl/server';

const readmeConfigSchema = z.object({
    header: z.string().optional(),
    overwriteDefaultHeader: z.boolean().optional(),
    footer: z.string().optional(),
    overwriteDefaultFooter: z.boolean().optional(),
});

const getCreateDirectorySchema = async () => {
    const t = await getTranslations('actions.directories');

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

const checkOrganization = (
    oauthConnect: ConnectionInfo,
    data: { owner?: string; organization?: boolean },
) => {
    if (!oauthConnect.connected) {
        return {
            organization: data.organization || false,
            owner: data.owner || null,
        };
    }

    const oauthUsername = oauthConnect.username || oauthConnect.metadata?.login;

    if (!data.organization) {
        return {
            organization: false,
            owner: oauthUsername || null,
        };
    }

    const owner = data.owner?.trim();

    if (owner && oauthUsername && owner !== oauthUsername) {
        return {
            organization: true,
            owner: oauthUsername || null,
        };
    }

    return {
        organization: false,
        owner: oauthUsername || null,
    };
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
        const oauthCheck = await checkOAuthConnection(validation.data.repoProvider);
        if (!oauthCheck.connected) {
            return {
                success: false,
                error: t('githubRequired'),
                requiresGitHub: true,
            };
        }

        const { organization, owner } = checkOrganization(
            oauthCheck as ConnectionInfo,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;

        // Create the directory with validated data
        const { directory } = await directoryAPI.create(validation.data);

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

export async function createDirectoryWithAI(request: AIDirectoryOptions) {
    const t = await getTranslations('actions.directories');

    // AI prompt validation schema
    const aiPromptSchema = z.object({
        prompt: z.string().min(10, t('prompt.minLength')).max(1000, t('prompt.maxLength')),
        name: z.string().min(1, t('name.required')).max(100, t('name.maxLength')),
        repoProvider: z.nativeEnum(RepoProvider).optional().default(RepoProvider.GITHUB),
    });

    const createDirectorySchema = await getCreateDirectorySchema();

    try {
        // Validate input
        const validation = aiPromptSchema.safeParse({ prompt: request.prompt, name: request.name });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // Check GitHub connection first
        const oauthCheck = await checkOAuthConnection(validation.data.repoProvider);
        if (!oauthCheck.connected) {
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
        const { organization, owner } = checkOrganization(oauthCheck as ConnectionInfo, request);

        const directoryData: CreateDirectoryDto = {
            name: validation.data.name,
            slug: directoryDetails.slug,
            description: directoryDetails.description,
            organization,
            owner,
            repoProvider: validation.data.repoProvider,
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

export async function updateDirectory(directoryId: string, data: UpdateDirectoryDto) {
    const t = await getTranslations('actions.directories');

    const updateDirectorySchema = z
        .object({
            name: z.string().min(1, t('name.required')).max(100, t('name.maxLength')),
            description: z
                .string()
                .min(1, t('description.required'))
                .max(500, t('description.maxLength')),
            owner: z.string().optional(),
            organization: z.boolean().optional(),
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

    try {
        // Validate input data
        const validation = updateDirectorySchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const oauthCheck = await checkOAuthConnection(RepoProvider.GITHUB);

        const { organization, owner } = checkOrganization(
            oauthCheck as ConnectionInfo,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;

        await directoryAPI.update(directoryId, validation.data);

        return {
            success: true,
            message: t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
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
