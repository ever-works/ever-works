import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { ClassToObject } from './types';
import { User } from './user.entity';

export interface WorkAgentGuardrails {
    maxWorksPerRun: number;
    maxItemsPerWork: number;
    maxBudgetCentsPerRun: number;
    requireApprovalBeforeCreate: boolean;
    requireApprovalBeforeDelete: boolean;
    requireApprovalAboveBudgetCents: number;
    dryRunByDefault: boolean;
}

@Entity({ name: 'work_agent_preferences' })
export class WorkAgentPreference {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid', { unique: true })
    userId: string;

    @OneToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    @Column({ default: false })
    enabled: boolean;

    @Column({ default: false })
    autoApproveLowImpact: boolean;

    @Column({ default: true })
    dailySuggestionsEnabled: boolean;

    @Column('simple-json')
    guardrails: WorkAgentGuardrails;

    /**
     * User-customized cadence for the Auto-generate Ideas background
     * loop (cron expression). NULL = inherit the platform-hardcoded
     * default. Promoted from a hardcoded constant by Phase 0 PR 0.4
     * (Missions/Ideas/Works spec §6.2). The Auto-generate Ideas ⚙
     * gear on `/ideas` deep-links to a settings field that writes
     * this value.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    autoGenerateCadence?: string | null;

    /**
     * How many Ideas per Auto-generate tick. NULL = inherit
     * platform default. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §6.2).
     */
    @Column({ type: 'int', nullable: true })
    autoGenerateBatchSize?: number | null;

    /**
     * Max number of Ideas auto-built into Works per day. NULL =
     * unlimited (no throttle). Bounds the blast radius of
     * Auto-build Works. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §6.3).
     */
    @Column({ type: 'int', nullable: true })
    autoBuildThrottlePerDay?: number | null;

    /**
     * Default per-Mission outstanding-Ideas cap when the Mission
     * itself doesn't override (Mission.outstandingIdeasCap = NULL).
     * NULL on this column = inherit platform-hardcoded default (20).
     * Negative sentinel (-1) = user wants "unlimited" as their
     * account default. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §1.3, §6.3).
     */
    @Column({ type: 'int', nullable: true })
    missionDefaultOutstandingCap?: number | null;

    /**
     * Auto-retry policy — how many times the Goal-completion
     * handler will automatically re-queue a failed Idea build when
     * the failure is classified as transient (network timeout,
     * 429 rate-limit, 5xx upstream, plugin-internal timeout).
     * Range 0–5. Default 2 means a failed build is retried up to
     * 2 times before giving up. Spec §3.9, §6.6 / Decision A23.
     *
     * NOT NULL with default so the policy is in effect immediately
     * once PR FF (Phase 1) wires the retry handler — no need for
     * users to visit settings to opt in.
     */
    @Column({ type: 'int', default: 2 })
    maxAutoRetries: number;

    /**
     * Auto-retry backoff — initial seconds to wait between
     * retries. Range 10–3600. Default 60. Actual wait between
     * attempt N and attempt N+1 = `backoffSeconds *
     * exponentialBackoffFactor ^ N`. Spec §6.6 / Decision A23.
     */
    @Column({ type: 'int', default: 60 })
    backoffSeconds: number;

    /**
     * Auto-retry backoff multiplier per attempt. Range 1.0–4.0.
     * Default 2.0 (exponential doubling: 60s, 120s, 240s for
     * attempts 1/2/3 at the default backoffSeconds).
     *
     * Stored as `float` for SQLite/Postgres portability — the test
     * driver is better-sqlite3 (REAL) and prod is Postgres (real /
     * double precision). The 0.1 precision the spec needs
     * (1.0–4.0 in 0.1 steps) fits comfortably in float64 — no
     * rounding issues at the user-facing scale. Spec §6.6 /
     * Decision A23.
     */
    @Column({ type: 'float', default: 2.0 })
    exponentialBackoffFactor: number;

    /**
     * Account-wide monthly spend cap, in cents (spec §5.1, §6.6 /
     * Decision A28). Aggregates spend across ALL of the user's
     * Works + Ideas + Missions for the current billing period.
     *
     * NULL = no account-wide cap (the user has not configured one).
     * The Dashboard `Month Spend` tile (6th tile, Phase 7 PR II)
     * shows `$spent` only when this is NULL, or `$spent / $cap`
     * with a progress bar when set. Per-Work and per-Mission caps
     * stay independent — the account-wide cap is an additional
     * outer guard, not a replacement.
     *
     * `bigint` rather than `int` because monthly spend in cents
     * can plausibly cross 2^31 for power users (e.g. a user with
     * many Missions auto-building at high cadence — $21,474 / mo
     * is the int32 ceiling).
     */
    @Column({ type: 'bigint', nullable: true })
    accountWideMonthlyCapCents?: string | null;

    /**
     * Whether the account-wide cap is a soft cap (true — alerts
     * only, work continues over the cap) or a hard cap (false —
     * BudgetGuardService blocks plugin calls once the cap is hit).
     * Default `true` matches the per-Work `WorkBudget.allowOverage`
     * default for consistency. Ignored when
     * `accountWideMonthlyCapCents` is NULL.
     */
    @Column({ type: 'boolean', default: true })
    accountWideAllowOverage: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
