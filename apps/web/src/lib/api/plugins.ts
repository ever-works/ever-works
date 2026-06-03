import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    PluginConnectionStatus,
    PluginResponse,
    UserPluginResponse,
    WorkPluginResponse,
    PluginListResponse as IPluginListResponse,
    WorkPluginListResponse as IWorkPluginListResponse,
    SettingsMenuResponse as ISettingsMenuResponse,
    SettingsMenuCategory as ISettingsMenuCategory,
    SettingsMenuPlugin as ISettingsMenuPlugin,
} from '@ever-works/plugin/api';
// EW-693 — dynamic plugin distribution wire-types.
import type {
    PluginCatalogResponse,
    PluginInstallRequestDto,
    PluginInstallResponseDto,
    PluginInstallStateDto,
    PluginAllowlistResponseDto,
    PluginAllowlistEntryDto,
    CreatePluginAllowlistEntryDto,
    UpdatePluginAllowlistEntryDto,
} from '@ever-works/contracts';

// Re-export the EW-693 wire-types so page components can import them
// from this single barrel instead of pulling @ever-works/contracts in
// directly. Matches the pattern used for @ever-works/plugin/api above.
export type {
    PluginCatalogResponse,
    PluginCatalogEntry,
    PluginInstallRequestDto,
    PluginInstallResponseDto,
    PluginInstallStateDto,
    PluginInstallState,
    PluginInstallSource,
    PluginAllowlistResponseDto,
    PluginAllowlistEntryDto,
    CreatePluginAllowlistEntryDto,
    UpdatePluginAllowlistEntryDto,
} from '@ever-works/contracts';

// Re-export types from @ever-works/plugin/api for consistency
export type {
    PluginConnectionStatus,
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
        // Security: use URLSearchParams to prevent query-string injection via special chars (& # ?) in category
        const params = new URLSearchParams({ category });
        const response = await serverFetch<PluginListResponse>(`/plugins?${params.toString()}`);
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

    /**
     * Probe one plugin's connection status on demand. Returns the
     * same shape the list endpoint used to embed per-plugin
     * eagerly — call this from settings drawers or a "test
     * connection" button so the list response itself can stay fast.
     */
    getConnectionStatus: async (pluginId: string): Promise<PluginConnectionStatus | null> => {
        try {
            const response = await serverFetch<{
                connectionStatus: PluginConnectionStatus | null | undefined;
            }>(`/plugins/${pluginId}/connection-status`);
            return response.connectionStatus ?? null;
        } catch {
            return null;
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

    // ============================================
    // EW-693 — Dynamic plugin distribution
    // ============================================

    /**
     * EW-693 — List distributable plugins merged with this replica's
     * install state. Returns `degraded: true` when the catalog is
     * empty (e.g. bundled-mode deployment where every plugin is
     * already in the image). UI gracefully degrades to "nothing to
     * install at runtime".
     */
    getCatalog: async (): Promise<PluginCatalogResponse> => {
        return serverFetch<PluginCatalogResponse>('/plugins/catalog');
    },

    /**
     * EW-693 — Per-plugin install lifecycle row. Distinct from the
     * enable state. The UI uses this to poll after `install()` until
     * `installState === 'installed' | 'error'`.
     */
    getInstallStatus: async (pluginId: string): Promise<PluginInstallStateDto> => {
        return serverFetch<PluginInstallStateDto>(`/plugins/${pluginId}/install-status`);
    },

    /**
     * EW-693 — Install a distributable plugin (allow-list + integrity
     * verified server-side). The server enforces FR-10 / FR-11; the
     * client just surfaces the result envelope.
     *
     * Returns 200 with the post-install state envelope. Errors surface
     * as thrown exceptions via `serverFetch`:
     * - 409: plugin not on the allowlist.
     * - 424: integrity mismatch.
     * - 502/504: registry unreachable.
     */
    install: async (
        pluginId: string,
        body: PluginInstallRequestDto = {},
    ): Promise<PluginInstallResponseDto> => {
        return serverMutation<PluginInstallResponseDto>({
            endpoint: `/plugins/${pluginId}/install`,
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * EW-693 — Uninstall a distributable plugin. Refused server-side
     * for systemPlugin / bundled rows (409). Default retention keeps
     * the package files on disk so a subsequent install re-links
     * without re-downloading.
     */
    uninstall: async (pluginId: string): Promise<PluginInstallStateDto> => {
        return serverMutation<PluginInstallStateDto>({
            endpoint: `/plugins/${pluginId}/install`,
            data: null,
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * EW-693 — Convenience poller used by the settings page's Install
     * button. Polls `getInstallStatus` at `intervalMs` until the
     * state is terminal (`installed` | `error`) or `timeoutMs`
     * elapses. The terminal row is returned; a timeout returns the
     * last-observed row with no synthetic error so the UI can show
     * the installer's actual state.
     */
    pollInstallStatus: async (
        pluginId: string,
        opts: { intervalMs?: number; timeoutMs?: number } = {},
    ): Promise<PluginInstallStateDto> => {
        const interval = opts.intervalMs ?? 1500;
        const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
        let last: PluginInstallStateDto = await pluginsAPI.getInstallStatus(pluginId);
        while (
            (last.installState === 'installing' || last.installState === 'available') &&
            Date.now() < deadline
        ) {
            await new Promise((r) => setTimeout(r, interval));
            last = await pluginsAPI.getInstallStatus(pluginId);
        }
        return last;
    },
};

/**
 * EW-693 — Admin allowlist client. Mounted under `/api/admin/plugins/allowlist`;
 * the controller is gated by `IsPlatformAdminGuard`, so non-admin
 * pages should not surface these calls. The allowlist page in
 * `/admin/plugins/allowlist` is the only intended caller.
 */
export const pluginAllowlistAPI = {
    list: async (): Promise<PluginAllowlistResponseDto> => {
        return serverFetch<PluginAllowlistResponseDto>('/admin/plugins/allowlist');
    },

    create: async (body: CreatePluginAllowlistEntryDto): Promise<PluginAllowlistEntryDto> => {
        return serverMutation<PluginAllowlistEntryDto>({
            endpoint: '/admin/plugins/allowlist',
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    update: async (
        id: string,
        body: UpdatePluginAllowlistEntryDto,
    ): Promise<PluginAllowlistEntryDto> => {
        return serverMutation<PluginAllowlistEntryDto>({
            endpoint: `/admin/plugins/allowlist/${id}`,
            data: body,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    remove: async (id: string): Promise<void> => {
        return serverMutation<void>({
            endpoint: `/admin/plugins/allowlist/${id}`,
            data: null,
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
