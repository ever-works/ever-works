import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { McpServerConnection } from './mcp-server-connection.entity';
import { User } from './user.entity';

/**
 * Agent Plugins MCP slice (plan §2.5, entity `agent_mcp_server_bindings`)
 * — which MCP connections an Agent actually gets, following the
 * `skill_bindings` template.
 *
 * Resolution semantics (narrow-only, like tool grants):
 *
 *   - `targetType='tenant'` (targetId NULL): the connection is inherited
 *     by ALL of the user's agents. Created enabled=true alongside the
 *     connection so a fresh manual connection is usable immediately.
 *   - `targetType='agent'`: a per-agent OVERRIDE row. enabled=false
 *     disables an inherited connection for that agent; enabled=true binds
 *     a connection that has no (or a disabled) tenant binding to just
 *     that agent. Deleting the agent row reverts to inheritance.
 *   - A disabled connection (`mcp_server_connections.enabled=false`)
 *     contributes no tools regardless of bindings.
 *
 * v1 API creates 'agent' + 'tenant' targets only; the column shape
 * matches the merged spec so 'work' targets can land later without a
 * migration to the unique index.
 */
export type McpBindingTargetType = 'agent' | 'tenant';

@Entity({ name: 'agent_mcp_server_bindings' })
@Index('uq_mcp_binding', ['connectionId', 'targetType', 'targetId'], { unique: true })
@Index('idx_mcp_binding_target', ['targetType', 'targetId'])
@Index('idx_mcp_binding_user', ['userId'])
export class AgentMcpServerBinding {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    connectionId: string;

    @ManyToOne(() => McpServerConnection, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'connectionId' })
    connection?: McpServerConnection;

    @Column({ type: 'varchar', length: 16 })
    targetType: McpBindingTargetType;

    /** NULL when targetType='tenant' (the userId identifies the binding). */
    @Column({ type: 'uuid', nullable: true })
    targetId?: string | null;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
