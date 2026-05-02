import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { workAPI, type Work } from '@/lib/api/work';
import {
    createWork,
    createWorkWithAI,
    deleteWork,
    getWorkStats,
    updateWork,
    syncWorkData,
    fetchWorkGenerationHistory,
    analyzeRepository,
    importWork,
} from '@/app/actions/dashboard/works';
import { resolveGenerationConfig } from './utils';

// ────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────

export const listWorks = tool({
    description:
        'List Works the user has access to. Use to find Works by name before other operations.',
    inputSchema: z.object({
        search: z.string().optional().describe('Search query to filter by name'),
        limit: z.number().optional().describe('Max results (default 20)'),
        offset: z.number().optional().describe('Pagination offset (default 0)'),
    }),
    execute: async ({ search, limit, offset }) => {
        const result = await workAPI.getAll({
            search,
            limit: limit ?? 20,
            offset: offset ?? 0,
        });
        return {
            works: result.works.map((d: Work) => ({
                id: d.id,
                name: d.name,
                slug: d.slug,
                itemsCount: d.itemsCount ?? 0,
                generateStatus: d.generateStatus?.status ?? 'idle',
                generateWarnings: d.generateStatus?.warnings ?? [],
                gitProvider: d.gitProvider,
                deployProvider: d.deployProvider,
                url: ROUTES.DASHBOARD_WORK(d.id),
            })),
            total: result.total,
            hasMore: (offset ?? 0) + (limit ?? 20) < result.total,
        };
    },
});

export const getWorkDetails = tool({
    description: 'Get detailed info about a specific Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const { work } = await workAPI.get(workId);
        return {
            id: work.id,
            name: work.name,
            slug: work.slug,
            description: work.description,
            itemsCount: work.itemsCount ?? 0,
            generateStatus: work.generateStatus?.status ?? 'idle',
            generateWarnings: work.generateStatus?.warnings ?? [],
            gitProvider: work.gitProvider,
            deployProvider: work.deployProvider,
            url: ROUTES.DASHBOARD_WORK(work.id),
        };
    },
});

export const getStats = tool({
    description: 'Get aggregated stats — total Works, items, active websites.',
    inputSchema: z.object({}),
    execute: async () => getWorkStats(),
});

export const getWorkItemsSummary = tool({
    description:
        'Get item counts and categories for a Work. For browsing items, navigate to items tab instead.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            const counts = await workAPI.getCount(workId);
            const catTags = await workAPI.getCategoriesTags(workId);
            return {
                ...counts,
                categories: catTags.categories?.slice(0, 20) ?? [],
                tags: catTags.tags?.slice(0, 20) ?? [],
            };
        } catch {
            return { error: 'Failed to fetch items summary' };
        }
    },
});

export const getGenerationHistory = tool({
    description: 'Get generation history — past runs, status, and metrics.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        limit: z.number().optional().describe('Max results (default 10)'),
    }),
    execute: async ({ workId, limit }) => {
        const result = await fetchWorkGenerationHistory(workId, { limit: limit ?? 10 });
        return { success: result.success, data: result.data, error: result.error };
    },
});

export const getScheduleStatus = tool({
    description: 'Get current schedule configuration and status for a Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            return await workAPI.getSchedule(workId);
        } catch {
            return { enabled: false, error: 'Failed to fetch schedule' };
        }
    },
});

export const getWorkConfig = tool({
    description:
        'Get Work configuration — metadata, initial prompt, generation settings, website config.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            const result = await workAPI.getConfig(workId);
            return { success: true, config: result.config };
        } catch {
            return { success: false, error: 'Failed to fetch config' };
        }
    },
});

// ────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────

