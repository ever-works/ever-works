import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { AgentInboxMode, AgentInboxState } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Agent email (AW-05) — one Agent's mail policy: whether what it writes
 * waits for a person (`mode`) and how much it may send (the per-inbox
 * ceilings).
 *
 * # Why a row of its own
 *
 * The mail an Agent can use is already modelled — `tenant_email_addresses`
 * holds the address and `agent_email_assignments` binds it to the Agent.
 * Neither is the right home for policy: one address may be assigned to
 * several Agents, and an assignment row exists once per direction. The
 * policy is about the AGENT, so it is keyed on the Agent, exactly once
 * (`uq_agent_inboxes_agent`).
 *
 * # Absence is meaningful
 *
 * An Agent with no row keeps behaving as it did before this table existed:
 * its sends are not held (unless its organization's policy says otherwise)
 * and only ceilings someone explicitly configured apply (an operator's
 * `EMAIL_SEND_CAP_*`, its organization's caps) — with neither, none. A row
 * is created only when a person asks for one, and a created row starts in
 * `draft-review` — nothing it writes leaves without approval — with its
 * per-Agent limits in force.
 *
 * # Ceilings
 *
 * Each `*Cap` column is `NULL` = inherit (organization policy, then the
 * operator's platform value, then — because this row exists — the
 * recommended number), `0` = explicitly no ceiling, a positive integer =
 * that ceiling. Resolution is the pure `resolveEmailSendCaps` in
 * `@ever-works/contracts`. Counts are never stored here — they are read
 * from `email_messages` at send time, so nothing a model writes can move
 * them.
 *
 * `emailAddressId` is an optional pin to the address this inbox sends
 * from; `NULL` keeps the existing resolution through the Agent's outbound
 * assignment. Raw uuid column, no `@ManyToOne` (to `Agent` or the address)
 * — the same import-cycle posture as `email_messages`; the FKs live in the
 * migration.
 */
@Entity({ name: 'agent_inboxes' })
@Index('uq_agent_inboxes_agent', ['agentId'], { unique: true })
@Index('idx_agent_inboxes_user_state', ['userId', 'state'])
export class AgentInbox {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner. Every read and write is scoped to this column. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @Column({ type: 'uuid', nullable: true })
    emailAddressId?: string | null;

    @Column({ type: 'varchar', length: 16, default: 'draft-review' })
    mode: AgentInboxMode;

    @Column({ type: 'varchar', length: 16, default: 'active' })
    state: AgentInboxState;

    /** Rolling 24h sends. NULL = inherit, 0 = no ceiling. */
    @Column({ type: 'int', nullable: true })
    dailySendCap?: number | null;

    /** Sends per 60 seconds. NULL = inherit, 0 = no ceiling. */
    @Column({ type: 'int', nullable: true })
    burstSendCap?: number | null;

    /** Distinct recipients per 300 seconds. NULL = inherit, 0 = no ceiling. */
    @Column({ type: 'int', nullable: true })
    recipientBurstCap?: number | null;

    /** Recipients (to + cc + bcc) on one message. NULL = inherit, 0 = no ceiling. */
    @Column({ type: 'int', nullable: true })
    recipientsPerMessageCap?: number | null;

    /**
     * When the rolling-24h ceiling last refused a send, the moment it frees
     * up again. Informational: the inbox is "paused" only while this is in
     * the future, so it resumes on its own with no job and no human action.
     */
    @PortableDateColumn({ nullable: true })
    capPausedUntil?: Date | null;

    // Tier A/C scope columns — auto-stamped by ScopeStampingSubscriber.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
