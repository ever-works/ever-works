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
    | 'other';

export const AGENT_ACTION_PROPOSAL_ACTION_TYPES: readonly AgentActionProposalActionType[] = [
    'spawn_agent',
    'schedule_task',
    'send_message',
    'budget_override',
    'other',
] as const;

export type AgentActionProposalStatus = 'pending' | 'approved' | 'rejected';

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
