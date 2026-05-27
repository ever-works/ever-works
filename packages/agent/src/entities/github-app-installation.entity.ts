import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'github_app_installations' })
@Index(['installationId'], { unique: true })
export class GitHubAppInstallation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    installationId: string;

    @Column({ type: 'varchar', nullable: true })
    appSlug?: string | null;

    @Column({ type: 'varchar' })
    accountLogin: string;

    @Column({ type: 'varchar' })
    accountType: string;

    @Column({ type: 'varchar' })
    targetType: string;

    @Column({ type: 'varchar', nullable: true })
    createdByUserId?: string | null;

    @Column({ type: 'varchar', nullable: true })
    createdByGithubUserId?: string | null;

    @PortableDateColumn({ nullable: true })
    suspendedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    deletedAt?: Date | null;

    @Column({ type: 'simple-json', nullable: true })
    rawPayload?: Record<string, unknown> | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
