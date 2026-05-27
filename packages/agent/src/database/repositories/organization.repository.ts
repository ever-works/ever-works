import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from '../../entities/organization.entity';

/**
 * EW-653 (Tenants & Organizations Phase 1) — repository for the
 * `organizations` table.
 *
 * Phase 1 lands the minimal lookup surface needed by the Phase 6
 * service layer + the Phase 7 slug router:
 *
 *   - `findById` / `findBySlug` — single-row lookups.
 *   - `findByTenantId` — switcher list query (ordered by createdAt
 *     to match the `idx_organizations_tenant_created` index).
 *   - `countByTenantId` — first-Org guard in `upgradeFromAccount`.
 *   - `create` / `save` / `update` — write surface for
 *     `OrganizationService.createOrganization` and the Stripe Atlas
 *     completion handler (Phase 10).
 */
@Injectable()
export class OrganizationRepository {
    constructor(
        @InjectRepository(Organization)
        private readonly repository: Repository<Organization>,
    ) {}

    async findById(id: string): Promise<Organization | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * Slug lookup used by the slug routing middleware (Phase 7). Org
     * resolution wins over User resolution per
     * [spec.md §4.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#42-slug-resolution).
     */
    async findBySlug(slug: string): Promise<Organization | null> {
        return this.repository.findOne({ where: { slug } });
    }

    /**
     * Used by the WorkspaceSwitcher (Phase 8) to list the user's Orgs.
     * Ordered by `createdAt DESC` so the **most recently created Org
     * appears at the top** of the popover — matches the spec's intent
     * ([spec.md §5.5](../../../../docs/specs/features/tenants-and-organizations/spec.md#popover-contents)).
     * The composite index `idx_organizations_tenant_created` covers
     * both directions.
     */
    async findByTenantId(tenantId: string): Promise<Organization[]> {
        return this.repository.find({
            where: { tenantId },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * First-Org guard used by `upgradeFromAccount` (Phase 6). Returns
     * the exact count so the caller can apply both the
     * `count === 1 AND :organizationId === earliest` check from
     * [plan.md Phase 6](../../../../docs/specs/features/tenants-and-organizations/plan.md#phase-6--lazy-upgrade-flow--organization-create-api).
     */
    async countByTenantId(tenantId: string): Promise<number> {
        return this.repository.count({ where: { tenantId } });
    }

    /**
     * Lookup the Work backing a registered Organization. Used by the
     * Settings → Organization page (Phase 8) to render the "view the
     * Company Work" link, and by the Stripe Atlas handler (Phase 10)
     * to find the existing Org row when re-running registration.
     */
    async findByLinkedWorkId(workId: string): Promise<Organization | null> {
        return this.repository.findOne({ where: { linkedWorkId: workId } });
    }

    async create(data: Partial<Organization>): Promise<Organization> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async save(org: Organization): Promise<Organization> {
        return this.repository.save(org);
    }

    async update(id: string, data: Partial<Organization>): Promise<void> {
        await this.repository.update(id, data);
    }
}
