import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/** Where one keyed company import stands. */
export type OrganizationCompanyImportStatus = 'running' | 'created' | 'failed';

/**
 * One keyed import of a company template into an existing Organization, so an
 * import retried under its key never creates anything twice. `reportJson` holds
 * the import's counts.
 */
@Entity({ name: 'organization_company_imports' })
@Index('uq_organization_company_imports_key', ['organizationId', 'importKey'], { unique: true })
export class OrganizationCompanyImport {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @Column({ type: 'varchar', length: 200 })
    importKey: string;

    @Column({ type: 'varchar', length: 128 })
    templateSlug: string;

    @Column({ type: 'varchar', length: 16 })
    status: OrganizationCompanyImportStatus;

    @Column({ type: 'simple-json', nullable: true })
    reportJson: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
