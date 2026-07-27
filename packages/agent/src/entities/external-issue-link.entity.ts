import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Event-ingest spine — the external-issue ↔ Task mapping.
 *
 * ## Problem it fixes
 *
 * The tracker connectors (Linear, Jira, and GitHub Issues through the
 * webhook receiver) already ingest `*.issue` events into
 * `ingested_events`, and the platform already has first-class `tasks`.
 * There was NOTHING joining the two: an ingested issue could land on the
 * feed and in Memory, but nobody could say "this external issue IS that
 * platform Task". Every downstream want — mirroring status, avoiding a
 * duplicate Task when the same issue is re-ingested, showing "linked
 * issues" on a Task, routing a comment back — needs that join to exist
 * first.
 *
 * ## Shape
 *
 * One row = one external issue bound to one platform Task, owned by one
 * user. `(userId, source, externalIssueId)` is UNIQUE: an external issue
 * maps to at most ONE Task per owner, which is what makes
 * "already linked?" a single indexed lookup on the ingest hot path. The
 * reverse direction is deliberately NOT unique — a Task may legitimately
 * mirror several issues (a Jira epic plus its GitHub tracking issue).
 *
 * Scoping is per-user, not global: two customers who both connect the
 * same public repository must not see each other's Task links.
 *
 * `lastSeenAt` / `lastIngestedEventId` are freshness breadcrumbs stamped
 * by the ingest drain when a matching issue event comes through. They
 * are observability, not state — the link is valid with both NULL.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1784730000000-CreateExternalIssueLinks`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'external_issue_links' })
@Index('uq_external_issue_links_identity', ['userId', 'source', 'externalIssueId'], {
    unique: true,
})
@Index('idx_external_issue_links_task', ['taskId'])
export class ExternalIssueLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of both sides of the link (scopes every read). */
    @Column({ type: 'uuid' })
    userId: string;

    /** The platform Task this external issue is bound to. */
    @Column({ type: 'uuid' })
    taskId: string;

    /**
     * Producing plugin id / receiver namespace, e.g. `linear-connector`,
     * `jira-connector`, `github`. Same vocabulary as
     * `ingested_events.source` so the two join without a translation
     * table.
     */
    @Column({ type: 'varchar', length: 100 })
    source: string;

    /** The issue's stable id in the source system. */
    @Column({ type: 'varchar', length: 200 })
    externalIssueId: string;

    /** Human-facing key, e.g. `ENG-123` / `PROJ-45` / `#1234`. */
    @Column({ type: 'varchar', length: 100, nullable: true })
    externalKey?: string | null;

    /** Issue title as the source last reported it. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    title?: string | null;

    /** Deep link back to the issue in the source system. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    url?: string | null;

    /** `ingested_events.id` of the most recent event seen for this issue. */
    @Column({ type: 'uuid', nullable: true })
    lastIngestedEventId?: string | null;

    /** When that most recent event occurred at the source. */
    // Portable date: better-sqlite3 (the e2e/CI driver) has no `timestamp`
    // type, so a raw one makes TypeORM metadata validation throw
    // DataTypeNotSupportedError and the API cannot boot there at all.
    @PortableDateColumn({ nullable: true })
    lastSeenAt?: Date | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
