'use server';

import { pluginsAPI } from '@/lib/api/plugins';
import { revalidatePath } from 'next/cache';

export interface ActionResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

/**
 * Enable a plugin for the current user
 */
export async function enablePlugin(
    pluginId: string,
    options?: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
        autoEnableForDirectories?: boolean;
    },
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.enable(pluginId, options);
        revalidatePath('/plugins');
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to enable plugin:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to enable plugin',
        };
    }
}

/**
 * Disable a plugin for the current user
 */
export async function disablePlugin(pluginId: string): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.disable(pluginId);
        revalidatePath('/plugins');
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to disable plugin:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disable plugin',
        };
    }
}

/**
 * Update plugin settings for the current user
 */
export async function updatePluginSettings(
    pluginId: string,
    data: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
    },
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.updateSettings(pluginId, data);
        revalidatePath('/plugins');
        revalidatePath(`/plugins/${pluginId}`);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to update plugin settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update plugin settings',
        };
    }
}

export async function validatePluginConnection(pluginId: string): Promise<ActionResult<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
}>> {
    try {
        const result = await pluginsAPI.validateConnection(pluginId);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to validate plugin connection:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to validate plugin connection',
        };
    }
}

/**
 * Enable a plugin for a directory
 */
export async function enableDirectoryPlugin(
    directoryId: string,
    pluginId: string,
    options?: {
        settings?: Record<string, unknown>;
        activeCapability?: string;
        priority?: number;
    },
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.enableForDirectory(directoryId, pluginId, options);
        revalidatePath(`/directories/${directoryId}/plugins`);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to enable directory plugin:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to enable directory plugin',
        };
    }
}

/**
 * Disable a plugin for a directory
 */
export async function disableDirectoryPlugin(
    directoryId: string,
    pluginId: string,
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.disableForDirectory(directoryId, pluginId);
        revalidatePath(`/directories/${directoryId}/plugins`);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to disable directory plugin:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disable directory plugin',
        };
    }
}

/**
 * Update directory plugin settings
 */
export async function updateDirectoryPluginSettings(
    directoryId: string,
    pluginId: string,
    data: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
    },
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.updateDirectorySettings(directoryId, pluginId, data);
        revalidatePath(`/directories/${directoryId}/plugins`);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to update directory plugin settings:', error);
        return {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : 'Failed to update directory plugin settings',
        };
    }
}

/**
 * List available models for an AI provider plugin
 */
export async function fetchModels(pluginId: string): Promise<ActionResult<any[]>> {
    try {
        const result = await pluginsAPI.listModels(pluginId);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to fetch models:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch models',
        };
    }
}

/**
 * Set active capability for a directory plugin
 */
export async function setActiveCapability(
    directoryId: string,
    pluginId: string,
    capability: string,
): Promise<ActionResult> {
    try {
        const result = await pluginsAPI.setActiveCapability(directoryId, pluginId, capability);
        revalidatePath(`/directories/${directoryId}/plugins`);
        return { success: true, data: result };
    } catch (error) {
        console.error('Failed to set active capability:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to set active capability',
        };
    }
}
