import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Unique,
} from 'typeorm';
import { PluginEntity } from './plugin.entity';

/**
 * DirectoryPluginEntity stores directory-specific settings and capability assignments for plugins.
 * This allows each directory to configure plugins differently and assign specific capabilities.
 *
 * Note: We use string IDs for directory reference instead of TypeORM relations to keep
 * the plugin module self-contained and testable without external entity dependencies.
 */
@Entity({ name: 'directory_plugins' })
@Unique(['directoryId', 'pluginId'])
export class DirectoryPluginEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Reference to the directory (stored as string ID for loose coupling)
     */
    @Column()
    directoryId: string;

    /**
     * Reference to the plugin entity ID
     */
    @Column()
    pluginEntityId: string;

    @ManyToOne(() => PluginEntity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'pluginEntityId' })
    pluginEntity: PluginEntity;

    /**
     * Plugin ID for quick lookups (denormalized from PluginEntity)
     */
    @Column()
    pluginId: string;

    /**
     * Whether the plugin is enabled for this directory
     */
    @Column({ default: true })
    enabled: boolean;

    /**
     * Active capabilities this plugin provides for this directory.
     * A plugin can provide multiple capabilities, while each capability still
     * resolves to only one active provider per directory.
     */
    @Column('simple-json', { nullable: true })
    activeCapabilities: string[];

    /**
     * Directory-specific settings that override admin and user defaults
     */
    @Column('simple-json', { default: '{}' })
    settings: Record<string, unknown>;

    /**
     * Directory-specific secret settings (e.g., repository tokens)
     */
    @Column('simple-json', { default: '{}' })
    secretSettings: Record<string, unknown>;

    /**
     * Directory-specific metadata (e.g., integration state)
     */
    @Column('simple-json', { default: '{}' })
    metadata: Record<string, unknown>;

    /**
     * Priority order for this plugin in the directory (lower = higher priority)
     */
    @Column({ default: 0 })
    priority: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
