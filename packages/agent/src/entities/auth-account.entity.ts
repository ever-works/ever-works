import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Exclude } from 'class-transformer';
import { PortableDateColumn } from './_types';

@Entity({ name: 'account' })
@Index(['providerId', 'accountId'], { unique: true })
@Index(['userId', 'providerId'], { unique: true })
export class AuthAccount {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar' })
    accountId: string;

    @Column({ type: 'varchar' })
    providerId: string;

    // Security: secret. @Exclude() keeps OAuth tokens / credential hash out of
    // any class-transformer serialization (instanceToPlain / ClassSerializerInterceptor)
    // so an accidental endpoint or log that serializes the raw entity cannot leak
    // them. Server-side consumers read these via direct property access, which
    // @Exclude() does not affect, so OAuth/git flows are unchanged.
    @Exclude()
    @Column({ type: 'text', nullable: true })
    accessToken?: string | null;

    @Exclude()
    @Column({ type: 'text', nullable: true })
    refreshToken?: string | null;

    @Column({ type: 'varchar', nullable: true })
    username?: string | null;

    @Column({ type: 'varchar', nullable: true })
    email?: string | null;

    @Column({ type: 'varchar', nullable: true })
    tokenType?: string | null;

    @PortableDateColumn({ nullable: true })
    accessTokenExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    refreshTokenExpiresAt?: Date | null;

    // Security: secret (granted OAuth scopes can reveal token power). @Exclude().
    @Exclude()
    @Column({ type: 'text', nullable: true })
    scope?: string | null;

    // Security: secret. @Exclude() — see accessToken note above.
    @Exclude()
    @Column({ type: 'text', nullable: true })
    idToken?: string | null;

    // Security: credential password hash. @Exclude() — see accessToken note above.
    @Exclude()
    @Column({ type: 'text', nullable: true })
    password?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, any> | null;

    // EW-654 (Tenants & Organizations Phase 2) — Tier B scope. NULL
    // until the owning user creates their first Organization (Phase 6).
    // Tier B has no organizationId; auth records are user-identity,
    // not Org-scoped. See spec.md §2.3.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
