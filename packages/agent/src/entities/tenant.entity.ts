import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

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
     * FK to `users.id`. 1:1 for v1 — multi-tenant per user is a v1.1
     * consideration (would require dropping the UNIQUE constraint on
     * this column). The cascade ON DELETE is enforced at the DB level
     * by the migration's `fk_tenants_owner_user` FK constraint.
     *
     * We intentionally do NOT declare a `@OneToOne(() => User)`
     * relation here because importing `User` into this file creates
     * an import cycle (User entity also imports Tenant for its
     * `@ManyToOne(() => Tenant)` relation), which ESM / vitest crash
     * on with "Cannot access 'User' before initialization" TDZ
     * errors. Phase 6 services that need the owner User do an
     * explicit `userRepository.findById(tenant.ownerUserId)` lookup.
     */
    @Column('uuid', { unique: true })
    ownerUserId: string;

    /**
     * URL-safe slug. Mirrors `users.slug` for the bare-Tenant view's URL
     * resolution. Globally unique across the `tenants` table (enforced
     * by `idx_tenants_slug_unique` in the migration AND by `unique: true`
     * here for synchronize-based contexts — the CLI/local SQLite path
     * and in-memory integration tests build schemas from entity
     * decorators, not migrations). The cross-table collision check
     * (vs `users.slug` and `organizations.slug`) is enforced by
     * `UsernameAllocatorService` at write time.
     */
    @Column({ type: 'varchar', length: 64, unique: true })
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
