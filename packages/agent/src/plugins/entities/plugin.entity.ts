import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { PluginCategory, ConfigurationMode, PluginState } from '@ever-works/plugin';

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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
