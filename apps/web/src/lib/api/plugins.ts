import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    PluginResponse,
    UserPluginResponse,
    DirectoryPluginResponse,
    PluginListResponse as IPluginListResponse,
    DirectoryPluginListResponse as IDirectoryPluginListResponse,
    SettingsMenuResponse as ISettingsMenuResponse,
    SettingsMenuCategory as ISettingsMenuCategory,
    SettingsMenuPlugin as ISettingsMenuPlugin,
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
    SettingScopeApi,
} from '@ever-works/plugin/api';

// Type aliases for backward compatibility
export type Plugin = PluginResponse;
export type UserPlugin = UserPluginResponse & {
    metadata?: Record<string, unknown>;
};
export type DirectoryPlugin = DirectoryPluginResponse;
export type PluginListResponse = IPluginListResponse;
export type DirectoryPluginListResponse = IDirectoryPluginListResponse;
export type SettingsMenuResponse = ISettingsMenuResponse;
export type SettingsMenuCategory = ISettingsMenuCategory;
export type SettingsMenuPlugin = ISettingsMenuPlugin;

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

    /**
     * Get plugins grouped by category for settings menu
     * Only returns plugins with user-configurable settings
     */
    listForSettingsMenu: async (): Promise<SettingsMenuResponse> => {
        return serverFetch<SettingsMenuResponse>('/plugins/settings-menu');
    },

    /**
     * List all plugins for a specific category with full details
     * @param category - The plugin category to filter by
     */
    listByCategory: async (category: string): Promise<UserPlugin[]> => {
        const response = await serverFetch<PluginListResponse>(`/plugins?category=${category}`);
        return response.plugins;
    },

    /**
     * List available models for an AI provider plugin
     */
    listModels: async (pluginId: string): Promise<any[]> => {
        try {
            return await serverFetch<any[]>(`/plugins/${pluginId}/models`);
        } catch {
            return [];
        }
    },

    // ============================================
    // User Plugin Management
    // ============================================

    /**
     * Enable a plugin for the current user
     */
    enable: async (
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
            autoEnableForDirectories?: boolean;
        },
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

    /**
     * Validate a user plugin connection after saving credentials.
     */
    validateConnection: async (
        pluginId: string,
    ): Promise<{ success: boolean; message: string; details?: Record<string, unknown> }> => {
        return serverMutation<{ success: boolean; message: string; details?: Record<string, unknown> }>({
            endpoint: `/plugins/${pluginId}/validate-connection`,
            data: {},
            method: 'POST',
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
