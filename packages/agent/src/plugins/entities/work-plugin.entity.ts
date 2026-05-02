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
 * WorkPluginEntity stores work-specific settings and capability assignments for plugins.
 * This allows each work to configure plugins differently and assign specific capabilities.
 *
 * Note: We use string IDs for work reference instead of TypeORM relations to keep
 * the plugin module self-contained and testable without external entity dependencies.
 */
@Entity({ name: 'directory_plugins' })
@Unique(['workId', 'pluginId'])
export class WorkPluginEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Reference to the work (stored as string ID for loose coupling)
     */
    @Column({ name: 'directoryId' })
    workId: string;

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
     * Whether the plugin is enabled for this work
     */
    @Column({ default: true })
    enabled: boolean;

    /**
     * Active capabilities this plugin provides for this work.
     * A plugin can provide multiple capabilities, while each capability still
     * resolves to only one active provider per work.
     */
    @Column('simple-json', { nullable: true })
    activeCapabilities: string[];

    /**
     * Work-specific settings that override admin and user defaults
     */
    @Column('simple-json', { default: '{}' })
    settings: Record<string, unknown>;

    /**
     * Work-specific secret settings (e.g., repository tokens)
     */
    @Column('simple-json', { default: '{}' })
    secretSettings: Record<string, unknown>;

    /**
     * Work-specific metadata (e.g., integration state)
     */
    @Column('simple-json', { default: '{}' })
    metadata: Record<string, unknown>;

    /**
     * Priority order for this plugin in the work (lower = higher priority)
     */
    @Column({ default: 0 })
    priority: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
