import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { ModelAccountHealth } from '@ever-works/contracts';
import { EncryptedJsonColumn } from './_secret-json-column';
import { PortableDateColumn } from './_types';

/**
 * Model accounts (AW-16) — one set of credentials for one AI-provider plugin,
 * held by a workspace.
 *
 * # Why a row of its own
 *
 * A provider's credential lives today in that plugin's settings record — one
 * blob per scope, so exactly one credential per provider. A second account
 * for the same provider, and therefore an order between them, a per-account
 * health state and a per-account "last used", has nowhere to exist there.
 * Plugin settings keep working unchanged: a workspace with no account row
 * resolves credentials exactly as before.
 *
 * # Workspace key
 *
 * `workspaceKey` is `org:<organizationId>` for an organization and
 * `user:<userId>` for a personal workspace. It is never null, so the unique
 * label index holds in both Postgres and SQLite (both treat NULLs as distinct
 * inside a unique index). `tenantId` / `organizationId` are the usual scope
 * stamps; `userId` is who created the row.
 *
 * # Credentials
 *
 * `credentials` is keyed exactly as the provider plugin's settings schema
 * names its secret (`x-secret`) fields, envelope-encrypted at rest by the
 * same transformer plugin secret settings use, and never serialised outward —
 * API responses are built by an explicit mapper that has no credential field.
 *
 * `position` is 1..N, contiguous within (workspace, provider), and is the
 * order accounts are used in. It is service-maintained rather than
 * index-enforced so a reorder can swap two rows without a deferred constraint
 * (not portable to SQLite).
 *
 * No `@ManyToOne` relations — the known entities import cycle every
 * tenant-scoped entity avoids (see `user.entity.ts`). FKs live in the
 * migration.
 */
@Entity({ name: 'model_accounts' })
@Index(
    'uq_model_accounts_workspace_provider_label',
    ['workspaceKey', 'providerPluginId', 'label'],
    {
        unique: true,
    },
)
@Index('idx_model_accounts_workspace_provider_position', [
    'workspaceKey',
    'providerPluginId',
    'position',
])
@Index('idx_model_accounts_checked', ['enabled', 'lastCheckedAt'])
export class ModelAccount {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Who created the account. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** `org:<organizationId>` or `user:<userId>` — see the class comment. */
    @Column({ type: 'varchar', length: 80 })
    workspaceKey: string;

    /** Id of an installed plugin with the ai-provider capability. */
    @Column({ type: 'varchar', length: 128 })
    providerPluginId: string;

    /** Owner-chosen name, 1–60 characters, unique within its provider. */
    @Column({ type: 'varchar', length: 60 })
    label: string;

    /** 1..N within (workspace, provider). The order accounts are used in. */
    @Column({ type: 'int' })
    position: number;

    /** working | expiring | expired | invalid | paused | unknown */
    @Column({ type: 'varchar', length: 16, default: 'unknown' })
    health: ModelAccountHealth;

    /** False = paused by the owner. Skipped when routing; keeps position and history. */
    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    /** The provider's own secret settings. Encrypted at rest; never returned. */
    @EncryptedJsonColumn({ nullable: true })
    credentials?: Record<string, string> | null;

    /** Bumped on every credential write. */
    @Column({ type: 'int', default: 1 })
    credentialVersion: number;

    @PortableDateColumn({ nullable: true })
    credentialExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastCheckedAt?: Date | null;

    /** Minute precision — written at most once a minute per account. */
    @PortableDateColumn({ nullable: true })
    lastUsedAt?: Date | null;

    /** rate_limited | credential | transient. NULL = no cooldown. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    cooldownReason?: string | null;

    @PortableDateColumn({ nullable: true })
    cooldownUntil?: Date | null;

    @Column({ type: 'int', default: 0 })
    consecutiveFailures: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