export const createWorkManual = tool({
    description: [
        'Create a Work manually WITHOUT generating content.',
        'Just creates the repository structure. User can add items later.',
        'REQUIRES git provider — call checkGitConnection first.',
    ].join(' '),
    inputSchema: z.object({
        name: z.string().describe('Work name'),
        slug: z.string().describe('URL-friendly slug (lowercase, hyphens only)'),
        description: z.string().optional().describe('Work description'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
    }),
    execute: async ({ name, slug, description, gitProvider }) => {
        const result = await createWork({
            name,
            slug,
            description: description ?? '',
            gitProvider,
            organization: false,
        });
        return {
            success: result.success,
            workId: result.work?.id,
            message: result.message,
            error: result.error,
            url: result.work ? ROUTES.DASHBOARD_WORK(result.work.id) : undefined,
        };
    },
});

export const createWorkWithAITool = tool({
    description: [
        'Create a Work AND generate content using AI.',
        'BEFORE calling: call checkGitConnection, then listAvailablePipelines to let user choose pipeline/providers.',
        'Pass user provider choices. If not provided, uses defaults.',
    ].join(' '),
    inputSchema: z.object({
        name: z.string().describe('Work name'),
        prompt: z.string().describe('What the Work should contain'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
        deployProvider: z
            .string()
            .optional()
            .describe('Deploy provider ID from checkDeployConnection'),
        providers: z
            .record(z.string())
            .optional()
            .describe(
                'User-chosen providers from listAvailablePipelines (e.g., { pipeline: "sim-ai", ai: "openrouter" })',
            ),
    }),
    execute: async ({ name, prompt, gitProvider, deployProvider, providers: userProviders }) => {
        // Resolve defaults, then override with user choices
        const config = await resolveGenerationConfig();
        const mergedProviders = userProviders ?? config.providers;

        const result = await createWorkWithAI({
            name,
            prompt,
            gitProvider,
            deployProvider,
            providers: mergedProviders,
            pluginConfig: config.pluginConfig,
        });
        return {
            success: result.success,
            workId: result.work?.id,
            message: result.message,
            isGenerating: result.isGenerating,
            error: result.error,
            url: result.work ? ROUTES.DASHBOARD_WORK(result.work.id) : undefined,
        };
    },
});

export const importWorkTool = tool({
    description: [
        'Import a Work from an existing GitHub repository or awesome list URL.',
        'First call analyzeImportSource to check the URL, then import.',
        'REQUIRES git provider — call checkGitConnection first.',
    ].join(' '),
    inputSchema: z.object({
        sourceUrl: z.string().describe('GitHub repository URL or awesome list URL to import'),
        sourceType: z
            .enum(['data_repo', 'awesome_readme', 'link_existing', 'works_config'])
            .describe('Type of import source'),
        name: z.string().describe('Work name'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
    }),
    execute: async ({ sourceUrl, sourceType, name, gitProvider }) => {
        const result = await importWork({ sourceUrl, sourceType, name, gitProvider });
        return {
            success: result.success,
            workId: result.workId,
            message: result.message,
            error: result.error,
            url: result.workId ? ROUTES.DASHBOARD_WORK(result.workId) : undefined,
        };
    },
});

export const analyzeImportSource = tool({
    description:
        'Analyze a GitHub URL to determine if it can be imported and what type of import to use.',
    inputSchema: z.object({
        sourceUrl: z.string().describe('GitHub repository URL to analyze'),
    }),
    execute: async ({ sourceUrl }) => {
        const result = await analyzeRepository(sourceUrl);
        return { success: result.success, data: result.data, error: result.error };
    },
});

// ────────────────────────────────────────────────────────────────
// Update / Delete
// ────────────────────────────────────────────────────────────────

export const updateWorkTool = tool({
    description: 'Update a Work name or description.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
    }),
    execute: async ({ workId, name, description }) => {
        const result = await updateWork(workId, { name, description });
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const deleteWorkTool = tool({
    description: 'Delete a Work. ALWAYS ask for confirmation before calling this.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID to delete'),
    }),
    execute: async ({ workId }) => {
        const result = await deleteWork(workId);
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const syncWork = tool({
    description: 'Sync a Work data repository with the latest changes.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const result = await syncWorkData(workId);
        return result ?? { success: false, error: 'Sync failed' };
    },
});
