import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    PluginResponse,
    UserPluginResponse,
    DirectoryPluginResponse,
    PluginListResponse as IPluginListResponse,
    DirectoryPluginListResponse as IDirectoryPluginListResponse,
} from '@ever-works/plugin/api';

// Re-export types from @ever-works/plugin/api for consistency
export type {
    PluginSettingsSchemaProperty,
    PluginSettingsSchema,
    PluginCategory,
    PluginState,
    ConfigurationMode,
    PluginAuthor,
    PluginIcon as PluginsApiIcon,
} from '@ever-works/plugin/api';

// Type aliases for backward compatibility
export type Plugin = PluginResponse;
export type UserPlugin = UserPluginResponse;
export type DirectoryPlugin = DirectoryPluginResponse;
export type PluginListResponse = IPluginListResponse;
export type DirectoryPluginListResponse = IDirectoryPluginListResponse;

// ============================================
// API Client
// ============================================

export const pluginsAPI = {
    // ============================================
    // Plugin Listing
    // ============================================

    /**
     * List all available plugins with user-specific status
     */
    list: async (): Promise<PluginListResponse> => {
        return serverFetch<PluginListResponse>('/plugins');
    },

    /**
     * Get a single plugin by ID with user-specific status
     */
    get: async (pluginId: string): Promise<UserPlugin> => {
        return serverFetch<UserPlugin>(`/plugins/${pluginId}`);
    },

    // ============================================
    // User Plugin Management
    // ============================================

    /**
     * Enable a plugin for the current user
     */
    enable: async (
        pluginId: string,
        data?: { settings?: Record<string, unknown>; secretSettings?: Record<string, unknown> },
    ): Promise<UserPlugin> => {
        return serverMutation<UserPlugin>({
            endpoint: `/plugins/${pluginId}/enable`,
            data: data || {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Disable a plugin for the current user
     */
    disable: async (pluginId: string): Promise<UserPlugin> => {
        return serverMutation<UserPlugin>({
            endpoint: `/plugins/${pluginId}/disable`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Update user plugin settings
     */
    updateSettings: async (
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
            metadata?: Record<string, unknown>;
        },
    ): Promise<UserPlugin> => {
        return serverMutation<UserPlugin>({
            endpoint: `/plugins/${pluginId}/settings`,
            data,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    // ============================================
    // Directory Plugin Management
    // ============================================

    /**
     * List plugins for a directory with directory-specific status
     */
    listForDirectory: async (directoryId: string): Promise<DirectoryPluginListResponse> => {
        return serverFetch<DirectoryPluginListResponse>(`/directories/${directoryId}/plugins`);
    },

    /**
     * Enable a plugin for a directory
     */
    enableForDirectory: async (
        directoryId: string,
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            activeCapability?: string;
            priority?: number;
        },
    ): Promise<DirectoryPlugin> => {
        return serverMutation<DirectoryPlugin>({
            endpoint: `/directories/${directoryId}/plugins/${pluginId}/enable`,
            data: data || {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Disable a plugin for a directory
     */
    disableForDirectory: async (
        directoryId: string,
        pluginId: string,
    ): Promise<DirectoryPlugin> => {
        return serverMutation<DirectoryPlugin>({
            endpoint: `/directories/${directoryId}/plugins/${pluginId}/disable`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Update directory plugin settings
     */
    updateDirectorySettings: async (
        directoryId: string,
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
            metadata?: Record<string, unknown>;
        },
    ): Promise<DirectoryPlugin> => {
        return serverMutation<DirectoryPlugin>({
            endpoint: `/directories/${directoryId}/plugins/${pluginId}/settings`,
            data,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /**
     * Set active capability for a directory plugin
     */
    setActiveCapability: async (
        directoryId: string,
        pluginId: string,
        capability: string,
    ): Promise<DirectoryPlugin> => {
        return serverMutation<DirectoryPlugin>({
            endpoint: `/directories/${directoryId}/plugins/${pluginId}/capability`,
            data: { capability },
            method: 'POST',
            wrapInData: false,
        });
    },
};
