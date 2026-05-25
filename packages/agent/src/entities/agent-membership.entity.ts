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
 * Explicit membership of a tenant-scoped Agent in a Mission / Idea /
 * Work. Mission/Idea/Work-scoped Agents derive memberships from their
 * primary scope — they don't need rows here. Tenant Agents either have
 * no rows (implicit "available to all") or carry one row per concrete
 * target so we can filter `/missions/:id/agents` etc. via indexed query
 * rather than scanning every tenant agent's JSON `targets` array.
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

	@Column({ length: 16 })
	targetType: AgentMembershipTargetType;

	@Column('uuid', { nullable: true })
	targetId?: string | null;

	@CreateDateColumn()
	createdAt: Date;
}
