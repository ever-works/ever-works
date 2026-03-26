import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { gitProvidersAPI } from '@/lib/api/plugins-capabilities/git-providers';

export const checkGitConnection = tool({
    description:
        'Check if the user has connected a git provider (GitHub, GitLab, etc.). This must be verified before creating directories.',
    inputSchema: z.object({
        providerId: z.string().optional().describe('Git provider ID to check (default: github)'),
    }),
    execute: async ({ providerId }) => {
        const id = providerId ?? 'github';
        try {
            const info = await gitProvidersAPI.checkConnection(id);
            return {
                providerId: id,
                connected: info.connected,
                username: info.username ?? null,
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
            };
        } catch {
            return {
                providerId: id,
                connected: false,
                username: null,
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
            };
        }
    },
});
