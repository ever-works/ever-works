import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { sanitizeMergePolicyOverride, type MergePolicyOverride } from '@ever-works/contracts';
import { Tenant } from '../../entities/tenant.entity';

/**
 * EW-653 (Tenants & Organizations Phase 1) — repository for the
 * `tenants` table.
 *
 * Mostly accessed indirectly via `User.tenantId` (Phase 2). The two
 * direct lookups exposed today are used by the slug routing middleware
 * (Phase 7) and by the lazy-create flow that the Organization-create
 * endpoint runs on first-Org (Phase 6).
 */
@Injectable()
export class TenantRepository {
    constructor(
        @InjectRepository(Tenant)
        private readonly repository: Repository<Tenant>,
    ) {}

    async findById(id: string): Promise<Tenant | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * Used by `TenantBootstrapService.ensureTenant(userId)` to check
     * whether the user already has a Tenant before lazy-creating one.
     */
    async findByOwnerUserId(ownerUserId: string): Promise<Tenant | null> {
        return this.repository.findOne({ where: { ownerUserId } });
    }

    /**
     * Used by the slug routing middleware (Phase 7) as part of the
     * `users.slug → bare-Tenant` resolution path. Case-sensitive — the
     * allocator guarantees slugs are always stored lowercase.
     */
    async findBySlug(slug: string): Promise<Tenant | null> {
        return this.repository.findOne({ where: { slug } });
    }

    async create(data: Partial<Tenant>): Promise<Tenant> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async save(tenant: Tenant): Promise<Tenant> {
        return this.repository.save(tenant);
    }

    /**
     * Merge-policy matrix (Wave 3, D4) — the TENANT write path.
     *
     * INTERNAL-ONLY BY CONTRACT. Tenants are not a user-facing entity: they
     * are lazily created, never listed, and never rendered, so this is the
     * one column on the row an operator has any reason to set. Its only
     * caller is `OperatorTenantMergePolicyController`, which sits behind
     * `IsPlatformAdminGuard` (`User.isPlatformAdmin === true`) exactly like
     * the sibling operator surfaces. There is deliberately no tenant-self
     * PATCH: a tenant-scoped policy is the operator's CEILING over every
     * organization beneath it, and a ceiling anyone underneath can raise is
     * not a ceiling.
     *
     * Storage shape matches the other three scopes: a sanitized PARTIAL
     * (drop-if-unrecognized, never coerce), and an override that sanitizes
     * down to `{}` is stored as NULL so "inherit" has exactly one
     * representation at rest.
     *
     * @returns the updated row, or `null` when no such tenant exists.
     */
    async updateMergePolicy(
        tenantId: string,
        mergePolicy: MergePolicyOverride | null,
    ): Promise<Tenant | null> {
        const existing = await this.repository.findOne({ where: { id: tenantId } });
        if (!existing) return null;
        let next: MergePolicyOverride | null = null;
        if (mergePolicy) {
            const sanitized = sanitizeMergePolicyOverride(mergePolicy);
            next = Object.keys(sanitized).length > 0 ? sanitized : null;
        }
        await this.repository.update(tenantId, { mergePolicy: next });
        return this.repository.findOne({ where: { id: tenantId } });
    }
}
