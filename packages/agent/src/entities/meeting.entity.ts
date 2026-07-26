import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Meetings v1 (Wave 8, feature a) — one captured meeting, org-wide or
 * per-Work, transcript-first.
 *
 * Rows are written by `MeetingsService`: manual/API creation, or the
 * `zoom.recording` ingest-envelope processor (recordings pulled by the
 * zoom-connector event source). Transcript capture goes through
 * `MeetingsService.ingestTranscript` which also generates the AI
 * `summary` (best-effort), saves a Memory observation (best-effort)
 * and emits a `meeting.transcript` envelope into the event-ingest
 * spine (whose drain writes the Activity entry with `sourceUrl`
 * provenance).
 *
 * Dedupe: `dedupeKey` is a sha256 over `(userId, source, externalId)`
 * — the provider identity `(source, externalId)` scoped per owner so
 * one user's sync can never swallow (or leak) another user's meeting
 * (same rationale as `ingested_events`). NULL for meetings without an
 * `externalId` (manual notes) — those never dedupe.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1783800000000-CreateMeetings`).
 *
 * Live bot-join (an Ever Works bot joining meetings to capture in real
 * time) is the documented v2 follow-up — it will write these same rows
 * through `ingestTranscript`, so nothing here changes for it.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`, a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */

/** One meeting participant (denormalized — provider rosters vary). */
export interface MeetingParticipant {
    name: string;
    email?: string;
}

/** Where a meeting row came from. */
export type MeetingSource = 'zoom' | 'google-meet' | 'manual' | 'import';

@Entity({ name: 'meetings' })
@Index('idx_meetings_dedupe', ['dedupeKey'], { unique: true })
@Index('idx_meetings_user_started', ['userId', 'startedAt'])
@Index('idx_meetings_work', ['workId'])
export class Meeting {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the meeting was captured for (scopes every read/write). */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Work the meeting was routed to, when known (org-wide when null). */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @Column({ type: 'varchar', length: 500 })
    title: string;

    // Portable date: better-sqlite3 (the e2e/CI driver) has no `timestamp`
    // type, so a raw one makes TypeORM metadata validation throw
    // DataTypeNotSupportedError and the API cannot boot there at all.
    @PortableDateColumn()
    startedAt: Date;

    // Portable date: better-sqlite3 (the e2e/CI driver) has no `timestamp`
    // type, so a raw one makes TypeORM metadata validation throw
    // DataTypeNotSupportedError and the API cannot boot there at all.
    @PortableDateColumn({ nullable: true })
    endedAt?: Date | null;

    /** Producing surface: 'zoom' | 'google-meet' | 'manual' | 'import'. */
    @Column({ type: 'varchar', length: 32 })
    source: MeetingSource;

    /** The meeting's stable id in the source system (null for manual). */
    @Column({ type: 'varchar', length: 200, nullable: true })
    externalId?: string | null;

    /** Denormalized roster: `[{ name, email? }]`. */
    @Column({ type: 'simple-json' })
    participants: MeetingParticipant[];

    @Column({ type: 'text', nullable: true })
    transcriptText?: string | null;

    /** AI-generated summary (best-effort — may stay null). */
    @Column({ type: 'text', nullable: true })
    summary?: string | null;

    /** Deep link back to the recording / provider meeting page. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    sourceUrl?: string | null;

    /** sha256 hex over (userId, source, externalId); NULL = no dedupe. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    dedupeKey?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
