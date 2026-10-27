import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/**
 * APW-09 (plan §3.1B, G20 / FR-34) — one Agent suggestion to propose a Task upstream.
 *
 * At most one per Task (`uq_ups_task`); `sentAt` is what the 3-per-App-Work-per-7-days
 * window counts (`idx_ups_work_sent`), and a dismissed row is never re-sent. The Agent
 * tool records the suggestion server-side from its call (G18), never from a Task label.
 *
 * `workId → works(id)` ON DELETE CASCADE; `taskId` / `userId` are bare (a Task deletion
 * must not cascade into the dismissal record). Migration
 * `1792090300000-CreateUpstreamPrSuggestions`. Scope columns are plain uuids (EW-655).
 */
@Entity({ name: 'upstream_pr_suggestions' })
@Index('uq_ups_task', ['taskId'], { unique: true })
@Index('idx_ups_work_sent', ['workId', 'sentAt'])
export class UpstreamPrSuggestion {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    @Column({ type: 'uuid' })
    taskId: string;

    /** The member the suggestion is addressed to. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The Agent's reason, as sent. */
    @Column({ type: 'varchar', length: 300, nullable: true })
    reason?: string | null;

    @PortableDateColumn({ nullable: true })
    sentAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    dismissedAt?: Date | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
