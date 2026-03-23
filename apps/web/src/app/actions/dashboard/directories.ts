'use server';

import { z } from 'zod';
import {
    directoryAPI,
    CreateDirectoryDto,
    itemsGeneratorAPI,
    UpdateDirectoryDto,
    DeleteDirectoryDto,
    SyncDirectoryResponse,
    AnalyzeRepositoryResponseDto,
    ImportSourceType,
    GetUserRepositoriesResponseDto,
    UpdateDirectorySchedulePayload,
    UpdateDirectoryAdvancedPromptsDto,
    GitProviderConnectionInfo,
} from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { checkGitProviderConnection } from './oauth';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { sanitizeName, sanitizeDescription, sanitizePrompt } from '@/lib/utils/sanitize';
import { slugify } from '@ever-works/plugin';

const readmeConfigSchema = z.object({
    header: z.string().optional(),
    overwriteDefaultHeader: z.boolean().optional(),
    footer: z.string().optional(),
    overwriteDefaultFooter: z.boolean().optional(),
});

const getCreateDirectorySchema = async () => {
    const t = await getTranslations('actions.directories');

    const createDirectorySchema = z.object({
        slug: z
            .string()
            .min(1, t('slug.required'))
            .transform((val) => val.trim().toLowerCase())
            .pipe(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t('slug.format'))),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        description: z
            .string()
            .min(1, t('description.required'))
            .transform((val) => sanitizeDescription(val, 500))
            .pipe(z.string().max(500, t('description.maxLength'))),
        owner: z
            .string()
            .optional()
            .transform((val) => val?.trim()),
        organization: z.boolean(),
        gitProvider: z.string().optional(),
        deployProvider: z.string().optional(),
        readmeConfig: readmeConfigSchema.optional(),
    });

    return createDirectorySchema;
};

