import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { directoryAPI, type Directory } from '@/lib/api/directory';
import {
    createDirectory,
    createDirectoryWithAI,
    deleteDirectory,
    getDirectoryStats,
    updateDirectory,
    syncDirectoryData,
    fetchDirectoryGenerationHistory,
    analyzeRepository,
    importDirectory,
} from '@/app/actions/dashboard/directories';
import { resolveGenerationConfig } from './utils';

// ────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────

export const listDirectories = tool({
    description:
        'List directories the user has access to. Use to find directories by name before other operations.',
    inputSchema: z.object({
        search: z.string().optional().describe('Search query to filter by name'),
        limit: z.number().optional().describe('Max results (default 20)'),
        offset: z.number().optional().describe('Pagination offset (default 0)'),
    }),
    execute: async ({ search, limit, offset }) => {
        const result = await directoryAPI.getAll({
            search,
            limit: limit ?? 20,
            offset: offset ?? 0,
        });
        return {
            directories: result.directories.map((d: Directory) => ({
                id: d.id,
                name: d.name,
                slug: d.slug,
                itemsCount: d.itemsCount ?? 0,
                generateStatus: d.generateStatus?.status ?? 'idle',
                generateWarnings: d.generateStatus?.warnings ?? [],
                gitProvider: d.gitProvider,
                deployProvider: d.deployProvider,
                url: ROUTES.DASHBOARD_DIRECTORY(d.id),
            })),
            total: result.total,
            hasMore: (offset ?? 0) + (limit ?? 20) < result.total,
        };
    },
});

export const getDirectoryDetails = tool({
    description: 'Get detailed info about a specific directory.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        const { directory } = await directoryAPI.get(directoryId);
        return {
            id: directory.id,
            name: directory.name,
            slug: directory.slug,
            description: directory.description,
            itemsCount: directory.itemsCount ?? 0,
            generateStatus: directory.generateStatus?.status ?? 'idle',
            generateWarnings: directory.generateStatus?.warnings ?? [],
            gitProvider: directory.gitProvider,
            deployProvider: directory.deployProvider,
            url: ROUTES.DASHBOARD_DIRECTORY(directory.id),
        };
    },
});

export const getStats = tool({
    description: 'Get aggregated stats — total directories, items, active websites.',
    inputSchema: z.object({}),
    execute: async () => getDirectoryStats(),
});

export const getDirectoryItemsSummary = tool({
    description:
        'Get item counts and categories for a directory. For browsing items, navigate to items tab instead.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        try {
            const counts = await directoryAPI.getCount(directoryId);
            const catTags = await directoryAPI.getCategoriesTags(directoryId);
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
        directoryId: z.string().describe('Directory ID'),
        limit: z.number().optional().describe('Max results (default 10)'),
    }),
    execute: async ({ directoryId, limit }) => {
        const result = await fetchDirectoryGenerationHistory(directoryId, { limit: limit ?? 10 });
        return { success: result.success, data: result.data, error: result.error };
    },
});

export const getScheduleStatus = tool({
    description: 'Get current schedule configuration and status for a directory.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        try {
            return await directoryAPI.getSchedule(directoryId);
        } catch {
            return { enabled: false, error: 'Failed to fetch schedule' };
        }
    },
});

export const getDirectoryConfig = tool({
    description:
        'Get directory configuration — metadata, initial prompt, generation settings, website config.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        try {
            const result = await directoryAPI.getConfig(directoryId);
            return { success: true, config: result.config };
        } catch {
            return { success: false, error: 'Failed to fetch config' };
        }
    },
});

// ────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────

export const createDirectoryManual = tool({
    description: [
        'Create a directory manually WITHOUT generating content.',
        'Just creates the repository structure. User can add items later.',
        'REQUIRES git provider — call checkGitConnection first.',
    ].join(' '),
    inputSchema: z.object({
        name: z.string().describe('Directory name'),
        slug: z.string().describe('URL-friendly slug (lowercase, hyphens only)'),
        description: z.string().optional().describe('Directory description'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
    }),
    execute: async ({ name, slug, description, gitProvider }) => {
        const result = await createDirectory({
            name,
            slug,
            description: description ?? '',
            gitProvider,
            organization: false,
        });
        return {
            success: result.success,
            directoryId: result.directory?.id,
            message: result.message,
            error: result.error,
            url: result.directory ? ROUTES.DASHBOARD_DIRECTORY(result.directory.id) : undefined,
        };
    },
});

export const createDirectoryWithAITool = tool({
    description: [
        'Create a directory AND generate content using AI.',
        'BEFORE calling: call checkGitConnection, then listAvailablePipelines to let user choose pipeline/providers.',
        'Pass user provider choices. If not provided, uses defaults.',
    ].join(' '),
    inputSchema: z.object({
        name: z.string().describe('Directory name'),
        prompt: z.string().describe('What the directory should contain'),
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

        const result = await createDirectoryWithAI({
            name,
            prompt,
            gitProvider,
            deployProvider,
            providers: mergedProviders,
            pluginConfig: config.pluginConfig,
        });
        return {
            success: result.success,
            directoryId: result.directory?.id,
            message: result.message,
            isGenerating: result.isGenerating,
            error: result.error,
            url: result.directory ? ROUTES.DASHBOARD_DIRECTORY(result.directory.id) : undefined,
        };
    },
});

export const importDirectoryTool = tool({
    description: [
        'Import a directory from an existing GitHub repository or awesome list URL.',
        'First call analyzeImportSource to check the URL, then import.',
        'REQUIRES git provider — call checkGitConnection first.',
    ].join(' '),
    inputSchema: z.object({
        sourceUrl: z.string().describe('GitHub repository URL or awesome list URL to import'),
        sourceType: z
            .enum(['data_repo', 'awesome_readme', 'link_existing', 'works_config'])
            .describe('Type of import source'),
        name: z.string().describe('Directory name'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
    }),
    execute: async ({ sourceUrl, sourceType, name, gitProvider }) => {
        const result = await importDirectory({ sourceUrl, sourceType, name, gitProvider });
        return {
            success: result.success,
            directoryId: result.directoryId,
            message: result.message,
            error: result.error,
            url: result.directoryId ? ROUTES.DASHBOARD_DIRECTORY(result.directoryId) : undefined,
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

export const updateDirectoryTool = tool({
    description: 'Update a directory name or description.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
    }),
    execute: async ({ directoryId, name, description }) => {
        const result = await updateDirectory(directoryId, { name, description });
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const deleteDirectoryTool = tool({
    description: 'Delete a directory. ALWAYS ask for confirmation before calling this.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID to delete'),
    }),
    execute: async ({ directoryId }) => {
        const result = await deleteDirectory(directoryId);
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const syncDirectory = tool({
    description: 'Sync a directory data repository with the latest changes.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        const result = await syncDirectoryData(directoryId);
        return result ?? { success: false, error: 'Sync failed' };
    },
});
