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
import { Agent } from './agent.entity';
import { RepoConnection } from './repo-connection.entity';

/**
 * Agent → RepoConnection edge table (Feature G — repository registry).
 * Grants a specific Agent access to a registry repository; the future
 * per-agent Capabilities page reads/writes these rows, and provisioning
 * (claude-managed-agent sessions, later multi-mount workspaces) resolves
 * an agent's ENABLED attachments into extra mounted repositories.
 *
 * Same edge-table shape as {@link AgentAttachment} (agent ↔ upload).
 * `enabled` allows keeping an attachment configured but temporarily off
 * without losing it. Cross-user reads must 404 (userId denorm).
 */
@Entity({ name: 'agent_repo_attachments' })
@Index('uq_agent_repo_attachment', ['agentId', 'repoConnectionId'], { unique: true })
@Index('idx_agent_repo_attachment_repo', ['repoConnectionId'])
@Index('idx_agent_repo_attachment_user', ['userId'])
export class AgentRepoAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'agentId' })
    agent?: Agent;

    @Column({ type: 'uuid' })
    repoConnectionId: string;

    @ManyToOne(() => RepoConnection, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'repoConnectionId' })
    repoConnection?: RepoConnection;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    // EW-651/657 Tier C scope denormalization. No @ManyToOne — the
    // no-cycle rule for scope entities (see user.entity.ts EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
