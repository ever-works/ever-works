/**
 * Plugin context snapshot types for Trigger.dev background jobs.
 *
 * This snapshot is fetched once at task start and provides all plugin
 * settings data needed for the full generation run.
 */

export interface PluginSnapshotEntry {
    /** Admin-level settings (platform-wide defaults) */
    adminSettings: Record<string, unknown>;
    /** Admin-level secret settings (e.g., API keys) */
    adminSecretSettings: Record<string, unknown>;
    /** User-level settings overrides */
    userSettings: Record<string, unknown>;
    /** User-level secret settings */
    userSecretSettings: Record<string, unknown>;
    /** User-level enabled state; null if no user record exists */
    userEnabled: boolean | null;
    /** Directory-level settings overrides */
    directorySettings: Record<string, unknown>;
    /** Directory-level secret settings */
    directorySecretSettings: Record<string, unknown>;
    /** Directory-level enabled state; null if no directory record exists */
    directoryEnabled: boolean | null;
    /** Active capability assignment for this directory */
    directoryActiveCapability: string | null;
    /** Plugin priority within this directory */
    directoryPriority: number;
}

export interface PluginContextSnapshotDto {
    plugins: Record<string, PluginSnapshotEntry>;
}
