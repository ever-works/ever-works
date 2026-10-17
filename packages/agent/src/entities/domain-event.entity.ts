import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * One row of the domain event outbox (EW-P1-1, `docs/specs/features/domain-events/spec.md`).
 *
 * Written by `DomainEventRecorder` in the SAME transaction as the state change
 * it describes, so the event commits or rolls back with it. The relay later
 * gives the row its feed position (`seq`) and hands it to in-process listeners,
 * EW plugins and webhooks v2; the integration change feed reads it back.
 *
 * Two sequence columns, on purpose:
 *
 *  - `outboxSeq` is the auto-increment primary key: insert order. It is
 *    allocated at INSERT time, so two concurrent transactions can commit out of
 *    order — a cursor over it could skip a slow commit.
 *  - `seq` is the **feed position**: assigned by the single-leader relay only to
 *    rows it already sees as committed, strictly increasing and gap-free. The
 *    integration feed (`?after=<seq>`) and plugin cursors page on it. `null`
 *    until the relay dispatches the row.
 *
 * `outboxSeq` is declared with TypeORM's default increment type here because
 * better-sqlite3 only accepts `INTEGER PRIMARY KEY AUTOINCREMENT` (64-bit there
 * anyway); the migration widens it to `bigint` on Postgres and MySQL. Both
 * bigint columns come back as strings on Postgres/MySQL and numbers on SQLite —
 * read them through `String(...)`.
 */
@Entity({ name: 'domain_events' })
@Index('uq_domain_events_id', ['id'], { unique: true })
@Index('uq_domain_events_seq', ['seq'], { unique: true })
@Index('idx_domain_events_tenant_seq', ['tenantId', 'seq'])
@Index('idx_domain_events_org_seq', ['organizationId', 'seq'])
@Index('idx_domain_events_aggregate_seq', ['aggregateType', 'aggregateId', 'seq'])
@Index('idx_domain_events_undispatched', ['dispatchedAt', 'outboxSeq'])
export class DomainEvent {
    @PrimaryGeneratedColumn('increment')
    outboxSeq: number | string;

    /** Feed position, assigned by the relay at dispatch. `null` until then. */
    @Column({ type: 'bigint', nullable: true })
    seq?: string | number | null;

    /** `evt_<ULID>` — the consumers' dedupe key. */
    @Column({ type: 'varchar', length: 32 })
    id: string;

    /** Catalog type, e.g. `task.updated`. */
    @Column({ type: 'varchar', length: 64 })
    type: string;

    /** Payload schema version of the type. */
    @Column({ type: 'smallint', default: 1 })
    version: number;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /** `null` for personal scope: recorded, never served to integrations. */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'varchar', length: 32 })
    aggregateType: string;

    @Column({ type: 'varchar', length: 64 })
    aggregateId: string;

    /** The aggregate's `version` after the change. */
    @Column({ type: 'int', default: 1 })
    aggregateVersion: number;

    /** The aggregate's visibility at event time (`private` rows are never served). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    visibility?: string | null;

    @Column({ type: 'varchar', length: 16 })
    actorType: string;

    @Column({ type: 'varchar', length: 100 })
    actorId: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    actorLabel?: string | null;

    /** `X-Sync-Origin` of the write, e.g. `gauzy:<connectionId>`. */
    @Column({ type: 'varchar', length: 100, nullable: true })
    originTag?: string | null;

    @Column({ type: 'uuid', nullable: true })
    integrationKeyId?: string | null;

    @Column({ type: 'simple-json' })
    changedFields: string[];

    /** Full post-change snapshot in the integration DTO shape (or the child DTO). */
    @Column({ type: 'simple-json' })
    data: Record<string, unknown>;

    /** Previous values of `changedFields` only. */
    @Column({ type: 'simple-json' })
    previous: Record<string, unknown>;

    @PortableDateColumn()
    occurredAt: Date;

    /** Set by the relay together with `seq`. */
    @PortableDateColumn({ nullable: true })
    dispatchedAt?: Date | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    correlationId?: string | null;
}
