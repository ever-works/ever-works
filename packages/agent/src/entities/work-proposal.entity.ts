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
import { User } from './user.entity';
import { Work } from './work.entity';

export enum WorkProposalStatus {
    PENDING = 'pending',
    DISMISSED = 'dismissed',
    ACCEPTED = 'accepted',
    /**
     * User explicitly queued the Idea for build (one-shot build flow).
     * Set by the new `POST /me/work-proposals/:id/build` endpoint
     * (PR B) and by the Mission tick worker when auto-building (PR J).
     */
    QUEUED = 'queued',
    /**
     * Build pipeline is in flight. Stays BUILDING across auto-retries
     * (Decision A24) — only flips to FAILED on exhaustion or
     * non-transient error.
     */
    BUILDING = 'building',
    /**
     * Build pipeline gave up. `failureMessage` + `failureKind`
     * (added in migration `AddIdeaFailureColumns`) carry the reason.
     */
    FAILED = 'failed',
}

export enum WorkProposalSource {
    AUTO_SIGNUP = 'auto-signup',
    USER_REFRESH = 'user-refresh',
    DISCOVER = 'discover',
    SCHEDULED = 'scheduled',
    /** Idea typed in by the user via `+ Add` (spec §3.4). */
    USER_MANUAL = 'user-manual',
    /** Idea spawned by a Mission tick (spec §1.3, §4.4). */
    MISSION = 'mission',
}

/**
 * Classification of WHY an Idea build failed (spec §3.9 /
 * Decision A23). The first 4 are transient and eligible for
 * auto-retry; the last 2 are permanent and skip retry.
 *
 * The classifier itself lives in code (Phase 1 PR FF), not in
 * user settings (Decision A23 explicit — "transient-error
 * classification is platform-managed"). This enum is the
 * vocabulary the classifier writes to `WorkProposal.failureKind`.
 */
export enum IdeaFailureKind {
    /** Retryable. Network unreachable / connection reset / DNS hiccup. */
    TRANSIENT_NETWORK = 'transient-network',
    /** Retryable. 429 from upstream API. */
    TRANSIENT_RATE_LIMIT = 'transient-rate-limit',
    /** Retryable. 5xx from upstream API. */
    TRANSIENT_UPSTREAM_5XX = 'transient-upstream-5xx',
    /** Retryable. Plugin-internal timeout or transient failure. */
    TRANSIENT_PLUGIN = 'transient-plugin',
    /** Permanent. Invalid input, validation failure, malformed prompt. */
    PERMANENT_INVALID_INPUT = 'permanent-invalid-input',
    /** Permanent. Anything else — fallback bucket for unclassified failures. */
    PERMANENT_UNKNOWN = 'permanent-unknown',
}

export interface WorkProposalCategory {
    name: string;
    slug: string;
}

export type WorkProposalFieldType = 'string' | 'url' | 'image' | 'number' | 'enum' | 'markdown';

export interface WorkProposalField {
    name: string;
    type: WorkProposalFieldType;
}

export interface WorkProposalRecommendedPlugin {
    pluginId: string;
    reason: string;
}

@Entity({ name: 'work_proposals' })
@Index('idx_work_proposals_user_status_mission_generated', [
    'userId',
    'status',
    'missionId',
    'generatedAt',
])
export class WorkProposal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ length: 120 })
    title: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ length: 80 })
    slugSuggestion: string;

    @Column('simple-json')
    suggestedCategories: WorkProposalCategory[];

    @Column('simple-json')
    suggestedFields: WorkProposalField[];

    @Column('simple-json')
    recommendedPlugins: WorkProposalRecommendedPlugin[];

    @Column({ type: 'text', nullable: true })
    generatedPrompt?: string | null;

    @Column({ type: 'text' })
    reasoning: string;

    @Column({ type: 'varchar', default: WorkProposalSource.AUTO_SIGNUP })
    source: WorkProposalSource;

    @Column({ type: 'varchar', default: WorkProposalStatus.PENDING })
    status: WorkProposalStatus;

    @Column('uuid', { nullable: true })
    acceptedWorkId?: string | null;

    @ManyToOne(() => Work, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'acceptedWorkId' })
    acceptedWork?: Work | null;

    @Column({ type: 'varchar', nullable: true })
    generationRunId?: string | null;

    /**
     * FK to `missions.id` when this Idea was spawned by a Mission tick
     * (spec §1.3, §4.4). NULL for Ideas from any other source
     * (`AUTO_SIGNUP` / `USER_REFRESH` / `DISCOVER` / `SCHEDULED` /
     * `USER_MANUAL`).
     *
     * Intentionally a plain `uuid` column without a `@ManyToOne(() =>
     * Mission)` relation here — the `Mission` entity is created in a
     * follow-up migration to avoid a forward-reference between
     * sibling entities during the staged rollout. The FK constraint
     * is added on the DB side by the `CreateMissionsTable` migration.
     */
    @Column('uuid', { nullable: true })
    missionId?: string | null;

    /**
     * Human-readable failure reason when `status = FAILED` (spec
     * §3.9). Rendered inline on the Idea Card below the title in
     * a muted danger block (truncated to ~200 chars, expandable
     * to the full message). Persisted by the Goal-completion
     * handler (Phase 1 PR FF) on terminal failure; cleared by
     * `POST /me/work-proposals/:id/retry`. NULL on all non-FAILED
     * Ideas.
     */
    @Column({ type: 'text', nullable: true })
    failureMessage?: string | null;

    /**
     * Classification of the failure for auto-retry decision-making
     * (spec §3.9 / Decision A23). One of `IdeaFailureKind` values.
     * `transient-*` kinds are eligible for auto-retry per the
     * user's `maxAutoRetries` / `backoffSeconds` /
     * `exponentialBackoffFactor` policy. `permanent-*` kinds skip
     * auto-retry — the user can still manually click `Retry` to
     * try again. NULL on all non-FAILED Ideas.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    failureKind?: IdeaFailureKind | null;

    @CreateDateColumn()
    generatedAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
