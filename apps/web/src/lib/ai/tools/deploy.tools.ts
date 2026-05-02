import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { deploy, lookupExistingDeployment, getDomains } from '@/app/actions/dashboard/deploy';
import { deployAPI } from '@/lib/api/plugins-capabilities/deploy';

export const checkDeployConnection = tool({
    description: [
        'Check if a deploy provider is available and configured. Call before deploying.',
        'Returns available providers and whether the specified one is ready.',
    ].join(' '),
    inputSchema: z.object({
        providerId: z
            .string()
            .optional()
            .describe('Deploy provider ID to check (default: first available)'),
    }),
    execute: async ({ providerId }) => {
        try {
            const { providers } = await deployAPI.getProviders();
            const target = providerId ?? providers[0]?.id;

            if (!target) {
                return {
                    configured: false,
                    available: false,
                    providers: [],
                    setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('deploy'),
                };
            }

            const configResult = await deployAPI.isProviderConfigured(target);
            return {
                providerId: target,
                configured: configResult.configured,
                available: configResult.available,
                providers: providers.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('deploy'),
            };
        } catch {
            return {
                configured: false,
                available: false,
                providers: [],
                setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('deploy'),
            };
        }
    },
});

export const deployDirectory = tool({
    description: [
        "Deploy a Work's website. Check deploy provider connection first with checkDeployConnection.",
        'Also check git connection with checkGitConnection — both are required.',
    ].join(' '),
    inputSchema: z.object({
        directoryId: z.string().describe('Work ID to deploy'),
    }),
    execute: async ({ directoryId }) => {
        const result = await deploy(directoryId);
        return {
            success: result.success,
            message: result.data?.message ?? result.error,
            requiresGitProvider: result.requiresGitProvider,
        };
    },
});

export const checkDeploymentStatus = tool({
    description: 'Check if a Work has an existing deployment.',
    inputSchema: z.object({
        directoryId: z.string().describe('Work ID to check'),
    }),
    execute: async ({ directoryId }) => {
        const result = await lookupExistingDeployment(directoryId);
        return {
            found: result.found,
            website: result.website,
            state: result.deploymentState,
        };
    },
});

export const listDomains = tool({
    description: 'List custom domains for a deployed Work.',
    inputSchema: z.object({
        directoryId: z.string().describe('Work ID'),
    }),
    execute: async ({ directoryId }) => {
        const result = await getDomains(directoryId);
        return { domains: result.domains ?? [] };
    },
});
