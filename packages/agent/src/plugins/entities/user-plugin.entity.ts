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
 * UserPluginEntity stores user-specific settings and state overrides for plugins.
 * This allows individual users to configure plugins differently from platform defaults.
 *
 * Note: We use string IDs for user reference instead of TypeORM relations to keep
 * the plugin module self-contained and testable without external entity dependencies.
 */
@Entity({ name: 'user_plugins' })
@Unique(['userId', 'pluginId'])
export class UserPluginEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Reference to the user (stored as string ID for loose coupling)
     */
    @Column()
    userId: string;

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
     * Whether the user has enabled this plugin (user-level toggle)
     */
    @Column({ default: true })
    enabled: boolean;

    /**
     * User-specific settings that override admin defaults
     */
    @Column('simple-json', { default: '{}' })
    settings: Record<string, unknown>;

    /**
     * User-specific secret settings (e.g., personal API keys)
     */
    @Column('simple-json', { default: '{}' })
    secretSettings: Record<string, unknown>;

    /**
     * User-specific metadata (e.g., usage stats, preferences)
     */
    @Column('simple-json', { default: '{}' })
    metadata: Record<string, unknown>;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
