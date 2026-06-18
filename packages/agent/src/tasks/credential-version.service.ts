import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';

/**
 * EW-742 P1 (T11) — issues + resolves the monotonic per-tenant
 * `credentialVersion` that powers the graceful-drain semantics from
 * [ADR-017 §3](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen)
 * (Q4) and [`spec.md` FR-5](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md):
 *
 *   - every enqueue captures the current `(tenantId, credentialVersion)`
 *     onto the run / history row;
 *   - the worker uses the credentials matching THAT version for the run's
 *     full lifetime, even if the tenant rotates mid-run;
 *   - new enqueues see the new version on next dispatch.
 *
 * Singleton-scoped service (no per-request state). Sits in
 * `packages/agent/src/tasks/` next to the dispatcher symbols it will
 * collaborate with in EW-742 P3 (T22 — credential version capture at
 * every enqueue) so the import is local to the tasks layer rather than
 * crossing into the agent's facade tier.
 *
 * The companion resolver (P3 / T20) will live alongside this service.
 */
@Injectable()
export class CredentialVersionService {
    private readonly logger = new Logger(CredentialVersionService.name);

    constructor(
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly repository: Repository<TenantJobRuntimeConfig>,
    ) {}

    /**
     * Atomically increments the tenant's `credentialVersion` and returns
     * the new value. Returns `null` if the tenant has no overlay row —
     * the caller's responsibility to decide whether to upsert (rotation
     * on `mode = 'inherit'` is a no-op because there are no overlay
     * credentials to rotate) or surface as an error.
     *
     * Uses TypeORM's `increment(...)` so the bump is a single
     * `UPDATE ... SET "credentialVersion" = "credentialVersion" + 1`
     * round-trip — no read-modify-write race window. The subsequent
     * `findOne` reads the post-update value committed by the UPDATE.
     */
    async bumpVersion(tenantId: string): Promise<number | null> {
        const result = await this.repository.increment({ tenantId }, 'credentialVersion', 1);
        if (!result.affected) {
            return null;
        }
        const row = await this.repository.findOne({ where: { tenantId } });
        const newVersion = row?.credentialVersion ?? null;
        this.logger.debug(
            `Bumped credentialVersion for tenant ${tenantId} → ${newVersion ?? 'unknown'}`,
        );
        return newVersion;
    }

    /**
     * Returns the current `credentialVersion` for the tenant, or `null`
     * when no overlay row exists (the tenant is in `inherit` mode by
     * default, and the version concept doesn't apply to platform-default
     * credentials in P1).
     */
    async getCurrentVersion(tenantId: string): Promise<number | null> {
        const row = await this.repository.findOne({
            where: { tenantId },
            select: ['tenantId', 'credentialVersion'],
        });
        return row?.credentialVersion ?? null;
    }

    /**
     * Resolves the credential snapshot for a specific `(tenantId,
     * version)` tuple. Used by the worker host (P4) when handling an
     * in-flight run whose enqueue captured `version` — the snapshot MUST
     * still be the credential set that was active at enqueue time, even
     * if the tenant has rotated since.
     *
     * **P1 limitation:** this service does NOT yet persist historical
     * credential snapshots; it returns the CURRENT row only when the
     * requested `version` matches the row's current `credentialVersion`,
     * and `null` otherwise. The full graceful-drain Q4 contract requires
     * a `tenant_job_runtime_config_history` table that mirrors each
     * version's `credentialsSecretRef` — that follow-up is tracked as a
     * P1 sub-story; until it lands the worker host must treat a missing
     * snapshot as "credentials rotated past this run" and either retry
     * with the current credentials (if the run is idempotent) or fail
     * with `CREDENTIAL_DRAINED` and let the user re-enqueue. See
     * [`plan.md` §10 P3 — Dispatcher routing](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#p3--dispatcher-routing-tenant-aware-resolver--credential-version-capture)
     * for the matching P3 work item.
     *
     * TODO(EW-742 P1.1): introduce `tenant_job_runtime_config_history`
     * and rewrite this method to query it for `version < currentVersion`.
     */
    async resolveSnapshot(
        tenantId: string,
        version: number,
    ): Promise<TenantJobRuntimeConfig | null> {
        const row = await this.repository.findOne({ where: { tenantId } });
        if (!row) {
            return null;
        }
        if (row.credentialVersion !== version) {
            this.logger.warn(
                `resolveSnapshot miss for tenant ${tenantId}: requested v${version}, ` +
                    `current v${row.credentialVersion}. P1 returns null (no history table yet).`,
            );
            return null;
        }
        return row;
    }
}
