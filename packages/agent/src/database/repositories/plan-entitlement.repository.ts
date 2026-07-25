import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanEntitlement } from '@src/entities/plan-entitlement.entity';

/**
 * Plan entitlements (pricing Wave 9 M1) — per-plan feature/limit rows
 * keyed by (planId = plan CODE, key). Read through
 * `EntitlementsService` (TTL cache); seeds land in the
 * `1783400000000-CreateCreditsLedgerAndEntitlements` migration.
 */
@Injectable()
export class PlanEntitlementRepository {
    constructor(
        @InjectRepository(PlanEntitlement)
        private readonly repository: Repository<PlanEntitlement>,
    ) {}

    async findByPlanAndKey(planId: string, key: string): Promise<PlanEntitlement | null> {
        return this.repository.findOne({ where: { planId, key } });
    }

    async findByPlan(planId: string): Promise<PlanEntitlement[]> {
        return this.repository.find({ where: { planId }, order: { key: 'ASC' } });
    }

    /** Insert-or-update one (planId, key) lever. */
    async upsert(
        entitlement: Pick<PlanEntitlement, 'planId' | 'key'> &
            Partial<Pick<PlanEntitlement, 'valueInt' | 'valueText'>>,
    ): Promise<PlanEntitlement> {
        const existing = await this.findByPlanAndKey(entitlement.planId, entitlement.key);
        if (existing) {
            existing.valueInt = entitlement.valueInt ?? null;
            existing.valueText = entitlement.valueText ?? null;
            return this.repository.save(existing);
        }
        return this.repository.save(this.repository.create(entitlement));
    }
}
