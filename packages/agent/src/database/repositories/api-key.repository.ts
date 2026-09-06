import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull, Not, LessThan, And } from 'typeorm';
import { FLEET_RUN_API_KEY_KIND, PERSONAL_API_KEY_KIND } from '@ever-works/contracts';
import { ApiKey } from '../../entities/api-key.entity';

@Injectable()
export class ApiKeyRepository {
    constructor(
        @InjectRepository(ApiKey)
        private readonly repository: Repository<ApiKey>,
    ) {}

    async create(data: Partial<ApiKey>): Promise<ApiKey> {
        const apiKey = this.repository.create(data);
        return this.repository.save(apiKey);
    }

    async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
        return this.repository.findOne({
            where: { hashedKey, isActive: true },
        });
    }

    /**
     * The owner's PERSONAL keys — what Settings > API Keys renders.
     *
     * Self-build slice Z (EW-796): filtered to `kind = 'personal'` so the
     * short-lived `ew_run_` credentials a fleet run mints never surface as
     * keys the owner could think they created (and never as keys they
     * could revoke by hand mid-run). Pre-existing rows read as `personal`
     * through the column default, so this listing is unchanged for every
     * key that existed before the bridge.
     */
    async findByUserId(userId: string): Promise<ApiKey[]> {
        return this.repository.find({
            where: { userId, kind: PERSONAL_API_KEY_KIND },
            select: ['id', 'name', 'prefix', 'expiresAt', 'lastUsedAt', 'isActive', 'createdAt'],
            order: { createdAt: 'DESC' },
        });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ApiKey | null> {
        return this.repository.findOne({
            where: { id, userId },
        });
    }

    async updateLastUsed(id: string): Promise<void> {
        await this.repository.update(id, { lastUsedAt: new Date() });
    }

    async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Active personal keys, for the ten-per-user cap.
     *
     * Run tokens are excluded for the same reason they are hidden from the
     * listing: a busy fleet re-mints one per lease renewal, and counting
     * them would let a long run lock its own owner out of creating an
     * ordinary API key.
     */
    async countByUserId(userId: string): Promise<number> {
        return this.repository.count({
            where: [
                { userId, kind: PERSONAL_API_KEY_KIND, expiresAt: IsNull() },
                { userId, kind: PERSONAL_API_KEY_KIND, expiresAt: MoreThan(new Date()) },
            ],
        });
    }

    /**
     * Self-build slice Z — active run tokens minted for one fleet job.
     *
     * Used by the rotation path (each re-mint deactivates its
     * predecessors) and by the revoke-on-finalize listener.
     */
    async findActiveByBoundJob(jobId: string): Promise<ApiKey[]> {
        return this.repository.find({
            where: { boundJobId: jobId, kind: FLEET_RUN_API_KEY_KIND, isActive: true },
        });
    }

    /**
     * Revoke every run token bound to one job, and report how many were
     * still live.
     *
     * Deactivation rather than deletion: `findByHashedKey` already filters
     * on `isActive`, so a deactivated row is refused by the SAME check
     * that has always refused a revoked personal key, and the row stays
     * behind as the audit record of a credential that existed. Idempotent
     * — a second call over the same job affects 0 rows.
     */
    async deactivateByBoundJob(jobId: string): Promise<number> {
        const result = await this.repository.update(
            { boundJobId: jobId, kind: FLEET_RUN_API_KEY_KIND, isActive: true },
            { isActive: false },
        );
        return result.affected ?? 0;
    }

    async deleteExpiredKeys(): Promise<number> {
        const result = await this.repository.delete({
            expiresAt: And(Not(IsNull()), LessThan(new Date())),
        });
        return result.affected ?? 0;
    }
}
