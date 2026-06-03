import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { PluginCategory, ConfigurationMode, PluginState } from '@ever-works/plugin';

/**
 * Where this plugin's code came from on this deployment (EW-693).
 * Denormalised onto the row for listing; the plugin manifest's
 * `distribution` field is the source of truth for whether a plugin
 * COULD be installed at runtime.
 */
export type PluginInstallSource = 'bundled' | 'registry';

/**
 * Per-replica install lifecycle for a distributable plugin (EW-693).
 * Distinct from the existing `state` (load lifecycle) and from the
 * per-user/per-work `enabled` flag.
 */
export type PluginInstallState = 'available' | 'installing' | 'installed' | 'error';

/**
 * PluginEntity stores the persistent state and configuration of installed plugins.
 * This entity tracks plugin metadata, settings, and current state across restarts.
 */
@Entity({ name: 'plugins' })
export class PluginEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Unique plugin identifier from the plugin manifest (e.g., 'github-provider')
     */
    @Column({ unique: true })
    pluginId: string;

    /**
     * Display name of the plugin
     */
    @Column()
    name: string;

    /**
     * Plugin version (semver)
     */
    @Column()
    version: string;

    /**
     * Short description of the plugin
     */
    @Column({ nullable: true })
    description: string;

    /**
     * Plugin category for organization
     */
    @Column({ type: 'varchar' })
    category: PluginCategory;

    /**
     * Plugin capabilities as JSON array
     */
    @Column('simple-json', { default: '[]' })
    capabilities: string[];

    /**
     * Full plugin manifest from package.json
     */
    @Column('simple-json', { nullable: true })
    manifest: Record<string, unknown>;

    /**
     * Configuration mode: 'admin-only' | 'user-required' | 'hybrid'
     */
    @Column({ type: 'varchar', default: 'hybrid' })
    configurationMode: ConfigurationMode;

    /**
     * Current lifecycle state of the plugin
     */
    @Column({ type: 'varchar', default: 'unloaded' })
    state: PluginState;

    /**
     * Whether this is a built-in platform plugin
     */
    @Column({ default: false })
    builtIn: boolean;

    /**
     * File system path where the plugin is installed
     */
    @Column({ nullable: true })
    installPath: string;

    /**
     * Admin-level settings for the plugin (platform-wide defaults)
     */
    @Column('simple-json', { default: '{}' })
    settings: Record<string, unknown>;

    /**
     * Admin-level secret settings (e.g., API keys) - stored separately for security
     */
    @Column('simple-json', { default: '{}' })
    secretSettings: Record<string, unknown>;

    /**
     * Last error message if the plugin failed to load or enable
     */
    @Column({ nullable: true, type: 'text' })
    lastError: string;

    /**
     * When the plugin was last successfully loaded
     */
    @Column({ nullable: true })
    loadedAt: Date;

    /**
     * EW-693 — where the plugin's code came from on this deployment.
     * `bundled` for everything shipped in the image (default);
     * `registry` for plugins pulled from an npm-compatible registry at
     * runtime under `PLUGIN_DISTRIBUTION_MODE=dynamic`.
     *
     * Existing rows backfill to `bundled` via the column default.
     */
    @Column({ type: 'varchar', default: 'bundled' })
    source: PluginInstallSource;

    /**
     * EW-693 — exact npm spec installed, e.g.
     * `@ever-works/notion-extractor-plugin@1.2.0`. Null for `bundled`
     * sources. Persisted so the boot reconciler can re-install the
     * pinned version on a fresh replica without re-resolving.
     */
    @Column({ type: 'varchar', nullable: true })
    registrySpec: string | null;

    /**
     * EW-693 — version actually present on disk. May differ from
     * `manifest.version` until an upgrade reconciles them.
     */
    @Column({ type: 'varchar', nullable: true })
    installedVersion: string | null;

    /**
     * EW-693 — sha512 integrity used to verify the install (FR-10).
     * Stored alongside the version so install-on-use can refuse a
     * mismatched download before importing the plugin.
     */
    @Column({ type: 'varchar', nullable: true })
    integrity: string | null;

    /**
     * EW-693 — install lifecycle, distinct from the load `state` above.
     * Existing rows backfill to `installed` via a backfill UPDATE in the
     * migration (the column default of `available` is only for fresh
     * dynamic-mode plugins where catalog entries arrive before install).
     */
    @Column({ type: 'varchar', default: 'available' })
    installState: PluginInstallState;

    /**
     * EW-693 — last install-error message (download / integrity /
     * load-after-install). Distinct from `lastError` which is the
     * existing load-lifecycle error.
     */
    @Column({ nullable: true, type: 'text' })
    installError: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
