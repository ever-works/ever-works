import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { directoryAPI, type Directory } from '@/lib/api/directory';

export const listDirectories = tool({
    description:
        'List all directories the user has access to. Returns names, slugs, item counts, and status.',
    inputSchema: z.object({
        search: z
            .string()
            .optional()
            .describe('Optional search query to filter directories by name'),
        limit: z.number().optional().describe('Max number of directories to return (default 20)'),
        offset: z.number().optional().describe('Offset for pagination (default 0)'),
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
                status: d.generateStatus?.status ?? 'idle',
                url: ROUTES.DASHBOARD_DIRECTORY(d.id),
            })),
            total: result.total,
            hasMore: (offset ?? 0) + (limit ?? 20) < result.total,
        };
    },
});

export const getDirectoryDetails = tool({
    description:
        'Get detailed information about a specific directory including config, item count, and generation status.',
    inputSchema: z.object({
        directoryId: z.string().describe('The directory ID to get details for'),
    }),
    execute: async ({ directoryId }) => {
        const { directory } = await directoryAPI.get(directoryId);
        return {
            id: directory.id,
            name: directory.name,
            slug: directory.slug,
            description: directory.description,
            itemsCount: directory.itemsCount ?? 0,
            status: directory.generateStatus?.status ?? 'idle',
            gitProvider: directory.gitProvider,
            deployProvider: directory.deployProvider,
            url: ROUTES.DASHBOARD_DIRECTORY(directory.id),
            itemsUrl: ROUTES.DASHBOARD_DIRECTORY_ITEMS(directory.id),
            generatorUrl: ROUTES.DASHBOARD_DIRECTORY_GENERATOR(directory.id),
        };
    },
});

export const getDirectoryStats = tool({
    description:
        'Get aggregated statistics across all user directories — total directories, items, active websites.',
    inputSchema: z.object({}),
    execute: async () => {
        return directoryAPI.getStats();
    },
});
