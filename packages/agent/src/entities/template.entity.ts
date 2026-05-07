import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type TemplateKind = 'website' | 'work';
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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
