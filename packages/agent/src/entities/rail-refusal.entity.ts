import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type {
    ActionCategory,
    RailRefusalSubjectType,
    RailRefusalVerdict,
    SafetyRailId,
    SafetyReasonCode,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — one row per refusal or hold. Append-only.
 *
 * Today a refusal is an exception, a log line, and sometimes a rejected
 * approval row. There is no queryable record of WHAT THE RAILS STOPPED —
 * which is the evidence behind every guarantee on the Safety screen, and the
 * input to readiness.
 *
 * # Why this is not an Activity record
 *
 * A capped inbox or a misconfigured agent can trip the same rail hundreds of
 * times an hour. The Live Feed must not drown, so individual refusals write
 * here and only the collapsed hourly summary reaches the feed (FR-68).
 * `collapseKey` is what makes that collapse a single indexed group-by rather
 * than a scan.
 *
 * # What a row may never contain
 *
 * No credential value, no email body, no document body, and no command
 * arguments beyond what identifies the action — at most 500 characters of
 * summary (FR-70). `requested` and `ceiling` carry identifying parameters
 * only. This is a table an owner reads to understand a refusal, not a copy of
 * the thing that was refused; the held payload itself rides the approval row.
 *
 * # Writing one must never fail the action path
 *
 * `RailRefusalService.record()` swallows every write error and counts it
 * (FR-69). A refusal that cannot be recorded still refuses.
 */
@Entity({ name: 'rail_refusals' })
@Index('idx_rail_refusals_user_created', ['userId', 'createdAt'])
@Index('idx_rail_refusals_collapse', ['collapseKey'])
@Index('idx_rail_refusals_agent_category', ['agentId', 'category', 'createdAt'])
@Index('idx_rail_refusals_rail', ['railId', 'createdAt'])
export class RailRefusal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the workspace the refusal happened in. */
    @Column({ type: 'uuid' })
    userId: string;

    /** Which rail decided — one of the seven, or `taxonomy` for an unclassified action. */
    @Column({ type: 'varchar', length: 24 })
    railId: SafetyRailId;

    /** Null only on a `taxonomy` row: nothing classified the action. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    category?: ActionCategory | null;

    /** `refused` stopped it; `held` parked it for a person. */
    @Column({ type: 'varchar', length: 12 })
    verdict: RailRefusalVerdict;

    /** One of the fourteen published reason codes. */
    @Column({ type: 'varchar', length: 32 })
    reasonCode: SafetyReasonCode;

    /** What the refusal was about: run | agent | mission | task | schedule | trigger. */
    @Column({ type: 'varchar', length: 16 })
    subjectType: RailRefusalSubjectType;

    @Column({ type: 'uuid', nullable: true })
    subjectId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** Backlink to the receipt, so a run can show which rail stopped it. */
    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    /** Human-readable, credential-free, capped at 500 characters (FR-70). */
    @Column({ type: 'varchar', length: 500 })
    summary: string;

    /**
     * Identifying parameters only — a recipient domain, a branch name, a tool
     * name. Never a body, never a credential. Stored as `simple-json` (TEXT at
     * the DB layer) to stay portable across Postgres and better-sqlite3.
     */
    @Column({ type: 'simple-json', nullable: true })
    requested?: Record<string, unknown> | null;

    /** What the rail allowed, for the "requested vs ceiling" line. */
    @Column({ type: 'simple-json', nullable: true })
    ceiling?: Record<string, unknown> | null;

    /** The held `agent_action_proposals` row, when `verdict = 'held'`. */
    @Column({ type: 'uuid', nullable: true })
    proposalId?: string | null;

    /**
     * `sha1(railId:agentId:category:yyyy-mm-dd)` — the collapse group of
     * FR-68. Computed at write time rather than derived on read so the
     * collapse is one indexed group-by instead of a scan over a retention
     * window that can hold ninety days of rows.
     */
    @Column({ type: 'varchar', length: 128 })
    collapseKey: string;

    // Tier A/C scope columns — auto-stamped by ScopeStampingSubscriber.
    // No @ManyToOne: known entities import cycle (user.entity.ts, EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Immutable once written. Pruned at the retention horizon, never updated. */
    @CreateDateColumn()
    createdAt: Date;
}
