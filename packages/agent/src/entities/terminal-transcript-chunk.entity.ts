import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Terminal transcript chunk (streaming-terminal M9 / founder decision D1).
 *
 * The append-only, server-side record of what a terminal session
 * actually printed. Until this existed the relay held a bounded
 * in-memory scrollback and NOTHING was persisted, so closing the tab
 * lost the session outright and a dead run could never be replayed.
 *
 * Shape: one row per published `stdout` frame, keyed by the run and the
 * publisher's monotonic `seq`. `UNIQUE(runId, seq)` makes the writer
 * idempotent — the worker transport retries a 413-split batch, and the
 * relay itself dedupes on `seq`, so a re-published frame must never
 * duplicate a line of transcript.
 *
 * Storage rules that are NOT optional:
 *
 *  - **Redacted before insert.** `TerminalTranscriptService` runs every
 *    chunk through `redactTerminalText` (secret-scan patterns + terminal
 *    -specific env-assignment / URL-userinfo / Authorization forms).
 *    Credential-shaped strings must never reach this table.
 *  - **Text, not bytes.** Frames arrive base64-encoded; we decode to
 *    UTF-8 and store the decoded text so the transcript is searchable
 *    and redactable. `byteLength` keeps the original decoded size for
 *    retention accounting and replay budgeting.
 *  - **Retention is a plan-tier lever.** The
 *    `terminal-transcript-retention-days` entitlement decides whether a
 *    row is written at all (0 = keep nothing) and how long the
 *    `terminal-transcript-gc` cron lets it live (-1 = forever).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` and
 * `database/_entity-names.ts` — this repo has no `autoLoadEntities`; a
 * forFeature'd-but-unregistered entity throws EntityMetadataNotFoundError
 * on first query.
 */
@Entity({ name: 'terminal_transcript_chunks' })
@Index('idx_terminal_transcript_chunks_run_seq', ['runId', 'seq'], { unique: true })
@Index('idx_terminal_transcript_chunks_created', ['createdAt'])
export class TerminalTranscriptChunk {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * `agent_runs.id`. Raw uuid, no `@ManyToOne` — the EW-654
     * cycle-avoidance rule every run-scoped side table follows. The FK
     * (ON DELETE CASCADE) is declared in the migration.
     */
    @Column({ type: 'uuid' })
    runId: string;

    /** Publisher's monotonic per-session sequence number (>= 0). */
    @Column({ type: 'int' })
    seq: number;

    /**
     * `'out'` — PTY output (the only direction the internal publish
     * endpoint accepts today). `'in'` is reserved for a future
     * keystroke-capture path so the column never needs a migration.
     */
    @Column({ type: 'varchar', length: 8, default: 'out' })
    direction: TerminalTranscriptDirection;

    /** Redacted, UTF-8 decoded chunk text. */
    @Column({ type: 'text' })
    text: string;

    /** Decoded byte length BEFORE redaction — retention/replay accounting. */
    @Column({ type: 'int', default: 0 })
    byteLength: number;

    @CreateDateColumn()
    createdAt: Date;
}

/** Frame direction as persisted. */
export type TerminalTranscriptDirection = 'out' | 'in';

export const TERMINAL_TRANSCRIPT_DIRECTIONS: ReadonlyArray<TerminalTranscriptDirection> = [
    'out',
    'in',
];
