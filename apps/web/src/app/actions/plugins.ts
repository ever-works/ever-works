'use server';

import { pluginsAPI } from '@/lib/api/plugins';
import { revalidatePath } from 'next/cache';

/**
 * Enable a plugin for the current user
 */
export async function enablePlugin(
    pluginId: string,
    options?: { settings?: Record<string, unknown>; secretSettings?: Record<string, unknown> },
) {
    const result = await pluginsAPI.enable(pluginId, options);
    revalidatePath('/plugins');
    return result;
}

/**
 * Disable a plugin for the current user
 */
export async function disablePlugin(pluginId: string) {
    const result = await pluginsAPI.disable(pluginId);
    revalidatePath('/plugins');
    return result;
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
) {
    const result = await pluginsAPI.updateSettings(pluginId, data);
    revalidatePath('/plugins');
    revalidatePath(`/plugins/${pluginId}`);
    return result;
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
) {
    const result = await pluginsAPI.enableForDirectory(directoryId, pluginId, options);
    revalidatePath(`/directories/${directoryId}/plugins`);
    return result;
}

/**
 * Disable a plugin for a directory
 */
export async function disableDirectoryPlugin(directoryId: string, pluginId: string) {
    const result = await pluginsAPI.disableForDirectory(directoryId, pluginId);
    revalidatePath(`/directories/${directoryId}/plugins`);
    return result;
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
) {
    const result = await pluginsAPI.updateDirectorySettings(directoryId, pluginId, data);
    revalidatePath(`/directories/${directoryId}/plugins`);
    return result;
}

/**
 * Set active capability for a directory plugin
 */
export async function setActiveCapability(
    directoryId: string,
    pluginId: string,
    capability: string,
) {
    const result = await pluginsAPI.setActiveCapability(directoryId, pluginId, capability);
    revalidatePath(`/directories/${directoryId}/plugins`);
    return result;
}