const checkOrganization = (
    connectionInfo: GitProviderConnectionInfo | null,
    data: { owner?: string; organization?: boolean },
) => {
    if (!connectionInfo?.connected) {
        return {
            organization: data.organization || false,
            owner: data.owner || undefined,
        };
    }

    const username = connectionInfo.username;

    if (!data.organization) {
        return {
            organization: false,
            owner: username || undefined,
        };
    }

    const owner = data.owner?.trim();

    if (owner && username && owner !== username) {
        return {
            organization: true,
            owner: owner || undefined,
        };
    }

    return {
        organization: false,
        owner: username || undefined,
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

        const providerId = validation.data.gitProvider;
        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;
        validation.data.gitProvider = providerId;
        validation.data.deployProvider = data.deployProvider || undefined;

        console.log('Creating directory:', validation.data);

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
    gitProvider?: string;
    deployProvider?: string;
    providers?: {
        search?: string;
        screenshot?: string;
        ai?: string;
        contentExtractor?: string;
        pipeline?: string;
    };
    pluginConfig?: Record<string, unknown>;
}

export async function createDirectoryWithAI(request: AIDirectoryOptions) {
    const t = await getTranslations('actions.directories');

    // AI prompt validation schema
    const aiPromptSchema = z.object({
        prompt: z
            .string()
            .min(10, t('prompt.minLength'))
            .transform((val) => sanitizePrompt(val, 1000))
            .pipe(z.string().max(1000, t('prompt.maxLength'))),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        gitProvider: z.string().optional(),
    });

    const createDirectorySchema = await getCreateDirectorySchema();

    try {
        // Validate input
        const validation = aiPromptSchema.safeParse({
            prompt: request.prompt,
            name: request.name,
            gitProvider: request.gitProvider,
        });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const providerId = validation.data.gitProvider;
        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const aiProvider = request.providers?.ai;
        const defaultDetails = {
            name: validation.data.name,
            slug: slugify(validation.data.name),
            description: validation.data.prompt,
            keywords: [] as string[],
            categories: [] as string[],
        };
        let directoryDetails = defaultDetails;

        if (aiProvider) {
            directoryDetails = await directoryAPI
                .generateDetails({
                    directory_name: validation.data.name,
                    prompt: validation.data.prompt,
                    ai_provider: aiProvider,
                })
                .catch(() => defaultDetails);
        }

        // Determine organization settings
        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo,
            request,
        );

        const directoryData: CreateDirectoryDto = {
            name: validation.data.name,
            slug: directoryDetails.slug,
            description: directoryDetails.description,
            organization,
            owner,
            gitProvider: providerId,
            deployProvider: request.deployProvider || undefined,
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
            providers: request.providers || undefined,
            pluginConfig: {
                target_keywords: directoryDetails.keywords,
                ...(request.pluginConfig || {}),
            },
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

export async function fetchDirectoryGenerationHistory(
    directoryId: string,
    options: { limit?: number; offset?: number; activityType?: string } = {},
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.getHistory(directoryId, options);
        return {
            success: true,
            data: response,
        };
    } catch (error) {
        console.error('Failed to fetch directory generation history:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function updateDirectory(directoryId: string, data: UpdateDirectoryDto) {
    const t = await getTranslations('actions.directories');

    const updateDirectorySchema = z.object({
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        description: z
            .string()
            .min(1, t('description.required'))
            .transform((val) => sanitizeDescription(val, 500))
            .pipe(z.string().max(500, t('description.maxLength'))),
        owner: z
            .string()
            .optional()
            .transform((val) => val?.trim()),
        organization: z.boolean().optional(),
        readmeConfig: readmeConfigSchema.optional(),
    });

    try {
        // Validate input data
        const validation = updateDirectorySchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const { directory } = await directoryAPI.get(directoryId);
        const providerId = directory.gitProvider;

        const connectionCheck = providerId ? await checkGitProviderConnection(providerId) : null;

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo | null,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;

        await directoryAPI.update(directoryId, validation.data);

        const readmeUpdate = await directoryAPI.updateReadme(directoryId);

        revalidatePath(ROUTES.DASHBOARD_DIRECTORY_SETTINGS(directoryId));

        return {
            success: true,
            message: readmeUpdate?.message || t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function deleteDirectory(directoryId: string, options?: DeleteDirectoryDto) {
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

        await directoryAPI.delete(validation.data.id, options || {});

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

export async function syncDirectoryData(
    directoryId: string,
): Promise<SyncDirectoryResponse | null> {
    const user = await getAuthFromCookie();
    if (!user) {
        return null;
    }

    try {
        const res = await directoryAPI.syncData(directoryId);
        if (res.status === 'success') {
            revalidatePath(`/directories/${directoryId}`);
            revalidatePath(`/directories`);
        }
        return res;
    } catch (error) {
        console.error('Failed to sync directory data:', error);
        return null;
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

export async function getDirectoryStats() {
    try {
        const stats = await directoryAPI.getStats();
        return {
            success: true,
            ...stats,
        };
    } catch (error) {
        console.error('Failed to fetch directory stats:', error);
        return {
            success: false,
            totalDirectories: 0,
            totalItems: 0,
            activeWebsites: 0,
        };
    }
}

// Import actions

export async function analyzeRepository(sourceUrl: string, providerId?: string) {
    const t = await getTranslations('actions.directories');

    const urlSchema = z.string().url(t('import.invalidUrl'));

    try {
        const validation = urlSchema.safeParse(sourceUrl);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const result = await directoryAPI.analyzeRepository({
            sourceUrl: validation.data,
            gitProvider: providerId,
        });

        return {
            success: true,
            data: result as AnalyzeRepositoryResponseDto,
        };
    } catch (error) {
        console.error('Failed to analyze repository:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.analyzeFailed'),
        };
    }
}

interface ImportEnrichmentConfig {
    expansionFactor?: number;
    maxImportProportion?: number;
    parseIssues?: boolean;
    parsePullRequests?: boolean;
    enrichDescriptions?: boolean;
    expandTaxonomy?: boolean;
}

interface ImportDirectoryRequest {
    sourceUrl: string;
    sourceType: ImportSourceType;
    name: string;
    organization?: boolean;
    owner?: string;
    createMissingRepos?: boolean;
    sync?: boolean;
    gitProvider?: string;
    deployProvider?: string;
    providers?: Record<string, string>;
    enrichmentConfig?: ImportEnrichmentConfig;
}

export async function importDirectory(data: ImportDirectoryRequest) {
    const t = await getTranslations('actions.directories');

    const importSchema = z.object({
        sourceUrl: z.string().url(t('import.invalidUrl')),
        sourceType: z.enum(['data_repo', 'awesome_readme', 'link_existing']),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        organization: z.boolean().optional(),
        owner: z.string().optional(),
        createMissingRepos: z.boolean().optional(),
        sync: z.boolean().optional(),
        gitProvider: z.string().optional(),
        deployProvider: z.string().optional(),
        providers: z.record(z.string()).optional(),
        enrichmentConfig: z
            .object({
                expansionFactor: z.number().min(1.5).max(5).optional(),
                maxImportProportion: z.number().min(0.1).max(0.5).optional(),
                parseIssues: z.boolean().optional(),
                parsePullRequests: z.boolean().optional(),
                enrichDescriptions: z.boolean().optional(),
                expandTaxonomy: z.boolean().optional(),
            })
            .optional(),
    });

    try {
        const validation = importSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const providerId = validation.data.gitProvider;
        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo,
            validation.data,
        );

        const result = await directoryAPI.importDirectory({
            sourceUrl: validation.data.sourceUrl,
            sourceType: validation.data.sourceType,
            name: validation.data.name,
            organization,
            owner: owner || undefined,
            createMissingRepos: validation.data.createMissingRepos,
            sync: validation.data.sync,
            gitProvider: providerId,
            deployProvider: validation.data.deployProvider,
            providers: validation.data.providers,
            enrichmentConfig: validation.data.enrichmentConfig,
        });

        return {
            success: result.status !== 'error',
            directoryId: result.directoryId,
            historyId: result.historyId,
            message: result.message || t('import.started'),
            error: result.status === 'error' ? result.message : undefined,
        };
    } catch (error) {
        console.error('Failed to import directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.failed'),
        };
    }
}

interface GetUserRepositoriesParams {
    page?: number;
    perPage?: number;
    search?: string;
    gitProvider: string;
    owner?: string;
    type?: 'user' | 'org';
}

export async function analyzeForLinking(sourceUrl: string, providerId: string) {
    const t = await getTranslations('actions.directories');

    const urlSchema = z.string().url(t('import.invalidUrl'));

    try {
        const validation = urlSchema.safeParse(sourceUrl);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const result = await directoryAPI.analyzeForLinking({
            sourceUrl: validation.data,
            gitProvider: providerId,
        });

        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to analyze for linking:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.analyzeFailed'),
        };
    }
}

export async function getUserRepositories(params: GetUserRepositoriesParams) {
    const t = await getTranslations('actions.directories');

    try {
        const { gitProvider } = params;

        const connectionCheck = await checkGitProviderConnection(gitProvider);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: gitProvider }),
                requiresGitProvider: true,
            };
        }

        const result = await directoryAPI.getUserRepositories({
            gitProvider,
            page: params.page,
            perPage: params.perPage,
            search: params.search,
            owner: params.owner,
            type: params.type,
        });

        return {
            success: true,
            data: result as GetUserRepositoriesResponseDto,
        };
    } catch (error) {
        console.error('Failed to fetch user repositories:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.fetchReposFailed'),
        };
    }
}

export async function updateDirectorySchedule(
    directoryId: string,
    data: UpdateDirectorySchedulePayload,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.updateSchedule(directoryId, data);
        revalidatePath(`/directories/${directoryId}/settings`);
        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to update directory schedule:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update schedule',
        };
    }
}

