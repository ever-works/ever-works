import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Provenance for the `Organization` row — how it came to exist.
 *
 * `manual`       — created via the Settings UI / API directly.
 * `stripe-atlas` — created as a side-effect of a Work-of-type-Company
 *                  reaching `registered` status (Phase 10 / EW-662).
 *
 * Open string column (not an enum at the DB level) so future providers
 * (Firstbase, Doola, etc.) can extend without a schema change. Code
 * pinning lands in `OrganizationService` (Phase 6).
 */
export type OrganizationRegistrationProvider = 'manual' | 'stripe-atlas' | (string & {});

/**
 * Lifecycle of the Organization's registration with its provider.
 *
 * `draft`      — record exists but provider work hasn't started.
 * `pending`    — provider workflow in flight (e.g. Stripe Atlas
 *                paperwork submitted, awaiting confirmation).
 * `registered` — provider returned success; org is a real legal entity.
 *
 * Manual orgs ([spec.md §5.2 Settings path](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization))
 * land directly in `registered`. Stripe-Atlas orgs traverse the full
 * lifecycle.
 */
export type OrganizationRegistrationStatus = 'draft' | 'pending' | 'registered';

/**
 * EW-653 (Tenants & Organizations Phase 1) — user-facing scope inside a
 * Tenant. See
 * [spec.md §1.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#12-organization-user-facing--ui-label-varies).
 *
 * **UI label varies by surface:**
 * - "Organization" — Settings, WorkspaceSwitcher (EW-660 Phase 8).
 * - "Company"      — `+ New` page chip + Stripe Atlas flow (EW-662 Phase 10).
 *
 * Same DB row either way. The wording-vs-DB split is intentional —
 * "Company" reads naturally to founders, but "Organization" is the
 * internal name across the API and DB.
 *
 * **Cardinality:** 1 Tenant : 0..N Organizations. Created via either:
 *   1. `POST /api/organizations` from the Settings / Switcher modal
 *      (Phase 6 / EW-658), or
 *   2. A Work of type Company transitioning to `registered` status —
 *      the Phase 10 wire-up creates the `Organization` row with
 *      `linkedWorkId` pointing at the Work.
 *
 * **Slug:** globally unique across the `organizations` table.
 * Cross-table collision against `users.slug` and `tenants.slug` is
 * enforced by `UsernameAllocatorService.allocateSlug` (EW-652) at
 * write time, not at DB level.
 *
 * Indexes:
 * - UNIQUE on `slug` — required for the routing layer (Phase 7).
 * - `idx_organizations_tenant_created` on `(tenantId, createdAt)` —
 *   feeds the WorkspaceSwitcher's "list my Orgs" query, ordered by
 *   creation time so newer Orgs naturally appear at the top.
 */
@Entity({ name: 'organizations' })
@Index('idx_organizations_tenant_created', ['tenantId', 'createdAt'])
export class Organization {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * FK to `tenants.id`. Cascade ON DELETE is enforced by the
     * migration's `fk_organizations_tenant` FK constraint.
     *
     * As with `Tenant.ownerUserId`, we intentionally do NOT declare
     * a `@ManyToOne(() => Tenant)` relation here — importing `Tenant`
     * would extend the user/tenant/organization import cycle
     * (User → Organization → Tenant → User) and crash ESM / vitest
     * with TDZ errors. Phase 6 services do explicit
     * `tenantRepository.findById(org.tenantId)` lookups when they
     * need the parent Tenant.
     */
    @Column('uuid')
    tenantId: string;

    /**
     * URL-safe slug. Globally unique across the `organizations` table.
     * Used as the URL path segment by the slug routing layer (Phase 7 /
     * EW-659): `/{slug}/missions/...`. Allocated by
     * `UsernameAllocatorService` with cross-table collision checks
     * against `users.slug` and `tenants.slug`.
     */
    @Column({ type: 'varchar', length: 64, unique: true })
    slug: string;

    /**
     * Registered legal name (if applicable) — e.g. "Acme, Inc." for an
     * Org backed by a Stripe Atlas registration. Nullable for
     * unregistered Orgs (e.g. an unincorporated team's draft).
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    legalName?: string | null;

    /**
     * Human-friendly name shown in the WorkspaceSwitcher and Settings.
     * Falls back to `legalName` when present, otherwise prompts the
     * user for a name at create time.
     */
    @Column({ type: 'varchar', length: 200 })
    displayName: string;

    /**
     * ISO 3166-1 alpha-2 country code (e.g. "US", "DE"). Used by the
     * Stripe Atlas integration to route to the right entity-formation
     * pipeline. Nullable until a provider workflow specifies a
     * jurisdiction.
     */
    @Column({ type: 'varchar', length: 2, nullable: true })
    countryCode?: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    registrationProvider?: OrganizationRegistrationProvider | null;

    @Column({ type: 'varchar', length: 16, default: 'draft' })
    registrationStatus: OrganizationRegistrationStatus;

    /**
     * Optional pointer back to the Work-of-type-Company that produced
     * this Organization (Phase 10 wire-up). NULL for Orgs created
     * directly via the Settings UI or `POST /api/organizations`.
     *
     * Stored here as a UUID without an FK constraint — `works.id` is a
     * UUID column but adding the FK from the agent package would
     * create a circular dependency between `Organization` and `Work`
     * (Work already has `organizationId` going the other direction,
     * which is upgraded to a real FK in Phase 4 / EW-656). The FK on
     * THIS column can be added in a later phase if the constraint
     * proves valuable; for now, the relationship is service-enforced.
     */
    @Column({ type: 'uuid', nullable: true })
    linkedWorkId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
