import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    PluginCategory,
    PluginState,
    ConfigurationMode,
    PluginAuthor,
    PluginIcon,
} from '@ever-works/plugin';

// Re-export types from @ever-works/plugin for consistency
export type {
    PluginCategory,
    PluginState,
    ConfigurationMode,
    PluginAuthor,
} from '@ever-works/plugin';

// Alias PluginIcon as PluginsApiIcon to avoid conflict with items-generator.ts which also exports PluginIcon
export type { PluginIcon as PluginsApiIcon } from '@ever-works/plugin';

// Local alias for use within this file
type PluginsApiIcon = PluginIcon;

// ============================================
// Types
// ============================================

export interface PluginSettingsSchemaProperty {
    type: string;
    title?: string;
    description?: string;
    default?: unknown;
    secret?: boolean;
    masked?: boolean;
    writeOnly?: boolean;
    enum?: unknown[];
}

export interface PluginSettingsSchema {
    type: 'object';
    title?: string;
    description?: string;
    properties: Record<string, PluginSettingsSchemaProperty>;
    required?: string[];
}

export interface Plugin {
    id: string;
    pluginId: string;
    name: string;
    version: string;
    description?: string;
    category: PluginCategory;
    capabilities: string[];
    configurationMode: ConfigurationMode;
    builtIn: boolean;
    state: PluginState;
    icon?: PluginsApiIcon;
    settingsSchema?: PluginSettingsSchema;
    author?: PluginAuthor;
    homepage?: string;
}

export interface UserPlugin extends Plugin {
    installed: boolean;
    enabled: boolean;
    settings?: Record<string, unknown>;
    userPluginId?: string;
}

export interface DirectoryPlugin extends UserPlugin {
    directoryEnabled: boolean;
    activeCapability?: string;
    directorySettings?: Record<string, unknown>;
    directoryPluginId?: string;
    priority?: number;
}

export interface PluginListResponse {
    plugins: UserPlugin[];
    total: number;
    categories?: PluginCategory[];
    capabilities?: string[];
}

export interface DirectoryPluginListResponse {
    plugins: DirectoryPlugin[];
    total: number;
    capabilityProviders?: Record<string, string>;
}

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
