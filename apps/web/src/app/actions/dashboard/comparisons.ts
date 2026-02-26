'use server';

import { directoryAPI, pluginsAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { getFormSchema } from './generator-form';

export async function listComparisons(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return await directoryAPI.getComparisons(directoryId);
    } catch (error) {
        console.error('List comparisons error:', error);
        return [];
    }
}

export async function getRemainingComparisonCount(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return await directoryAPI.getRemainingComparisonCount(directoryId);
    } catch (error) {
        console.error('Get remaining comparison count error:', error);
        return { count: 0 };
    }
}

export async function generateNextComparison(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.generateNextComparison(directoryId);

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Generate comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to generate comparison',
        };
    }
}

export async function generateManualComparison(
    directoryId: string,
    itemASlug: string,
    itemBSlug: string,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.generateManualComparison(
            directoryId,
            itemASlug,
            itemBSlug,
        );

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Generate manual comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to generate comparison',
        };
    }
}

export async function deleteComparison(directoryId: string, slug: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.deleteComparison(directoryId, slug);

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Delete comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to delete comparison',
        };
    }
}

export async function getComparisonAiConfig(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const [dirPlugins, schemaResult] = await Promise.all([
            pluginsAPI.listForDirectory(directoryId),
            getFormSchema(directoryId),
        ]);

        const compPlugin = dirPlugins.plugins.find((p) => p.id === 'comparison-generator');
        const settings = compPlugin?.directorySettings ?? {};

        const availableProviders =
            schemaResult.success && schemaResult.data?.providers?.ai
                ? schemaResult.data.providers.ai
                : [];

        return {
            currentConfig: {
                provider: (settings.ai_provider as string) || null,
                model: (settings.ai_model as string) || null,
                customPrompt: (settings.custom_prompt as string) || null,
                extendedAnalysis: !!settings.extended_analysis,
            },
            availableProviders,
        };
    } catch (error) {
        console.error('Get comparison AI config error:', error);
        return {
            currentConfig: {
                provider: null,
                model: null,
                customPrompt: null,
                extendedAnalysis: false,
            },
            availableProviders: [],
        };
    }
}

export async function saveComparisonAiConfig(
    directoryId: string,
    config: { provider: string | null; model: string | null; extendedAnalysis?: boolean },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        // Read existing settings to preserve custom_prompt
        const dirPlugins = await pluginsAPI.listForDirectory(directoryId);
        const compPlugin = dirPlugins.plugins.find((p) => p.id === 'comparison-generator');
        const existing = compPlugin?.directorySettings ?? {};

        await pluginsAPI.updateDirectorySettings(directoryId, 'comparison-generator', {
            settings: {
                ...existing,
                ai_provider: config.provider || null,
                ai_model: config.model || null,
                extended_analysis: config.extendedAnalysis ?? false,
            },
        });

        revalidatePath(`/directories/${directoryId}/comparisons`);
        return { success: true };
    } catch (error: any) {
        // If plugin not enabled for directory, enable it first then retry
        if (error?.status === 404 || error?.statusCode === 404) {
            try {
                await pluginsAPI.enableForDirectory(directoryId, 'comparison-generator', {
                    settings: {
                        ai_provider: config.provider || null,
                        ai_model: config.model || null,
                        extended_analysis: config.extendedAnalysis ?? false,
                    },
                });
                revalidatePath(`/directories/${directoryId}/comparisons`);
                return { success: true };
            } catch (retryError) {
                console.error('Enable + save comparison AI config error:', retryError);
                return {
                    success: false,
                    error:
                        retryError instanceof Error
                            ? retryError.message
                            : 'Failed to save AI config',
                };
            }
        }

        console.error('Save comparison AI config error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save AI config',
        };
    }
}

export async function saveComparisonCustomPrompt(directoryId: string, customPrompt: string | null) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        // Read existing settings to preserve ai_provider/ai_model
        const dirPlugins = await pluginsAPI.listForDirectory(directoryId);
        const compPlugin = dirPlugins.plugins.find((p) => p.id === 'comparison-generator');
        const existing = compPlugin?.directorySettings ?? {};

        await pluginsAPI.updateDirectorySettings(directoryId, 'comparison-generator', {
            settings: {
                ...existing,
                custom_prompt: customPrompt || null,
            },
        });

        revalidatePath(`/directories/${directoryId}/settings`);
        return { success: true };
    } catch (error: any) {
        if (error?.status === 404 || error?.statusCode === 404) {
            try {
                await pluginsAPI.enableForDirectory(directoryId, 'comparison-generator', {
                    settings: {
                        custom_prompt: customPrompt || null,
                    },
                });
                revalidatePath(`/directories/${directoryId}/settings`);
                return { success: true };
            } catch (retryError) {
                console.error('Enable + save comparison custom prompt error:', retryError);
                return {
                    success: false,
                    error:
                        retryError instanceof Error
                            ? retryError.message
                            : 'Failed to save comparison prompt',
                };
            }
        }

        console.error('Save comparison custom prompt error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save comparison prompt',
        };
    }
}

export async function getAiProviderModels(pluginId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return await pluginsAPI.listModels(pluginId);
    } catch (error) {
        console.error('Get AI provider models error:', error);
        return [];
    }
}
