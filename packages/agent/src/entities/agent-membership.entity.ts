import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Polymorphic target of a tenant-scoped Agent membership
 * (architecture/agents-skills-tasks.md §3, agents/spec.md §3.4 FR-29).
 *
 * - `mission` / `idea` / `work` — concrete reach (with `targetId` set).
 * - `wildcard`                  — explicit "all the user's targets in this
 *                                 kind"; `targetId` is null.
 */
export type AgentMembershipTargetType = 'mission' | 'idea' | 'work' | 'wildcard';

/**
 * Explicit membership of an Agent in a Mission / Idea / Work — one row
 * per concrete entry of the Agent's JSON `targets`, so surfaces like
 * `/missions/:id/agents` and the Work header's Agents dropdown can
 * filter by indexed query instead of scanning every Agent's targets.
 *
 * An Agent's OWN scope parent is not recorded here: a Work-scoped Agent
 * reaches its Work by scope, and those surfaces query that separately.
 * Rows appear only for reach the Agent was explicitly lent — which any
 * Agent can be, whatever its own scope (see `AgentsService.addTarget`).
 * No rows at all means "no explicit targets", which for a tenant Agent
 * reads as the implicit "available to all".
 *
 * Cascade: deletes with the Agent.
 */
@Entity({ name: 'agent_memberships' })
@Index('uq_agent_membership', ['agentId', 'targetType', 'targetId'], { unique: true })
@Index('idx_agent_memberships_target', ['targetType', 'targetId'])
export class AgentMembership {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    agentId: string;

    @Column({ type: 'varchar', length: 16 })
    targetType: AgentMembershipTargetType;

    @Column('uuid', { nullable: true })
    targetId?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
