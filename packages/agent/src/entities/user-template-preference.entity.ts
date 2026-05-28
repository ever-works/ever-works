import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { TemplateKind } from './template.entity';

@Entity({ name: 'user_template_preferences' })
@Index(['userId', 'kind'], { unique: true })
@Index(['templateId'])
export class UserTemplatePreference {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar', length: 32 })
    kind: TemplateKind;

    @Column({ type: 'varchar', length: 120 })
    templateId: string;

    // EW-654 (Tenants & Organizations Phase 2) — Tier B scope. NULL
    // until the owning user creates their first Organization.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