export async function getRepositoryVisibility(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.getRepositoryVisibility(directoryId);
        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to get repository visibility:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get repository visibility',
        };
    }
}

export async function toggleRepositoryVisibility(
    directoryId: string,
    repoType: 'data' | 'directory' | 'website',
    isPrivate: boolean,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await directoryAPI.updateRepositoryVisibility(directoryId, {
            repoType,
            isPrivate,
        });
        revalidatePath(`/directories/${directoryId}/settings`);
        return {
            success: true,
        };
    } catch (error) {
        console.error('Failed to update repository visibility:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update repository visibility',
        };
    }
}

// Advanced Prompts Actions

export async function getAdvancedPrompts(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.getAdvancedPrompts(directoryId);
        return {
            success: true,
            data: response.advancedPrompts,
        };
    } catch (error) {
        console.error('Failed to fetch advanced prompts:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch advanced prompts',
        };
    }
}

export async function updateAdvancedPrompts(
    directoryId: string,
    data: UpdateDirectoryAdvancedPromptsDto,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // Validation schema for advanced prompts (max 2000 chars per prompt)
    const advancedPromptsSchema = z.object({
        relevanceAssessment: z.string().max(2000).nullable().optional(),
        itemGeneration: z.string().max(2000).nullable().optional(),
        itemExtraction: z.string().max(2000).nullable().optional(),
        searchQuery: z.string().max(2000).nullable().optional(),
        categorization: z.string().max(2000).nullable().optional(),
        deduplication: z.string().max(2000).nullable().optional(),
        sourceValidation: z.string().max(2000).nullable().optional(),
    });

    try {
        const validation = advancedPromptsSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await directoryAPI.updateAdvancedPrompts(directoryId, validation.data);
        revalidatePath(`/directories/${directoryId}/settings`);

        return {
            success: true,
            data: response.advancedPrompts,
        };
    } catch (error) {
        console.error('Failed to update advanced prompts:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update advanced prompts',
        };
    }
}

