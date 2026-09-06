import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Agent Action Approval Queue — the human-in-the-loop gate for
 * side-effectful actions an Agent wants to take.
 *
 * An Agent (or the platform on its behalf) proposes an action —
 * spawning a sub-agent, scheduling a task, sending a connector
 * message, overriding a budget — and it lands here as a PENDING row.
 * A human approves or rejects it; the decision (who + when) is
 * recorded on the same row. Actually executing / resuming the
 * approved action is a follow-up increment — this entity is the
 * durable queue + decision record only.
 *
 * Tier A entity (Tenants & Organizations spec §2.3): carries BOTH
 * `tenantId` and `organizationId` as nullable uuid columns. Auto-
 * stamped on insert by `ScopeStampingSubscriber` from the active
 * request scope; FK + index added at the DB level by the
 * `1781700000000-CreateAgentActionProposals` migration.
 *
 * `agentId` is a raw uuid column — deliberately NOT an `@ManyToOne`
 * to the scope/Agent entities — to avoid the forward-import cycle
 * that bit the Agent entity's Phase-2 scope refs. FK constraints are
 * added by the migration, not the decorator.
 */
export type AgentActionProposalActionType =
    | 'spawn_agent'
    | 'schedule_task'
    | 'send_message'
    | 'budget_override'
    // Merge approval (self-build slice AE, EW-805). The ONE action type
    // whose approved row is READ BACK and enforced: `MergeApprovalService`
    // looks it up by {@link AgentActionProposal.subjectKey} and the git
    // facade refuses the merge without it. Every other type is still a
    // durable decision record only.
    | 'merge_pull_request'
    | 'other';

export const AGENT_ACTION_PROPOSAL_ACTION_TYPES: readonly AgentActionProposalActionType[] = [
    'spawn_agent',
    'schedule_task',
    'send_message',
    'budget_override',
    'merge_pull_request',
    'other',
] as const;

export type AgentActionProposalStatus = 'pending' | 'approved' | 'rejected';

/**
 * How a decided proposal got its decision:
 *   - `user`      — a human approved/rejected it in the queue UI.
 *   - `guardrail` — the owning Agent's dispatch guardrails auto-decided
 *                   it at creation time (auto-approve or block).
 * Null while the proposal is still pending.
 */
export type AgentActionProposalDecidedVia = 'user' | 'guardrail';

export const AGENT_ACTION_PROPOSAL_STATUSES: readonly AgentActionProposalStatus[] = [
    'pending',
    'approved',
    'rejected',
] as const;

/**
 * Risk annotations computed by the pure `RISK_SCORER`
 * (agent-approvals/risk-scorer.ts). Surfaced as badges in the queue
 * UI so a human sees why an action needs attention before deciding.
 */
export type AgentActionRiskFlag = 'budget_override' | 'destructive' | 'cross_scope' | 'high_fanout';

/**
 * Free-form action payload. A handful of fields are read by the
 * `RISK_SCORER`; everything else is opaque and round-trips untouched.
 */
export interface AgentActionProposalPayload {
    /** Set by a destructive action (delete / hard-reset / purge). */
    destructive?: boolean;
    // ── merge_pull_request (self-build slice AE) ──────────────────
    // DISPLAY + AUDIT ONLY. The decision is bound by `subjectKey`,
    // never by these — a verifier that trusted the payload would be
    // trusting a JSON blob to say which pull request was approved.
    /** Task the pull request belongs to (also encoded in `subjectKey`). */
    taskId?: string;
    /** Provider pull-request number (also encoded in `subjectKey`). */
    prNumber?: number;
    prUrl?: string | null;
    /** Head commit the approval is for (also encoded in `subjectKey`). */
    headSha?: string;
    /** Base branch the merge would land on, as shown to the approver. */
    targetBranch?: string | null;
    /** `owner/repo`, as shown to the approver. */
    repository?: string | null;
    /** Provider CI verdict at the moment the proposal was raised. */
    ciState?: string | null;
    /** Provider login of the human who approved the PR on the provider, if any. */
    reviewApprovedBy?: string | null;
    /** True when the action reaches into a scope other than the source. */
    crossScope?: boolean;
    /** Source + target scope ids — a mismatch flags `cross_scope`. */
    sourceScope?: string | null;
    targetScope?: string | null;
    /** Depth of a `spawn_agent` fan-out — >= 3 flags `high_fanout`. */
    spawnDepth?: number;
    [key: string]: unknown;
}

