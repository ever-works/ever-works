import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    InboxItemEmailMeta,
    InboxItemKind,
    InboxItemOption,
    InboxItemOrigin,
    InboxItemSourceMeta,
    InboxItemSourceType,
    InboxItemStatus,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Inbox (operator message center) — one row per message addressed to
 * the HUMAN: a blocking question from a run (`askHuman`), a question a
 * FLEET run asked through its worktree (`fleet-run`, self-build slice
 * Q), an approval request mirroring a pending action proposal, an
 * escalation mirror, or a system notice.
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
 *                A `fleet-run` question is always the resume case (the
 *                run is parked terminal before the row exists) and the
 *                reply travels with the question text folded in, since
 *                the next fleet run has no session that remembers it.
 *   approval   → proxy to the approvals decide path by option id.
 *   escalation → resolve the escalation with the reply as the note.
 *   notice     → just mark answered.
 *
 * ## Integration items (`origin = 'integration'`)
 *
 * An integration key (Ever Gauzy first) files ITS OWN Inbox items here
 * through `POST /api/integrations/v1/inbox/items`: `integrationKeyId`
 * names the key, `externalId` the integration's id of the item (unique per
 * tenant and key — the permanent de-duplication), `sourceUrl` /
 * `sourceLabel` the link and badge back to the integration's app, and
 * `emailMeta` the header block of a `kind: 'email'` item. Answering one
 * routes nowhere: the answer is stored on the row and recorded as
 * `inbox.item.updated`, which the integration reads back. Only the key
 * that created an item may change it (`PATCH /inbox/items/:id`).
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
// Integration API v1 keyset list (EW-P3-1, `GET /api/integrations/v1/inbox/items`):
// one organization's messages ordered by `(updatedAt, id)` — migration 1795130100000.
@Index('idx_inbox_items_org_updated', ['organizationId', 'updatedAt', 'id'])
// Integration inbox push: one item per (tenant, integration key, externalId), forever —
// the de-duplication a replayed create relies on (migration 1797200000000).
@Index('uq_inbox_items_integration_external', ['tenantId', 'integrationKeyId', 'externalId'], {
    unique: true,
    where: '"externalId" IS NOT NULL',
})
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

    /**
     * Which producer wrote the row: `agent-run` (askHuman), `fleet-run`
     * (a question a node-executed run asked, slice Q), `escalation`,
     * `proposal`, `system`, `work`. Drives the reply routing above.
     */
    @Column({ type: 'varchar', length: 24 })
    sourceType: InboxItemSourceType;

    /**
     * Self-build slice Q — provenance of a `fleet-run` question (node id
     * and name, Task branch, Task title, pull request, mount directory).
     * NULL for every other producer; normalized by
     * `normalizeInboxSourceMeta` before every write. Rendered as chips
     * by the web, never as markup.
     */
    @Column({ type: 'simple-json', nullable: true })
    sourceMeta?: InboxItemSourceMeta | null;

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

    /**
     * My Decisions — when a human first opened this item: stamped once, by
     * the first read flip or the answer, whichever came first, and never
     * moved again. With `createdAt` and `answeredAt` it makes
     * time-to-decide measurable. NULL = nobody has looked yet.
     * Written by `InboxService` through `InboxItemRepository.stampFirstViewed`.
     */
    @PortableDateColumn({ nullable: true })
    firstViewedAt?: Date | null;

    // ── Integration inbox push (`POST /api/integrations/v1/inbox/items`) ──

    /**
     * `platform` — written by an Ever Works producer (every row before the
     * integration inbox push); `integration` — filed by an integration key.
     */
    @Column({ type: 'varchar', length: 16, default: 'platform' })
    origin: InboxItemOrigin;

    /** The integration key that filed an `integration` item; NULL otherwise. No FK (EW-654). */
    @Column({ type: 'uuid', nullable: true })
    integrationKeyId?: string | null;

    /** The integration's own id of the item (≤ 128). Unique per tenant + key; NULL for platform items. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    externalId?: string | null;

    /** The item in the integration's own app: `https:` only, ≤ 2000. Rendered through `safeHttpsUrl`. */
    @Column({ type: 'varchar', length: 2000, nullable: true })
    sourceUrl?: string | null;

    /** The badge text of an `integration` item (≤ 80), e.g. "Ever Gauzy". Plain text. */
    @Column({ type: 'varchar', length: 80, nullable: true })
    sourceLabel?: string | null;

    /**
     * The header block of a `kind: 'email'` integration item (from, to,
     * subject, receivedAt — capped strings, `normalizeInboxEmailMeta`).
     * Plain text, never markup. NULL for every other item.
     */
    @Column({ type: 'simple-json', nullable: true })
    emailMeta?: InboxItemEmailMeta | null;

    /** When it happened at the source, as the integration reported it. NULL = not said. */
    @PortableDateColumn({ nullable: true })
    occurredAt?: Date | null;

    /** The Goal an integration item is about (`related.goalId`). Raw uuid, no FK (EW-654). */
    @Column({ type: 'uuid', nullable: true })
    goalId?: string | null;

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

    /**
     * Aggregate version for event ordering and `ETag` (EW-P3-1, domain events
     * `inbox.item.*`; same rule as tasks — `docs/specs/features/domain-events/spec.md` §4).
     * Starts at 1 and is bumped by `bumpAggregateVersion` on every recorded
     * change. A plain column on purpose, NOT `@VersionColumn` (which TypeORM
     * would bump on every query-builder update, telemetry stamps included).
     */
    @Column({ type: 'int', default: 1 })
    version: number;
}
