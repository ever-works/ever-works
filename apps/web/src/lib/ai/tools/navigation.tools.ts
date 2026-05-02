import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';

const PAGE_OPTIONS = [
    'dashboard',
    'works',
    'new-work',
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
    works: ROUTES.DASHBOARD_WORKS,
    'new-work': ROUTES.DASHBOARD_WORKS_NEW,
    plugins: ROUTES.DASHBOARD_PLUGINS,
    settings: ROUTES.DASHBOARD_SETTINGS,
    'settings-security': ROUTES.DASHBOARD_SETTINGS_SECURITY,
    'settings-api-keys': ROUTES.DASHBOARD_SETTINGS_API_KEYS,
    'settings-git': ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
    'settings-ai': ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('ai-provider'),
};

const tabRoutes: Record<(typeof TAB_OPTIONS)[number], (id: string) => string> = {
    overview: ROUTES.DASHBOARD_WORK,
    items: ROUTES.DASHBOARD_WORK_ITEMS,
    generator: ROUTES.DASHBOARD_WORK_GENERATOR,
    history: ROUTES.DASHBOARD_WORK_HISTORY,
    deploy: ROUTES.DASHBOARD_WORK_DEPLOY,
    members: ROUTES.DASHBOARD_WORK_MEMBERS,
    settings: ROUTES.DASHBOARD_WORK_SETTINGS,
    plugins: ROUTES.DASHBOARD_WORK_PLUGINS,
    schedule: ROUTES.DASHBOARD_WORK_SCHEDULE,
    comparisons: ROUTES.DASHBOARD_WORK_COMPARISONS,
};

export const navigate = tool({
    description: [
        'Navigate the user to a page with optional search query.',
        'ALWAYS use this after fetching data — redirect to the relevant page so the user sees it.',
        'For Works list: use page="works" with search to filter.',
        'For items in a Work: use workId + tab="items" with search to filter.',
        'The UI handles the redirect. Do NOT output any text after calling this tool.',
    ].join(' '),
    inputSchema: z.object({
        page: z.enum(PAGE_OPTIONS).describe('The page to navigate to'),
        workId: z.string().optional().describe('Work ID for Work-specific pages'),
        tab: z.enum(TAB_OPTIONS).optional().describe('Work tab to navigate to'),
        search: z
            .string()
            .optional()
            .describe('Search query to pre-fill on the target page (passed as ?q=...)'),
    }),
    execute: async ({ page, workId, tab, search }) => {
        let url = pageRoutes[page] ?? ROUTES.DASHBOARD;

        if (workId && tab) {
            const routeFn = tabRoutes[tab];
            if (routeFn) url = routeFn(workId);
        } else if (workId) {
            url = ROUTES.DASHBOARD_WORK(workId);
        }

        if (search) {
            url += `?q=${encodeURIComponent(search)}`;
        }

        return { url, navigated: true };
    },
});

export const reloadPage = tool({
    description:
        'Reload the current page to reflect changes after an action (create, deploy, delete, etc.). Use after mutations.',
    inputSchema: z.object({}),
    execute: async () => {
        return { action: 'reload' };
    },
});
