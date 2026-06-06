import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

export type OnboardingStatus =
    | 'received'
    | 'validating'
    | 'validated'
    | 'queued'
    | 'generating'
    | 'deployed'
    | 'failed'
    | 'rejected';

// Security: constrain failureDetail to prevent raw Error objects (containing
// stack traces and internal paths) from being serialized into the database
// and subsequently returned to callers via status-poll endpoints.
export interface OnboardingFailureDetail {
    message: string;
    code?: string;
}

@Entity({ name: 'onboarding_requests' })
@Index(['githubIdentityHash', 'repoUrlCanonical'], { unique: true })
@Index(['repoUrlCanonical'])
@Index(['workId'])
@Index(['accountId'])
export class OnboardingRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 64 })
    githubIdentityHash: string;

    @Column({ type: 'varchar', length: 512 })
    repoUrlCanonical: string;

    @Column({ type: 'varchar', length: 320, nullable: true })
    contactEmail: string | null;

    @Column({ type: 'varchar', length: 256, nullable: true })
    agentId: string | null;

    @Column({ type: 'uuid', nullable: true })
    accountId: string | null;

    @Column({ type: 'uuid', nullable: true })
    workId: string | null;

    @Column({ type: 'varchar', length: 64 })
    status: OnboardingStatus;

    @Column({ type: 'varchar', length: 128, nullable: true })
    failureCode: string | null;

    // Security: typed to OnboardingFailureDetail (not `unknown`) so callers
    // cannot pass raw Error objects with stack traces or internal path names.
    @Column({ type: 'simple-json', nullable: true })
    failureDetail: OnboardingFailureDetail | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    idempotencyKey: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    webhookUrl: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    subdomain: string | null;

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
