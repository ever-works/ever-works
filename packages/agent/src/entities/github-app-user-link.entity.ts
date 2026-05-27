import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'github_app_user_links' })
@Index(['userId'], { unique: true })
@Index(['githubUserId'], { unique: true })
export class GitHubAppUserLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar' })
    githubUserId: string;

    @Column({ type: 'varchar' })
    githubLogin: string;

    @Column({ type: 'varchar', nullable: true })
    githubNodeId?: string | null;

    @Column({ type: 'text', nullable: true })
    accessToken?: string | null;

    @Column({ type: 'text', nullable: true })
    refreshToken?: string | null;

    @PortableDateColumn({ nullable: true })
    accessTokenExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    refreshTokenExpiresAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    scope?: string | null;

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
