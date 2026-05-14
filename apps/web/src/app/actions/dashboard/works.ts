'use server';

import { z } from 'zod';
import {
    workAPI,
    CreateWorkDto,
    itemsGeneratorAPI,
    UpdateWorkDto,
    DeleteWorkDto,
    SyncWorkResponse,
    AnalyzeRepositoryResponseDto,
    ImportWorkDto,
    GetUserRepositoriesResponseDto,
    UpdateWorkSchedulePayload,
    UpdateWorkAdvancedPromptsDto,
    GitProviderConnectionInfo,
} from '@/lib/api';
import type { Work } from '@/lib/api/types-only';
import { getAuthFromCookie } from '@/lib/auth';
import { checkGitProviderConnection } from './oauth';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { sanitizeName, sanitizeDescription, sanitizePrompt } from '@/lib/utils/sanitize';
import { slugify } from '@ever-works/plugin';
import { ApiResponseError, serverMutation } from '@/lib/api/server-api';

const readmeConfigSchema = z.object({
    header: z.string().optional(),
    overwriteDefaultHeader: z.boolean().optional(),
    footer: z.string().optional(),
    overwriteDefaultFooter: z.boolean().optional(),
});

const getCreateWorkSchema = async () => {
    const t = await getTranslations('actions.works');

    const createWorkSchema = z.object({
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
        websiteTemplateId: z.string().optional(),
        readmeConfig: readmeConfigSchema.optional(),
    });

    return createWorkSchema;
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

export async function createWork(data: CreateWorkDto) {
    const t = await getTranslations('actions.works');

    const createWorkSchema = await getCreateWorkSchema();

    try {
        // Validate input data
        const validation = createWorkSchema.safeParse(data);
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

        console.log('Creating Work:', validation.data);

        // Create the work with validated data
        const { work } = await workAPI.create(validation.data);

        return {
            success: true,
            work,
            message: t('createSuccess'),
        };
    } catch (error) {
        console.error('Failed to create Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

interface AIWorkOptions {
    name: string;
    prompt: string;
    organization?: boolean;
    owner?: string;
    gitProvider?: string;
    deployProvider?: string;
    websiteTemplateId?: string;
    providers?: {
        search?: string;
        screenshot?: string;
        ai?: string;
        contentExtractor?: string;
        pipeline?: string;
    };
    pluginConfig?: Record<string, unknown>;
}

export async function createWorkWithAI(request: AIWorkOptions) {
    const t = await getTranslations('actions.works');

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

    const createWorkSchema = await getCreateWorkSchema();

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
        let workDetails = defaultDetails;

        if (aiProvider) {
            workDetails = await workAPI
                .generateDetails({
                    work_name: validation.data.name,
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

        const workData: CreateWorkDto = {
            name: validation.data.name,
            slug: workDetails.slug,
            description: workDetails.description,
            organization,
            owner,
            gitProvider: providerId,
            deployProvider: request.deployProvider || undefined,
            websiteTemplateId: request.websiteTemplateId || undefined,
        };

        // Validate the generated work data
        const workValidation = createWorkSchema.safeParse(workData);
        if (!workValidation.success) {
            return {
                success: false,
                error: t('invalidGeneratedData'),
            };
        }

        const { work } = await workAPI.create(workValidation.data);

        await itemsGeneratorAPI.generate(work.id, {
            name: validation.data.name,
            prompt: validation.data.prompt,
            providers: request.providers || undefined,
            pluginConfig: {
                target_keywords: workDetails.keywords,
                ...(request.pluginConfig || {}),
            },
        });

        return {
            success: true,
            work,
            message: t('aiGenerationStarted'),
            isGenerating: true,
        };
    } catch (error) {
        console.error('Failed to create Work with AI:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

export async function fetchWorkGenerationHistory(
    workId: string,
    options: { limit?: number; offset?: number; activityType?: string } = {},
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getHistory(workId, options);
        return {
            success: true,
            data: response,
        };
    } catch (error) {
        console.error('Failed to fetch Work generation history:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function updateWork(workId: string, data: UpdateWorkDto) {
    const t = await getTranslations('actions.works');

    const updateWorkSchema = z.object({
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
        websiteTemplateId: z.string().optional(),
        readmeConfig: readmeConfigSchema.optional(),
    });

    try {
        // Validate input data
        const validation = updateWorkSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const { work } = await workAPI.get(workId);
        const providerId = work.gitProvider;

        const connectionCheck = providerId ? await checkGitProviderConnection(providerId) : null;

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo | null,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;

        await workAPI.update(workId, validation.data);

        const readmeUpdate = await workAPI.updateReadme(workId);

        revalidatePath(ROUTES.DASHBOARD_WORK_SETTINGS(workId));

        return {
            success: true,
            message: readmeUpdate?.message || t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function updateWorkTemplate(workId: string, websiteTemplateId: string | null) {
    const t = await getTranslations('actions.works');

    const schema = z.object({
        workId: z.string().uuid(t('invalidId')),
        websiteTemplateId: z.string().nullable(),
    });

    try {
        const validation = schema.safeParse({ workId, websiteTemplateId });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const normalizedTemplateId = validation.data.websiteTemplateId?.trim() || null;

        await workAPI.update(validation.data.workId, {
            websiteTemplateId: normalizedTemplateId,
        });

        revalidatePath(ROUTES.DASHBOARD_WORK_GENERATOR(validation.data.workId));
        revalidatePath(ROUTES.DASHBOARD_WORK_SETTINGS(validation.data.workId));

        return {
            success: true,
            message: t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update Work template:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function deleteWork(workId: string, options?: DeleteWorkDto) {
    const t = await getTranslations('actions.works');

    // Delete work validation schema
    const deleteWorkSchema = z.object({
        id: z.string().uuid(t('invalidId')),
    });

    try {
        // Validate the work ID
        const validation = deleteWorkSchema.safeParse({ id: workId });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        await workAPI.delete(validation.data.id, options || {});

        return {
            success: true,
            message: t('deleteSuccess'),
        };
    } catch (error) {
        console.error('Failed to delete Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('deleteFailed'),
        };
    }
}

export async function syncWorkData(workId: string): Promise<SyncWorkResponse | null> {
    const user = await getAuthFromCookie();
    if (!user) {
        return null;
    }

    try {
        const res = await workAPI.syncData(workId);
        if (res.status === 'success') {
            revalidatePath(`/works/${workId}`);
            revalidatePath(`/works`);
        }
        return res;
    } catch (error) {
        console.error('Failed to sync Work data:', error);
        return null;
    }
}

export async function getWorkForStatusRefresh(workId: string): Promise<Work | null> {
    const user = await getAuthFromCookie();
    if (!user) {
        return null;
    }

    try {
        const { work } = await workAPI.get(workId);
        return work;
    } catch (error) {
        console.error('Failed to refresh Work status:', error);
        return null;
    }
}

interface GetWorksParams {
    search?: string;
    limit?: number;
    offset?: number;
}

export async function getWorks(params: GetWorksParams = {}) {
    const t = await getTranslations('actions.works');

    try {
        const { works, total } = await workAPI.getAll({
            search: params.search,
            limit: params.limit || 20,
            offset: params.offset || 0,
        });

        return {
            success: true,
            works,
            total,
        };
    } catch (error) {
        console.error('Failed to fetch works:', error);
        return {
            success: false,
            works: [],
            total: 0,
            error: error instanceof Error ? error.message : t('fetchFailed'),
        };
    }
}

export async function getWorkStats() {
    try {
        const stats = await workAPI.getStats();
        return {
            success: true,
            ...stats,
        };
    } catch (error) {
        console.error('Failed to fetch Work stats:', error);
        return {
            success: false,
            totalWorks: 0,
            totalItems: 0,
            activeWebsites: 0,
            generatingCount: 0,
        };
    }
}

// Import actions

export async function analyzeRepository(sourceUrl: string, providerId?: string) {
    const t = await getTranslations('actions.works');

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

        const result = await workAPI.analyzeRepository({
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

type ImportWorkRequest = ImportWorkDto;

interface ImportWorkProviderErrors {
    ai?: string;
    search?: string;
    contentExtractor?: string;
    screenshot?: string;
    pipeline?: string;
}

function isImportWorkProviderErrors(value: unknown): value is ImportWorkProviderErrors {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every((entry) => typeof entry === 'string');
}

export async function importWork(data: ImportWorkRequest) {
    const t = await getTranslations('actions.works');

    const importSchema = z.object({
        sourceUrl: z.string().url(t('import.invalidUrl')),
        sourceType: z.enum(['data_repo', 'awesome_readme', 'link_existing', 'works_config']),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        organization: z.boolean().optional(),
        owner: z.string().optional(),
        createMissingRepos: z.boolean().optional(),
        sync: z.boolean().optional(),
        restoreWorksConfig: z.boolean().optional(),
        gitProvider: z.string().optional(),
        deployProvider: z.string().optional(),
        providers: z.record(z.string()).optional(),
        enrichmentConfig: z
            .object({
                expansionFactor: z.number().min(1.5).max(5).optional(),
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

        const result = await workAPI.importWork({
            sourceUrl: validation.data.sourceUrl,
            sourceType: validation.data.sourceType,
            name: validation.data.name,
            organization,
            owner: owner || undefined,
            createMissingRepos: validation.data.createMissingRepos,
            sync: validation.data.sync,
            restoreWorksConfig: validation.data.restoreWorksConfig,
            gitProvider: providerId,
            deployProvider: validation.data.deployProvider,
            providers: validation.data.providers,
            enrichmentConfig: validation.data.enrichmentConfig,
        });

        return {
            success: result.status !== 'error',
            workId: result.workId,
            historyId: result.historyId,
            message: result.message || t('import.started'),
            error: result.status === 'error' ? result.message : undefined,
        };
    } catch (error) {
        console.error('Failed to import Work:', error);

        if (error instanceof ApiResponseError) {
            const providerErrors = error.details?.providerErrors;
            const resolvedPipelineId = error.details?.resolvedPipelineId;

            return {
                success: false,
                error: error.message,
                providerErrors: isImportWorkProviderErrors(providerErrors)
                    ? providerErrors
                    : undefined,
                resolvedPipelineId:
                    typeof resolvedPipelineId === 'string' ? resolvedPipelineId : undefined,
            };
        }

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
    const t = await getTranslations('actions.works');

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

        const result = await workAPI.analyzeForLinking({
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
    const t = await getTranslations('actions.works');

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

        const result = await workAPI.getUserRepositories({
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

export async function updateWorkSchedule(workId: string, data: UpdateWorkSchedulePayload) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await workAPI.updateSchedule(workId, data);
        revalidatePath(`/works/${workId}/settings`);
        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to update Work schedule:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update schedule',
        };
    }
}

export async function getRepositoryVisibility(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await workAPI.getRepositoryVisibility(workId);
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
    workId: string,
    repoType: 'data' | 'work' | 'website',
    isPrivate: boolean,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await workAPI.updateRepositoryVisibility(workId, {
            repoType,
            isPrivate,
        });
        revalidatePath(`/works/${workId}/settings`);
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

export async function getAdvancedPrompts(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getAdvancedPrompts(workId);
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

export async function updateAdvancedPrompts(workId: string, data: UpdateWorkAdvancedPromptsDto) {
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

        const response = await workAPI.updateAdvancedPrompts(workId, validation.data);
        revalidatePath(`/works/${workId}/settings`);

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

export async function getWebsiteSettings(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getWebsiteSettings(workId);
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
    workId: string,
    data: {
        company_name?: string;
        company_website?: string;
        categories_enabled?: boolean;
        companies_enabled?: boolean;
        tags_enabled?: boolean;
        surveys_enabled?: boolean;
        export_enabled?: boolean;
        import_enabled?: boolean;
        import_max_rows?: number;
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
        await workAPI.updateWebsiteSettings(workId, data);
        revalidatePath(`/works/${workId}/settings`);

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
    workId: string,
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
        const response = await workAPI.update(workId, settings);
        revalidatePath(`/works/${workId}/settings`);

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

export async function updateActivitySyncMode(
    workId: string,
    mode: 'pull' | 'push' | 'disabled',
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.update(workId, { activitySyncMode: mode });
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update activity sync mode:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update activity sync mode',
        };
    }
}

export async function rotateActivitySyncSecret(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await serverMutation<{ status: string; redeployRequired: boolean }>({
            endpoint: `/works/${workId}/activity-sync/rotate-secret`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
        revalidatePath(`/works/${workId}/settings`);
        return {
            success: response.status === 'success',
            redeployRequired: response.redeployRequired ?? false,
        };
    } catch (error) {
        console.error('Failed to rotate activity sync secret:', error);
        return {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : 'Failed to rotate activity sync secret',
        };
    }
}

export async function updateCommitterSettings(
    workId: string,
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
        const response = await workAPI.update(workId, settings);
        revalidatePath(`/works/${workId}/settings`);

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
