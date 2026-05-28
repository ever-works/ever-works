import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Phase 8 PR W — `'mission'` joins the union so Mission Templates
// (per spec §10) can live alongside the existing website/work
// templates in the catalog. The DB column is `varchar(32)` so
// the new value fits without a migration; PR X seeds the
// Mission Template repos.
export type TemplateKind = 'website' | 'work' | 'mission';
export type TemplateSourceType = 'built_in' | 'custom';

@Entity({ name: 'templates' })
@Index(['kind', 'sourceType', 'isActive'])
@Index(['ownerUserId', 'kind'])
export class Template {
    @PrimaryColumn({ type: 'varchar', length: 120 })
    id: string;

    @Column({ type: 'varchar', length: 32 })
    kind: TemplateKind;

    @Column({ type: 'varchar', length: 32, default: 'built_in' })
    sourceType: TemplateSourceType;

    @Column({ type: 'varchar', nullable: true })
    ownerUserId?: string | null;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    @Column({ type: 'varchar', length: 80, nullable: true })
    framework?: string | null;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    previewImageUrl?: string | null;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    repositoryUrl?: string | null;

    @Column({ type: 'varchar', length: 255 })
    repositoryOwner: string;

    @Column({ type: 'varchar', length: 255 })
    repositoryName: string;

    @Column({ type: 'varchar', length: 255, default: 'main' })
    branch: string;

    @Column('simple-json', { default: '[]' })
    syncBranches: string[];

    @Column({ type: 'varchar', length: 255, nullable: true })
    betaBranch?: string | null;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @Column('simple-json', { default: '{}' })
    metadata: Record<string, unknown>;

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
