import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import type { ClassToObject } from './types';
import { TimestampColumn } from './_types';

@Entity({ name: 'api_keys' })
@Index(['hashedKey'], { unique: true })
@Index(['userId'])
export class ApiKey {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    user: ClassToObject<User>;

    @Column({ length: 100 })
    name: string;

    @Column({ unique: true })
    hashedKey: string;

    @Column({ length: 12 })
    prefix: string;

    @TimestampColumn({ nullable: true })
    expiresAt: Date | null;

    @TimestampColumn({ nullable: true })
    lastUsedAt: Date | null;

    @Column({ default: true })
    isActive: boolean;

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
}
