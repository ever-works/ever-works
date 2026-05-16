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

export enum PluginUsageCapability {
    AI = 'ai',
    SEARCH = 'search',
    SCREENSHOT = 'screenshot',
    EXTRACTOR = 'extractor',
}

@Index(['workId', 'occurredAt'])
@Index(['workId', 'capability', 'pluginId', 'occurredAt'])
@Index(['userId', 'occurredAt'])
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

    @CreateDateColumn()
    occurredAt: Date;
}