@Entity({ name: 'agent_action_proposals' })
@Index('idx_agent_action_proposals_org_status', ['organizationId', 'status'])
@Index('idx_agent_action_proposals_agent', ['agentId'])
@Index('idx_agent_action_proposals_user_status', ['userId', 'status'])
// Merge approval (slice AE) — the verifier's ONLY lookup (exact match on
// actionType + subjectKey, then status) AND the constraint that makes
// `requestMergeApproval` idempotent for real.
//
// UNIQUE, because that method is a check-then-create and its two callers
// live in different processes: the two-minute `task-pr-status-sync` sweep
// in the worker and `?refresh=true` in the API. `TaskPrStatusService`'s
// in-process `inFlight` map does not span them, so without a constraint
// both can find nothing and both can insert — two Approve buttons for one
// merge, of which the second grants a fresh 24h validity window over a
// head the first already covered.
//
// `subjectKey` is NULL for every other action type, and NULLs are
// DISTINCT in a unique index on both Postgres and SQLite, so the rest of
// the queue is unconstrained exactly as before.
@Index('idx_agent_action_proposals_subject', ['actionType', 'subjectKey'], { unique: true })
export class AgentActionProposal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    /** FK to `agents.id` — raw column, no `@ManyToOne` (see class docstring). */
    @Column('uuid')
    agentId: string;

    /** FK to `agent_runs.id` when the proposal originated inside a run. */
    @Column('uuid', { nullable: true })
    runId?: string | null;

    @Column({ type: 'varchar', length: 32 })
    actionType: AgentActionProposalActionType;

    @Column({ type: 'varchar', length: 200 })
    title: string;

    @Column('simple-json')
    payload: AgentActionProposalPayload;

    /**
     * Merge approval (self-build slice AE, EW-805) — WHAT this decision is
     * about, in a form a consumer can look up by equality.
     *
     * For `merge_pull_request` it is
     * `mergeApprovalSubjectKey({ taskId, prNumber, headSha })`, i.e.
     * `merge:<taskId>:<prNumber>:<headSha>`. NULL for every other action
     * type: the rest of the queue is a decision RECORD nothing reads back,
     * so there is nothing to key it by.
     *
     * The column is what makes an approval un-replayable. A decision is
     * consumed only by exact key match, so a merge of a different pull
     * request, of the same pull request at a different head, or of the same
     * PR number under a different Task, all find nothing and refuse. It is
     * written by the platform when the proposal is raised and is never
     * accepted from a model or a request body.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    subjectKey?: string | null;

    /** Computed risk annotations (string[]) — see `RISK_SCORER`. */
    @Column('simple-json')
    riskFlags: AgentActionRiskFlag[];

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: AgentActionProposalStatus;

    /** The user who approved/rejected — null while pending. */
    @Column('uuid', { nullable: true })
    decidedById?: string | null;

    @PortableDateColumn({ nullable: true })
    decidedAt?: Date | null;

    /**
     * `user` | `guardrail` — see {@link AgentActionProposalDecidedVia}.
     * Guardrail-decided rows keep `decidedById` null (no human made
     * the call); user-decided rows carry both.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    decidedVia?: AgentActionProposalDecidedVia | null;

    // Tier A scope FKs (EW-655). Both NULL until the owning user
    // creates their first Organization. No `@ManyToOne` to avoid the
    // entities import cycle; FK + index enforced by the migration.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @PortableDateColumn()
    createdAt: Date;

    @PortableDateColumn()
    updatedAt: Date;
}
