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

    /**
     * Insert one (planId, key) lever ONLY if it does not already exist.
     *
     * 🛑 This, not {@link upsert}, is what a boot-time seeder must call.
     * `upsert` OVERWRITES an existing row and nulls the sibling value
     * column, so seeding through it at every pod start would silently
     * reset any operator-tuned lever - including the `free` plan rows the
     * 1783400000000 migration seeded from env. Insert-if-missing matches
     * that migration's own posture (`if (existing) continue`) and can
     * never reduce an entitlement a live user already holds.
     *
     * Returns the existing row untouched when one is present.
     */
    async insertIfMissing(
        entitlement: Pick<PlanEntitlement, 'planId' | 'key'> &
            Partial<Pick<PlanEntitlement, 'valueInt' | 'valueText'>>,
    ): Promise<{ entitlement: PlanEntitlement; created: boolean }> {
        const existing = await this.findByPlanAndKey(entitlement.planId, entitlement.key);
        if (existing) {
            return { entitlement: existing, created: false };
        }
        try {
            const created = await this.repository.save(this.repository.create(entitlement));
            return { entitlement: created, created: true };
        } catch (error) {
            // Check-then-insert against a UNIQUE (planId, key). Two API replicas
            // booting together on a rolling deploy both pass the check and one
            // hits 23505 - inside onModuleInit, which means that pod NEVER
            // finishes booting. Recover by re-reading, the same shape the ledger
            // uses for its own unique-key race.
            // SQLSTATE first, message second. PostgreSQL translates error text
            // according to `lc_messages`, so a server with a non-English locale
            // would fail the regex and let a boot-time race become a pod that never
            // starts. `23505` is locale-independent. This mirrors
            // `CreditLedgerRepository.isUniqueViolation`, which this comment used to
            // claim to match while testing strictly less.
            const code =
                (error as { code?: string; driverError?: { code?: string } })?.code ??
                (error as { driverError?: { code?: string } })?.driverError?.code;
            const message = String((error as Error)?.message ?? '');
            if (
                code === '23505' ||
                /duplicate key|UNIQUE constraint failed|Duplicate entry/i.test(message)
            ) {
                const raced = await this.findByPlanAndKey(entitlement.planId, entitlement.key);
                if (raced) {
                    return { entitlement: raced, created: false };
                }
            }
            throw error;
        }
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
