import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull, Not, LessThan, And } from 'typeorm';
import {
    FLEET_RUN_API_KEY_KIND,
    INTEGRATION_API_KEY_KIND,
    PERSONAL_API_KEY_KIND,
} from '@ever-works/contracts';
import { ApiKey } from '../../entities/api-key.entity';
import { serializeOnSingleConnection } from './single-connection-write-queue';

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

    // ── EW-P1-2 — integration keys + in-place rotation ─────────────────

    /**
     * The row whose PREVIOUS secret (before an in-place rotation) hashes to
     * `hashedKey`. The caller checks `previousKeyGraceUntil`; this lookup
     * only narrows to active rows.
     */
    async findByPreviousHashedKey(hashedKey: string): Promise<ApiKey | null> {
        return this.repository.findOne({
            where: { previousHashedKey: hashedKey, isActive: true },
        });
    }

    /** Active integration keys of one Tenant, newest first (Settings > API keys). */
    async findIntegrationKeysByTenant(tenantId: string): Promise<ApiKey[]> {
        return this.repository.find({
            where: { tenantId, kind: INTEGRATION_API_KEY_KIND, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Active, unexpired integration keys of one Tenant — the cap of 20.
     * Like the personal cap, an expired or revoked key frees its slot.
     */
    async countActiveIntegrationKeysByTenant(tenantId: string): Promise<number> {
        return this.repository.count({
            where: [
                { tenantId, kind: INTEGRATION_API_KEY_KIND, isActive: true, expiresAt: IsNull() },
                {
                    tenantId,
                    kind: INTEGRATION_API_KEY_KIND,
                    isActive: true,
                    expiresAt: MoreThan(new Date()),
                },
            ],
        });
    }

    /**
     * Apply an in-place rotation (new secret, previous secret kept for the
     * grace period) as a compare-and-set on the digest the caller read:
     * `false` when another rotation landed first. Two overlapping rotations
     * therefore cannot both answer with a secret — the loser's secret would
     * otherwise be dead on arrival, overwritten by the winner's.
     */
    async applyRotation(
        id: string,
        expectedHashedKey: string,
        patch: Pick<
            ApiKey,
            'hashedKey' | 'prefix' | 'previousHashedKey' | 'previousKeyGraceUntil' | 'rotatedAt'
        >,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, hashedKey: expectedHashedKey, isActive: true },
            patch,
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * Revoke one key by switching it off rather than deleting it. Used for
     * integration keys so the row stays behind as the audit record their
     * activity rows and webhook subscriptions point at. `findByHashedKey`
     * and `findByPreviousHashedKey` both filter on `isActive`, so a
     * deactivated key is refused by the same check as a deleted one.
     */
    /** EW-P2-6 — one key by id (any kind). */
    async findById(id: string): Promise<ApiKey | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * EW-P2-6 — replace an ACTIVE integration key's Organization pins (`org:write`
     * auto-pins the Organization it creates). `false` when no active key matched.
     */
    async updateOrganizationIds(id: string, organizationIds: string[]): Promise<boolean> {
        const result = await this.repository.update({ id, isActive: true }, { organizationIds });
        return (result.affected ?? 0) > 0;
    }

    /**
     * EW-P2-6 — append one Organization pin to an ACTIVE integration key atomically: the
     * read-modify-write runs in one transaction under a row lock (Postgres / MySQL) and
     * serialized on SQLite's single connection, so two concurrent creates through one
     * key never lose a pin. `max` caps the pins (`full` when reached).
     */
    async appendOrganizationId(
        id: string,
        organizationId: string,
        max: number,
    ): Promise<{ status: 'added' | 'present' | 'full' | 'missing'; organizationIds: string[] }> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const type = String(manager.connection.options.type);
                const locks = type === 'postgres' || type === 'mysql' || type === 'mariadb';
                const row = await manager.getRepository(ApiKey).findOne({
                    where: { id, isActive: true },
                    ...(locks ? { lock: { mode: 'pessimistic_write' as const } } : {}),
                });
                if (!row) return { status: 'missing' as const, organizationIds: [] };
                const pins = Array.isArray(row.organizationIds) ? [...row.organizationIds] : [];
                if (pins.includes(organizationId)) {
                    return { status: 'present' as const, organizationIds: pins };
                }
                if (pins.length >= max) return { status: 'full' as const, organizationIds: pins };
                const next = [...pins, organizationId];
                await manager.getRepository(ApiKey).update({ id }, { organizationIds: next });
                return { status: 'added' as const, organizationIds: next };
            }),
        );
    }

    /**
     * EW-P2-6 — drop one Organization pin from an integration key, in the same locked
     * read-modify-write as {@link appendOrganizationId} (the undo of a pin reserved for
     * an Organization whose create then failed). `false` when the pin was not there.
     */
    async removeOrganizationId(id: string, organizationId: string): Promise<boolean> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const type = String(manager.connection.options.type);
                const locks = type === 'postgres' || type === 'mysql' || type === 'mariadb';
                const row = await manager.getRepository(ApiKey).findOne({
                    where: { id },
                    ...(locks ? { lock: { mode: 'pessimistic_write' as const } } : {}),
                });
                const pins = Array.isArray(row?.organizationIds) ? row.organizationIds : [];
                if (!row || !pins.includes(organizationId)) return false;
                await manager
                    .getRepository(ApiKey)
                    .update(
                        { id },
                        { organizationIds: pins.filter((pin) => pin !== organizationId) },
                    );
                return true;
            }),
        );
    }

    async deactivateById(id: string): Promise<boolean> {
        const result = await this.repository.update({ id, isActive: true }, { isActive: false });
        return (result.affected ?? 0) > 0;
    }

    async deleteExpiredKeys(): Promise<number> {
        const result = await this.repository.delete({
            expiresAt: And(Not(IsNull()), LessThan(new Date())),
        });
        return result.affected ?? 0;
    }
}