export async function getWebsiteSettings(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.getWebsiteSettings(directoryId);
        return {
            success: true,
            data: response,
        };
    } catch (error) {
        console.error('Failed to fetch website settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch website settings',
        };
    }
}

export async function updateWebsiteSettings(
    directoryId: string,
    data: {
        company_name?: string;
        company_website?: string;
        categories_enabled?: boolean;
        companies_enabled?: boolean;
        tags_enabled?: boolean;
        surveys_enabled?: boolean;
        header?: {
            submit_enabled?: boolean;
            pricing_enabled?: boolean;
            layout_enabled?: boolean;
            language_enabled?: boolean;
            theme_enabled?: boolean;
            layout_default?: string;
            pagination_default?: string;
            theme_default?: string;
        };
        homepage?: {
            hero_enabled?: boolean;
            search_enabled?: boolean;
            default_view?: string;
            default_sort?: string;
        };
        footer?: {
            subscribe_enabled?: boolean;
            version_enabled?: boolean;
            theme_selector_enabled?: boolean;
        };
        custom_menu?: {
            header?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
            footer?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
        };
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await directoryAPI.updateWebsiteSettings(directoryId, data);
        revalidatePath(`/directories/${directoryId}/settings`);

        return {
            success: true,
        };
    } catch (error) {
        console.error('Failed to update website settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update website settings',
        };
    }
}

export async function updateCommunityPrSettings(
    directoryId: string,
    settings: {
        communityPrEnabled?: boolean;
        communityPrAutoClose?: boolean;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.update(directoryId, settings);
        revalidatePath(`/directories/${directoryId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update community PR settings:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update community PR settings',
        };
    }
}

export async function updateCommitterSettings(
    directoryId: string,
    settings: {
        committerName?: string | null;
        committerEmail?: string | null;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.update(directoryId, settings);
        revalidatePath(`/directories/${directoryId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update committer settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update committer settings',
        };
    }
}
