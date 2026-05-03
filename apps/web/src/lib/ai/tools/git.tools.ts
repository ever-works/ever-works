import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { gitProvidersAPI } from '@/lib/api/plugins-capabilities/git-providers';

export const checkGitConnection = tool({
    description: [
        'Check if user has a connected git provider. MUST call before Work creation, import, or generation.',
        'If not connected, tell user to connect — the result includes a setupUrl.',
    ].join(' '),
    inputSchema: z.object({
        providerId: z.string().optional().describe('Git provider ID (default: github)'),
    }),
    execute: async ({ providerId }) => {
        const id = providerId ?? 'github';
        try {
            const info = await gitProvidersAPI.checkConnection(id);

            let availableProviders: Array<{ id: string; name: string }> = [];
            if (!info.connected) {
                try {
                    const { providers } = await gitProvidersAPI.list();
                    availableProviders = providers.map((p) => ({ id: p.id, name: p.name }));
                } catch {
                    /* ignore */
                }
            }

            return {
                providerId: id,
                connected: info.connected,
                username: info.username ?? null,
                availableProviders,
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
            };
        } catch {
            return {
                providerId: id,
                connected: false,
                username: null,
                availableProviders: [],
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git'),
            };
        }
    },
});

export const listGitProviders = tool({
    description:
        'List all available git providers with connection status. Use to find which provider the user has.',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const { providers } = await gitProvidersAPI.list();
            const results = await Promise.all(
                providers.map(async (p) => {
                    try {
                        const conn = await gitProvidersAPI.checkConnection(p.id);
                        return {
                            id: p.id,
                            name: p.name,
                            connected: conn.connected,
                            username: conn.username,
                        };
                    } catch {
                        return { id: p.id, name: p.name, connected: false, username: null };
                    }
                }),
            );
            return { providers: results };
        } catch {
            return { providers: [] };
        }
    },
});
