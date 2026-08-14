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
import { EncryptedJsonColumn } from './_secret-json-column';

/**
 * Agent Plugins MCP slice (docs/specs/features/agent-plugins, plan §2.4/§2.5)
 * — the workspace-global registry of EXTERNAL MCP servers an Agent can be
 * bound to.
 *
 * v1 ships the founder-added `manual` source: a user pastes a URL + auth
 * header and the connection becomes bindable without the package system
 * (T1–T22). The `source` column reserves `'package'` so the later
 * agent-plugins package work lands on top without a schema change.
 *
 * `name` is slug-safe and becomes the `<server>` segment of the
 * `mcp__<server>__<tool>` tool names, so it is unique per user and capped
 * at 80 chars. NO stdio in v1 (ADR-018 execution gate; manual connections
 * are network-only: streamable-http or legacy sse).
 *
 * `authHeaders` is an encrypted `{headerName: value}` map (same
 * `EncryptedJsonColumn` envelope as notification channel secrets). Values
 * are NEVER echoed by the API — responses carry header names only.
 */
export type McpConnectionTransport = 'streamable-http' | 'sse';
export type McpConnectionSource = 'manual' | 'package';

export const MCP_CONNECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

@Entity({ name: 'mcp_server_connections' })
@Index('uq_mcp_connection_user_name', ['userId', 'name'], { unique: true })
@Index('idx_mcp_connection_user', ['userId'])
export class McpServerConnection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** Slug-safe server name — the `<server>` in `mcp__<server>__<tool>`. */
    @Column({ type: 'varchar', length: 80 })
    name: string;

    @Column({ type: 'varchar', length: 2048 })
    url: string;

    @Column({ type: 'varchar', length: 16, default: 'streamable-http' })
    transport: McpConnectionTransport;

    /**
     * Encrypted `{headerName: value}` map injected as client-generated
     * headers at connect time (spec AP-15). Never logged, never echoed.
     */
    @EncryptedJsonColumn({ nullable: true })
    authHeaders?: Record<string, string> | null;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    /** 'manual' in v1; 'package' reserved for the agent-plugins package work. */
    @Column({ type: 'varchar', length: 16, default: 'manual' })
    source: McpConnectionSource;

    @Column({ type: 'timestamp', nullable: true })
    lastConnectedAt?: Date | null;

    /** Classified message of the last failed connect/list/call — never carries header values. */
    @Column({ type: 'text', nullable: true })
    lastError?: string | null;

    // Tenant + Organization scope FKs (EW-651 Tier A denormalization).
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
