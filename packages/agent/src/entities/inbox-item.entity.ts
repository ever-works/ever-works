import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    InboxItemKind,
    InboxItemOption,
    InboxItemSourceType,
    InboxItemStatus,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Inbox (operator message center) — one row per message addressed to
 * the HUMAN: a blocking question from a run (`askHuman`), an approval
 * request mirroring a pending action proposal, an escalation mirror,
 * or a system notice.
 *
 * ## Why a table and not a view over the fragments
 *
 * The fragments already exist (escalations, action proposals, parked
 * runs, notifications) but each has its own status model, none has an
 * unread flag, and none can carry a structured option list plus the
 * recorded answer. The inbox row is the MESSAGE; the fragment rows
 * stay the system of record for their own lifecycle — cross-links are
 * nullable uuids, written additively alongside them, never replacing
 * them.
 *
 * ## Answer routing (see `InboxService.reply`)
 *
 *   question   → steer the live run / resume the parked one with the
 *                composed reply; the run's `awaitingInput` clears.
 *   approval   → proxy to the approvals decide path by option id.
 *   escalation → resolve the escalation with the reply as the note.
 *   notice     → just mark answered.
 *
 * No `@ManyToOne` links (EW-654 no-cycle rule) and no FKs by design:
 * like `agent_escalations`, an inbox item must SURVIVE the deletion of
 * what it describes — "what did the agent ask me last week?" is still
 * a valid question after the run is gone.
 */
@Entity({ name: 'inbox_items' })
// The inbox list: one user's open/answered/archived messages, unread first.
@Index('idx_inbox_items_user_status_unread', ['userId', 'status', 'unread'])
// Producer dedup: is there already an item mirroring this escalation/proposal?
@Index('idx_inbox_items_escalation', ['escalationId'])
@Index('idx_inbox_items_proposal', ['proposalId'])
export class InboxItem {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Recipient — the human this message is FOR. Every read is owner-scoped. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'varchar', length: 16 })
    kind: InboxItemKind;

    /** One-line subject. Plain text — never rendered as markup. */
    @Column({ type: 'varchar', length: 300 })
    title: string;

    /** The message body. Plain text — never rendered as markup. */
    @Column({ type: 'text' })
    body: string;

    /**
     * Structured answer buttons for `question` / `approval` items.
     * NULL = free-text reply only. Shape is normalized by
     * `normalizeInboxOptions` before every write.
     */
    @Column({ type: 'simple-json', nullable: true })
    options?: InboxItemOption[] | null;

    @Column({ type: 'varchar', length: 24 })
    sourceType: InboxItemSourceType;

    // Cross-links — nullable raw uuids, no @ManyToOne (EW-654).
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    agentRunId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    escalationId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    proposalId?: string | null;

    @Column({ type: 'varchar', length: 16, default: 'open' })
    status: InboxItemStatus;

    /**
     * Read-state, independent of `status` — an item can be answered and
     * still unread (a reply sent from chat), or open and read.
     */
    @Column({ type: 'boolean', default: true })
    unread: boolean;

    @PortableDateColumn({ nullable: true })
    answeredAt?: Date | null;

    /** Free-text half of the recorded answer. */
    @Column({ type: 'text', nullable: true })
    answerText?: string | null;

    /** Which structured option was picked, when there were options. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    answerOptionId?: string | null;

    // Tier C scope denormalization (EW-657). No @ManyToOne — cycle
    // avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
