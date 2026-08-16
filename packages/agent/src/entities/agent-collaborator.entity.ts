import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Agent Collaborators — the per-agent allow-list of OTHER agents this
 * agent may spawn/delegate to as sub-agents.
 *
 * One row per (agentId, collaboratorAgentId) pair the owner has ever
 * configured; `enabled` carries the toggle state so switching a
 * collaborator off is a cheap UPDATE that keeps the row (and its
 * history) instead of deleting it.
 *
 * Semantics (enforced by `SubAgentDelegationRunnerService` through the
 * pure `evaluateCollaboratorDelegation` helper in `@ever-works/contracts`):
 *
 *  - NO rows for an agent  ⇒ legacy behaviour — the agent may delegate
 *    only to itself (childAgentId empty / equal to the parent).
 *  - Rows exist            ⇒ a named child must be the parent itself OR
 *    an `enabled` collaborator row; otherwise the delegation is refused
 *    with `collaborator-not-allowed`.
 *
 * `agentId !== collaboratorAgentId` is a service-layer guard
 * (`AgentCollaboratorRepository.upsert` throws) — self-delegation is
 * always allowed implicitly and must never be materialised as a row.
 *
 * No @ManyToOne on purpose (EW-654 no-cycle rule) — raw uuid columns;
 * FKs to `agents.id` (CASCADE both ends) ship in the migration.
 * Cascade: deletes with EITHER agent.
 */
@Entity({ name: 'agent_collaborators' })
@Index('uq_agent_collaborator', ['agentId', 'collaboratorAgentId'], { unique: true })
@Index('idx_agent_collaborators_collaborator', ['collaboratorAgentId'])
export class AgentCollaborator {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of BOTH agents — collaborator edges never cross users. */
    @Column('uuid')
    @Index('idx_agent_collaborators_user')
    userId: string;

    /** The parent agent whose allow-list this row belongs to. */
    @Column('uuid')
    agentId: string;

    /** The agent the parent is allowed to spawn as a sub-agent. */
    @Column('uuid')
    collaboratorAgentId: string;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    // Tenant + Organization scope FKs (EW-651 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
