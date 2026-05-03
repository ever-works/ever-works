import { z } from 'zod';
import { tool } from 'ai';
import {
    addItem,
    extractItemDetails,
    removeItem,
    updateItem,
    checkItemHealth,
} from '@/app/actions/dashboard/items';
import { generateItems, regenerateMarkdown } from '@/app/actions/dashboard/generator';
import { workAPI } from '@/lib/api/work';
import { resolveGenerationConfig } from './utils';

export const addItemTool = tool({
    description: 'Add a single item to a Work from a URL. Extracts details automatically.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        sourceUrl: z.string().describe('URL of the item to add'),
    }),
    execute: async ({ workId, sourceUrl }) => {
        const extracted = await extractItemDetails(sourceUrl);
        if (!extracted.success || !extracted.data) {
            return { success: false, error: extracted.error ?? 'Failed to extract item details' };
        }

        const data = extracted.data;
        const result = await addItem(workId, {
            name: data.name,
            description: data.description,
            category: data.category,
            tags: [...data.tags],
            source_url: sourceUrl,
            brand: data.brand,
            brand_logo_url: data.brand_logo_url,
            images: data.images ? [...data.images] : [],
        });

        return {
            success: result.status === 'success',
            message: result.message,
            itemSlug: result.item_slug,
        };
    },
});

export const removeItemTool = tool({
    description: 'Remove an item from a Work. Ask for confirmation first.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        itemSlug: z.string().describe('Item slug to remove'),
        reason: z.string().optional().describe('Reason for removal'),
    }),
    execute: async ({ workId, itemSlug, reason }) => {
        const result = await removeItem(workId, itemSlug, { reason });
        return { success: result.status === 'success', message: result.message };
    },
});

export const updateItemTool = tool({
    description:
        'Update an item — toggle featured status, change source URL, or set display order.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        itemSlug: z.string().describe('Item slug to update'),
        sourceUrl: z.string().optional().describe('New source URL'),
        featured: z.boolean().optional().describe('Whether item is featured'),
        order: z.number().optional().describe('Display order'),
    }),
    execute: async ({ workId, itemSlug, sourceUrl, featured, order }) => {
        const result = await updateItem(workId, {
            item_slug: itemSlug,
            source_url: sourceUrl,
            featured,
            order,
        });
        return { success: result.status === 'success', message: result.message };
    },
});

export const generateItemsTool = tool({
    description: [
        'Generate or regenerate items for a Work.',
        'For first-time: call listAvailablePipelines first to let user choose pipeline and providers.',
        'For retries: just pass workId — reuses the previous config automatically.',
        'Requires git provider connection.',
    ].join(' '),
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        prompt: z
            .string()
            .optional()
            .describe('What to generate. If omitted, reuses the original prompt.'),
        providers: z
            .record(z.string())
            .optional()
            .describe(
                'Provider selections from user (e.g., { pipeline: "sim-ai", ai: "openrouter" }). Pass what the user chose from listAvailablePipelines.',
            ),
    }),
    execute: async ({ workId, prompt, providers: userProviders }) => {
        const [dirResponse, configResponse] = await Promise.all([
            workAPI.get(workId).catch(() => null),
            workAPI.getConfig(workId).catch(() => null),
        ]);

        const workName = dirResponse?.work?.name ?? '';
        const existingPrompt = configResponse?.config?.metadata?.initial_prompt;
        const resolvedPrompt = prompt || existingPrompt || '';

        if (!resolvedPrompt) {
            return {
                success: false,
                error: 'No prompt provided and no previous prompt found. Please provide a prompt.',
            };
        }

        // For retries: reuse last config. For new: use user choices or resolve defaults.
        const lastRequest = configResponse?.config?.metadata?.last_request_data;
        const resolvedProviders = userProviders ?? lastRequest?.providers;
        const resolvedPluginConfig = lastRequest?.pluginConfig;

        // If no providers at all, resolve defaults
        let finalProviders = resolvedProviders;
        if (!finalProviders) {
            const genConfig = await resolveGenerationConfig(workId);
            finalProviders = genConfig.providers;
        }

        const result = await generateItems(workId, {
            name: workName,
            prompt: resolvedPrompt,
            generation_method: undefined,
            providers: finalProviders,
            pluginConfig: resolvedPluginConfig,
        });

        return {
            success: result.success,
            message: result.message,
            error: result.error,
            requiresGitProvider: result.requiresGitProvider,
        };
    },
});

export const checkItemHealthTool = tool({
    description: 'Check if an item source URL is still accessible and valid.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        itemSlug: z.string().describe('Item slug to check'),
    }),
    execute: async ({ workId, itemSlug }) => {
        const result = await checkItemHealth(workId, itemSlug);
        return { status: result.status, message: result.message };
    },
});

export const regenerateMarkdownTool = tool({
    description: 'Regenerate the markdown README for a Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const result = await regenerateMarkdown(workId);
        return { success: result.success, message: result.message, error: result.error };
    },
});
