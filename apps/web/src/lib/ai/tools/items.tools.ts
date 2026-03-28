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
import { directoryAPI } from '@/lib/api/directory';
import { resolveGenerationConfig } from './utils';

export const addItemTool = tool({
    description: 'Add a single item to a directory from a URL. Extracts details automatically.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
        sourceUrl: z.string().describe('URL of the item to add'),
    }),
    execute: async ({ directoryId, sourceUrl }) => {
        const extracted = await extractItemDetails(sourceUrl);
        if (!extracted.success || !extracted.data) {
            return { success: false, error: extracted.error ?? 'Failed to extract item details' };
        }

        const data = extracted.data;
        const result = await addItem(directoryId, {
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
    description: 'Remove an item from a directory. Ask for confirmation first.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
        itemSlug: z.string().describe('Item slug to remove'),
        reason: z.string().optional().describe('Reason for removal'),
    }),
    execute: async ({ directoryId, itemSlug, reason }) => {
        const result = await removeItem(directoryId, itemSlug, { reason });
        return { success: result.status === 'success', message: result.message };
    },
});

export const updateItemTool = tool({
    description:
        'Update an item — toggle featured status, change source URL, or set display order.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
        itemSlug: z.string().describe('Item slug to update'),
        sourceUrl: z.string().optional().describe('New source URL'),
        featured: z.boolean().optional().describe('Whether item is featured'),
        order: z.number().optional().describe('Display order'),
    }),
    execute: async ({ directoryId, itemSlug, sourceUrl, featured, order }) => {
        const result = await updateItem(directoryId, {
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
        'Generate or regenerate items for a directory.',
        'For first-time: call listAvailablePipelines first to let user choose pipeline and providers.',
        'For retries: just pass directoryId — reuses the previous config automatically.',
        'Requires git provider connection.',
    ].join(' '),
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
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
    execute: async ({ directoryId, prompt, providers: userProviders }) => {
        const [dirResponse, configResponse] = await Promise.all([
            directoryAPI.get(directoryId).catch(() => null),
            directoryAPI.getConfig(directoryId).catch(() => null),
        ]);

        const directoryName = dirResponse?.directory?.name ?? '';
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
            const genConfig = await resolveGenerationConfig(directoryId);
            finalProviders = genConfig.providers;
        }

        const result = await generateItems(directoryId, {
            name: directoryName,
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
        directoryId: z.string().describe('Directory ID'),
        itemSlug: z.string().describe('Item slug to check'),
    }),
    execute: async ({ directoryId, itemSlug }) => {
        const result = await checkItemHealth(directoryId, itemSlug);
        return { status: result.status, message: result.message };
    },
});

export const regenerateMarkdownTool = tool({
    description: 'Regenerate the markdown README for a directory.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        const result = await regenerateMarkdown(directoryId);
        return { success: result.success, message: result.message, error: result.error };
    },
});
