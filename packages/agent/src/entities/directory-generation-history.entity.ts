import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    JoinColumn,
    Index,
} from 'typeorm';
import { Directory } from './directory.entity';
import { User } from './user.entity';
import type { ClassToObject } from './types';
import { GenerationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { GenerateStatusType } from './types';
import { TimestampColumn } from './_types';
import { DirectorySchedule } from './directory-schedule.entity';
import { DirectoryHistoryActivityType, type DirectoryChangelog } from '@ever-works/contracts/api';

export type GenerationMetrics = {
    urls_scanned?: number;
    pages_processed?: number;
    items_extracted_current_run?: number;
    new_items_added_to_store?: number;
    total_items_in_store?: number;
    total_tokens_used?: number;
    total_cost?: number;
};

@Index(['directoryId', 'status'])
@Index(['triggeredBy'])
@Index(['scheduleId'])
@Entity({ name: 'directory_generation_history' })
export class DirectoryGenerationHistory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    directoryId: string;

    @ManyToOne(() => Directory, (directory) => directory.generationHistory, {
        onDelete: 'CASCADE',
    })
    directory: ClassToObject<Directory>;

    @Column({ nullable: true })
    userId?: string | null;

    @ManyToOne(() => User, (user) => user.generationHistory, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    user?: ClassToObject<User> | null;

    @Column({ type: 'varchar', nullable: true })
    generationMethod?: GenerationMethod | null;

    @Column({ type: 'varchar', default: GenerateStatusType.GENERATING })
    status: GenerateStatusType;

    @Column({ type: 'json', nullable: true })
    parameters?: Record<string, any> | null;

    @Column({ type: 'json', nullable: true })
    metrics?: GenerationMetrics | null;

    @Column({ type: 'varchar', default: 'user' })
    triggeredBy: 'user' | 'schedule' | 'api';

    @Column({ nullable: true })
    triggerRunId?: string;

    @Column({ type: 'varchar', default: DirectoryHistoryActivityType.GENERATION })
    activityType: DirectoryHistoryActivityType;

    @Column({ type: 'json', nullable: true })
    changelog?: DirectoryChangelog | null;

    @Column({ nullable: true })
    scheduleId?: string | null;

    @ManyToOne(() => DirectorySchedule, { nullable: true })
    @JoinColumn({ name: 'scheduleId' })
    schedule?: ClassToObject<DirectorySchedule> | null;

    @Column({ type: 'int', default: 0 })
    newItemsCount: number;

    @Column({ type: 'int', default: 0 })
    updatedItemsCount: number;

    @Column({ type: 'int', default: 0 })
    totalItemsCount: number;

    @TimestampColumn({ nullable: true })
    startedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    finishedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    durationInSeconds?: number | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
