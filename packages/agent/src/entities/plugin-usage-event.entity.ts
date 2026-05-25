import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    Index,
} from 'typeorm';
import type { ClassToObject } from './types';
import { User } from './user.entity';
import { Work } from './work.entity';
// Import from the leaf-types file (NOT from work-budget.entity) — see
// `_types.ts` for the cycle-break rationale.
import { BudgetOwnerType } from './_types';

export enum PluginUsageCapability {
    AI = 'ai',
    SEARCH = 'search',
    SCREENSHOT = 'screenshot',
    EXTRACTOR = 'extractor',
}

@Index(['workId', 'occurredAt'])
@Index(['workId', 'capability', 'pluginId', 'occurredAt'])
@Index(['userId', 'occurredAt'])
@Index('idx_plugin_usage_events_owner', ['ownerType', 'ownerId'])
@Entity({ name: 'plugin_usage_events' })
export class PluginUsageEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', length: 128 })
    pluginId: string;

    @Column({ type: 'varchar', length: 32 })
    capability: PluginUsageCapability;

    @Column({ type: 'int', default: 1 })
    units: number;

    @Column({ type: 'int', default: 0 })
    costCents: number;

    @Column({ type: 'varchar', length: 8, default: 'usd' })
    currency: string;

    @Column({ type: 'varchar', length: 128, nullable: true })
    modelId?: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    requestId?: string | null;

    @Column({ type: 'json', nullable: true })
    metadata?: Record<string, any> | null;

    /**
     * Polymorphic-owner discriminator (Missions/Ideas/Works spec §8.2).
     * Backfilled to `'work'` by Phase 0 PR 0.3 for existing rows.
     */
    @Column({ type: 'varchar', length: 16, default: BudgetOwnerType.WORK })
    ownerType: BudgetOwnerType;

    /**
     * UUID of the owning Work / Idea / Mission. Backfilled to
     * `workId` for existing rows. See `WorkBudget.ownerId` for
     * full rationale.
     */
    @Column({ type: 'uuid', nullable: true })
    ownerId?: string | null;

    @CreateDateColumn()
    occurredAt: Date;
}
