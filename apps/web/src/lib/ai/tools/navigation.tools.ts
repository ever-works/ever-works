import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';

const PAGE_OPTIONS = [
    'dashboard',
    'directories',
    'new-directory',
    'plugins',
    'settings',
    'settings-security',
    'settings-api-keys',
    'settings-git',
    'settings-ai',
] as const;

const TAB_OPTIONS = [
    'overview',
    'items',
    'generator',
    'history',
    'deploy',
    'members',
    'settings',
    'plugins',
    'schedule',
    'comparisons',
] as const;

const pageRoutes: Record<(typeof PAGE_OPTIONS)[number], string> = {
    dashboard: ROUTES.DASHBOARD,
    directories: ROUTES.DASHBOARD_DIRECTORIES,
    'new-directory': ROUTES.DASHBOARD_DIRECTORIES_NEW,
    plugins: ROUTES.DASHBOARD_PLUGINS,
    settings: ROUTES.DASHBOARD_SETTINGS,
    'settings-security': ROUTES.DASHBOARD_SETTINGS_SECURITY,
    'settings-api-keys': ROUTES.DASHBOARD_SETTINGS_API_KEYS,
    'settings-git': ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
    'settings-ai': ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('ai-provider'),
};

const tabRoutes: Record<(typeof TAB_OPTIONS)[number], (id: string) => string> = {
    overview: ROUTES.DASHBOARD_DIRECTORY,
    items: ROUTES.DASHBOARD_DIRECTORY_ITEMS,
    generator: ROUTES.DASHBOARD_DIRECTORY_GENERATOR,
    history: ROUTES.DASHBOARD_DIRECTORY_HISTORY,
    deploy: ROUTES.DASHBOARD_DIRECTORY_DEPLOY,
    members: ROUTES.DASHBOARD_DIRECTORY_MEMBERS,
    settings: ROUTES.DASHBOARD_DIRECTORY_SETTINGS,
    plugins: ROUTES.DASHBOARD_DIRECTORY_PLUGINS,
    schedule: ROUTES.DASHBOARD_DIRECTORY_SCHEDULE,
    comparisons: ROUTES.DASHBOARD_DIRECTORY_COMPARISONS,
};

export const navigate = tool({
    description:
        'Navigate the user to a specific page in the dashboard. Use this when the user asks to see, view, or go to something.',
    inputSchema: z.object({
        page: z.enum(PAGE_OPTIONS).describe('The page to navigate to'),
        directoryId: z
            .string()
            .optional()
            .describe('Directory ID (required for directory-specific pages)'),
        tab: z.enum(TAB_OPTIONS).optional().describe('Directory tab to navigate to'),
        query: z.record(z.string()).optional().describe('Query parameters to append to the URL'),
    }),
    execute: async ({ page, directoryId, tab, query }) => {
        let url = pageRoutes[page] ?? ROUTES.DASHBOARD;

        if (directoryId && tab) {
            const routeFn = tabRoutes[tab];
            if (routeFn) url = routeFn(directoryId);
        } else if (directoryId) {
            url = ROUTES.DASHBOARD_DIRECTORY(directoryId);
        }

        if (query) {
            const params = new URLSearchParams(query).toString();
            if (params) url += `?${params}`;
        }

        return { url, action: 'navigate' };
    },
});
