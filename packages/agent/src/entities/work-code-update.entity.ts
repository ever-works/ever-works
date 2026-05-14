import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { User } from './user.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

export enum WorkCodeUpdateStatus {
    PENDING = 'pending',
    GENERATING = 'generating',
    PROPOSED = 'proposed',
    APPLIED = 'applied',
    REJECTED = 'rejected',
    FAILED = 'failed',
}

export enum WorkCodeUpdateSource {
    MANUAL = 'manual',
    SCHEDULED = 'scheduled',
    ONBOARDING = 'onboarding',
}

export interface WorkCodeUpdateDiffEntry {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions?: number;
    deletions?: number;
}

@Entity({ name: 'work_code_updates' })
@Index(['workId', 'status', 'createdAt'])
export class WorkCodeUpdate {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, (work) => work.codeUpdates, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ type: 'uuid', nullable: true })
    requestedByUserId?: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'requestedByUserId' })
    requestedBy?: User | null;

    @Column({ type: 'text' })
    prompt: string;

    @Column({ length: 200, nullable: true })
    title?: string;

    @Column({ length: 80, nullable: true })
    aiModel?: string;

    @Column({ length: 120, nullable: true })
    templateId?: string;

    @Column({ type: 'varchar', length: 20, default: WorkCodeUpdateSource.MANUAL })
    source: WorkCodeUpdateSource;

    @Column({ type: 'varchar', length: 20, default: WorkCodeUpdateStatus.PENDING })
    status: WorkCodeUpdateStatus;

    @Column({ nullable: true })
    branch?: string;

    @Column({ type: 'int', nullable: true })
    prNumber?: number;

    @Column({ nullable: true })
    prUrl?: string;

    @Column('simple-json', { nullable: true })
    diff?: WorkCodeUpdateDiffEntry[];

    @Column({ type: 'text', nullable: true })
    summary?: string;

    @Column({ type: 'text', nullable: true })
    lastError?: string | null;

    @Column({ type: 'uuid', nullable: true })
    previewDeploymentId?: string | null;

    @TimestampColumn({ nullable: true })
    appliedAt?: Date;

    @TimestampColumn({ nullable: true })
    rejectedAt?: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
