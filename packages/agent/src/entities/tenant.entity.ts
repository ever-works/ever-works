import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * EW-653 (Tenants & Organizations Phase 1) — internal-only scope
 * primitive. Every business-level row in the system eventually carries
 * `tenantId` pointing here. See
 * [spec.md §1.1](../../../../docs/specs/features/tenants-and-organizations/spec.md#11-tenant-internal-only-never-shown-in-ui)
 * for the full design.
 *
 * **Never appears in the UI** — the user-facing concepts are
 * `Organization` (settings, switcher) and `Company` (`+ New` chip,
 * Stripe Atlas flow). Both map to `Organization` rows under the
 * Tenant. The Tenant is the always-present default container.
 *
 * **Cardinality:** 1 User : 1 Tenant. The Tenant row is created
 * lazily the first time the user creates an Organization (Phase 6 /
 * EW-658). Existing users have `tenantId = NULL` on their `User` row
 * and have no Tenant at all until that moment.
 *
 * **Slug:** mirrors `users.slug` at creation time so the bare-Tenant
 * URL view (`/{userSlug}/missions/...`) resolves correctly. Globally
 * unique within the `tenants` table; the `UsernameAllocatorService`
 * (EW-652 Phase 0) also enforces no cross-table collision against
 * `users.slug` and `organizations.slug` at write time.
 */
@Entity({ name: 'tenants' })
export class Tenant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * FK back to the User that owns this Tenant. 1:1 for v1 — multi-
     * tenant per user is a v1.1 consideration (would require dropping
     * the UNIQUE constraint on this column). The reverse relation lives
     * on the User entity as `tenantId` (added in Phase 2 / EW-654).
     */
    @Column('uuid', { unique: true })
    ownerUserId: string;

    @OneToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'ownerUserId' })
    ownerUser?: User;

    /**
     * URL-safe slug. Mirrors `users.slug` for the bare-Tenant view's URL
     * resolution. Globally unique across the `tenants` table; the
     * cross-table collision check (vs `users.slug` and
     * `organizations.slug`) is enforced by `UsernameAllocatorService`
     * at write time, not at DB level.
     */
    @Column({ type: 'varchar', length: 64 })
    slug: string;

    /**
     * Human-readable name surfaced internally (admin tooling, logs).
     * Falls back to the owner's `username` at create time. Never shown
     * to end users.
     */
    @Column({ type: 'varchar', length: 200 })
    displayName: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
