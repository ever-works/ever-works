import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { FleetCostPolicy } from '../entities/fleet-cost-policy.entity';

/**
 * Fleet cost accounting (EW-777) — feature-owned repository for the
 * owner's fleet-wide daily ceiling (provided by `FleetModule`, not
 * `DatabaseModule` — same split as `FleetNodeRepository`).
 *
 * One row per owner, held by the unique index on `userId` AND by the
 * find-then-save below (a NULL-free key, so here the index does enforce
 * it — unlike `fleet_execution_preferences`).
 */
@Injectable()
export class FleetCostPolicyRepository {
    constructor(
        @InjectRepository(FleetCostPolicy)
        private readonly repository: Repository<FleetCostPolicy>,
    ) {}

    async findByUser(userId: string): Promise<FleetCostPolicy | null> {
        return this.repository.findOne({ where: { userId } });
    }

    /** The owner's row, created (with no ceiling of its own) when missing. */
    async ensureForUser(userId: string): Promise<FleetCostPolicy> {
        const existing = await this.findByUser(userId);
        if (existing) return existing;
        return this.repository.save(
            this.repository.create({ userId, dailyCeilingCents: null, trippedOn: null }),
        );
    }

    /**
     * Set (or clear, with null) the owner's fleet-wide ceiling.
     *
     * Re-arms the one-notice marker: `trippedOn` keeps the tenth crossing
     * of ONE ceiling on one day quiet, but a changed ceiling is a new
     * decision and its next crossing is news again — left set, a raised
     * ceiling crossed later the same day would drain the fleet in silence.
     */
    async upsertCeiling(
        userId: string,
        dailyCeilingCents: number | null,
    ): Promise<FleetCostPolicy> {
        const row = await this.ensureForUser(userId);
        row.dailyCeilingCents = dailyCeilingCents;
        row.trippedOn = null;
        row.trippedAt = null;
        return this.repository.save(row);
    }

    /**
     * Claim the ONE per-day fleet-wide trip. Returns true exactly once per
     * (owner, UTC day) — the same two-step CAS shape as
     * `FleetNodeRepository.casTripDailyCeiling`, for the same reason: each
     * conditional UPDATE is atomic on both engines, and a NULL never
     * matches `<>`, so the pair covers "never tripped" and "tripped on an
     * earlier day" without a driver-specific predicate.
     */
    async casTrip(userId: string, day: string, at: Date = new Date()): Promise<boolean> {
        await this.ensureForUser(userId);
        const fresh = await this.repository.update(
            { userId, trippedOn: IsNull() },
            { trippedOn: day, trippedAt: at },
        );
        if ((fresh.affected ?? 0) === 1) return true;
        const rolled = await this.repository.update(
            { userId, trippedOn: Not(day) },
            { trippedOn: day, trippedAt: at },
        );
        return (rolled.affected ?? 0) === 1;
    }
}
