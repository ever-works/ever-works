import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
}
