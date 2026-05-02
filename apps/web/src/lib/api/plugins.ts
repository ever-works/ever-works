import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    PluginResponse,
    UserPluginResponse,
    WorkPluginResponse,
    PluginListResponse as IPluginListResponse,
    WorkPluginListResponse as IWorkPluginListResponse,
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
    resolvedSettings?: Record<string, unknown>;
};
export type WorkPlugin = WorkPluginResponse;
export type PluginListResponse = IPluginListResponse;
export type WorkPluginListResponse = IWorkPluginListResponse;
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
            autoEnableForWorks?: boolean;
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
        return serverMutation<{
            success: boolean;
            message: string;
            details?: Record<string, unknown>;
        }>({
            endpoint: `/plugins/${pluginId}/validate-connection`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // ============================================
    // Work Plugin Management
    // ============================================

    /**
     * List plugins for a work with work-specific status
     */
    listForWork: async (workId: string): Promise<WorkPluginListResponse> => {
        return serverFetch<WorkPluginListResponse>(`/works/${workId}/plugins`);
    },

    /**
     * Enable a plugin for a work
     */
    enableForWork: async (
        workId: string,
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            activeCapability?: string;
            priority?: number;
        },
    ): Promise<WorkPlugin> => {
        return serverMutation<WorkPlugin>({
            endpoint: `/works/${workId}/plugins/${pluginId}/enable`,
            data: data || {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Disable a plugin for a work
     */
    disableForWork: async (workId: string, pluginId: string): Promise<WorkPlugin> => {
        return serverMutation<WorkPlugin>({
            endpoint: `/works/${workId}/plugins/${pluginId}/disable`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Update work plugin settings
     */
    updateWorkSettings: async (
        workId: string,
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
            metadata?: Record<string, unknown>;
        },
    ): Promise<WorkPlugin> => {
        return serverMutation<WorkPlugin>({
            endpoint: `/works/${workId}/plugins/${pluginId}/settings`,
            data,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /**
     * Set or clear the global default pipeline for the current user
     */
    setGlobalPipelineDefault: async (pluginId: string | null, enforce: boolean): Promise<void> => {
        await serverMutation<void>({
            endpoint: '/plugins/pipeline-default',
            data: { pluginId, enforce },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Set active capability for a work plugin
     */
    setActiveCapability: async (
        workId: string,
        pluginId: string,
        capability: string,
    ): Promise<WorkPlugin> => {
        return serverMutation<WorkPlugin>({
            endpoint: `/works/${workId}/plugins/${pluginId}/capability`,
            data: { capability },
            method: 'POST',
            wrapInData: false,
        });
    },
};
