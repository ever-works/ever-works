import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Agent } from './agent.entity';
import { TenantEmailAddress } from './tenant-email-address.entity';

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Dispatch mode for inbound mail (v1.1, spec §12.2). Set per
 * assignment so one address can serve multiple agents differently.
 *
 * - `task-spawn` (default) — each inbound message creates/joins a Task
 * - `conversation` — appends to a per-Agent EmailConversation thread,
 *   processed by the chat-reply path rather than `agent-task-execute`
 */
export type AgentEmailDispatchMode = 'task-spawn' | 'conversation';

/** Direction discriminator — mirrors `tenant_email_addresses.direction`
 *  but restricted to the two concrete directions (an assignment is
 *  always one direction; an address with `direction='both'` can have
 *  separate assignment rows). */
export type AgentEmailAssignmentDirection = 'outbound' | 'inbound';

/**
 * Per-Agent binding to a tenant email address.
 *
 * - Outbound: the Agent's `sendEmail` tool resolves the lowest-priority
 *   outbound assignment as the default `from:` address. Operator can
 *   pin a specific assignment.
 * - Inbound: the inbound webhook dispatcher routes messages on this
 *   address to this Agent using `dispatchMode`.
 *
 * See `docs/specs/features/email-providers/spec.md` §5.
 */
@Entity({ name: 'agent_email_assignments' })
@Index('uq_agent_email_assignment', ['agentId', 'emailAddressId', 'direction'], { unique: true })
@Index('idx_agent_email_assignment_email_direction', ['emailAddressId', 'direction'])
export class AgentEmailAssignment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'agentId' })
    agent?: Agent;

    @Column({ type: 'uuid' })
    emailAddressId: string;

    @ManyToOne(() => TenantEmailAddress, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'emailAddressId' })
    emailAddress?: TenantEmailAddress;

    @Column({ type: 'varchar', length: 16 })
    direction: AgentEmailAssignmentDirection;

    /**
     * Lower = higher precedence. Default 100. The default outbound
     * resolution picks the lowest-priority row; inbound dispatch on a
     * shared address picks the first match by priority.
     */
    @Column({ type: 'int', default: 100 })
    priority: number;

    /**
     * Inbound dispatch mode (spec §12.2). Defaults to `task-spawn`
     * for back-compat; `conversation` opts the Agent into the
     * EmailConversation flow. Ignored when `direction='outbound'`.
     */
    @Column({ type: 'varchar', length: 16, default: 'task-spawn' })
    dispatchMode: AgentEmailDispatchMode;

    @CreateDateColumn()
    createdAt: Date;
}
