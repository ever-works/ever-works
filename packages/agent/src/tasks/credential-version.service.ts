import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantCredentialSnapshot } from '../entities/tenant-credential-snapshot.entity';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';

/**
 * EW-742 P1 (T11) + T11 follow-up — issues and resolves the monotonic
 * per-tenant `credentialVersion` that powers the graceful-drain semantics
 * from [ADR-017 §3](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen)
 * (Q4) and [`spec.md` FR-5](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md):
 *
 *   - every enqueue captures the current `(tenantId, credentialVersion)`
 *     onto the run / history row;
 *   - the worker uses the credentials matching THAT version for the run's
 *     full lifetime, even if the tenant rotates mid-run;
 *   - new enqueues see the new version on next dispatch.
 *
 * # Snapshot history (T11 follow-up)
 *
 * The graceful-drain contract is only honoured if a request for
 * `version = N` keeps returning the version-N credentials AFTER the
 * tenant rotates to `N+1`. The original P1 stopgap returned `null` for
 * `version != current` because the snapshot history table did not yet
 * exist; this service now reads from `tenant_credential_snapshot` (entity
 * `TenantCredentialSnapshot`) for the historical path. `captureSnapshot`
 * is the write side — callers (the rotation flow inside
 * `TenantJobRuntimeService` and the bumpVersion helper) MUST invoke it
 * with the NEW credential bag immediately after the version is advanced
 * so the next rotation has a row to drain back to.
 *
 * Singleton-scoped service (no per-request state). Sits in
 * `packages/agent/src/tasks/` next to the dispatcher symbols it
 * collaborates with so the import is local to the tasks layer rather
 * than crossing into the agent's facade tier.
 */
@Injectable()
export class CredentialVersionService {
    private readonly logger = new Logger(CredentialVersionService.name);

    constructor(
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly repository: Repository<TenantJobRuntimeConfig>,
        @InjectRepository(TenantCredentialSnapshot)
        private readonly snapshotRepo: Repository<TenantCredentialSnapshot>,
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
     *
     * # Snapshot capture (T11 follow-up)
     *
     * When the caller supplies `providerId` + `newCredentials`, the
     * post-bump version is persisted to the snapshot history table in
     * the same call. This is what makes the **next** rotation's drain
     * work: the moment v=N+2 lands, v=N+1's credentials are still
     * resolvable from `tenant_credential_snapshot`. Callers that already
     * have the credentials bag in hand (the rotation flow inside
     * `TenantJobRuntimeService`) SHOULD pass them; callers that don't
     * (e.g. the legacy single-arg path used by tests / the
     * force-invalidate endpoint that only rotates the version pointer)
     * can omit them and call `captureSnapshot` separately when the bag
     * is later resolved.
     */
    async bumpVersion(
        tenantId: string,
        providerId?: string,
        newCredentials?: Record<string, unknown>,
    ): Promise<number | null> {
        const result = await this.repository.increment({ tenantId }, 'credentialVersion', 1);
        if (!result.affected) {
            return null;
        }
        const row = await this.repository.findOne({ where: { tenantId } });
        const newVersion = row?.credentialVersion ?? null;
        this.logger.debug(
            `Bumped credentialVersion for tenant ${tenantId} → ${newVersion ?? 'unknown'}`,
        );

        // Capture the new snapshot in the same call when the caller has
        // already supplied the credentials. Falling back to the row's
        // `providerId` if the caller omitted it (rotations always target
        // the row's current provider — `mode` switches go through a
        // different flow that bumps separately).
        if (newVersion !== null && newCredentials) {
            const effectiveProviderId = providerId ?? row?.providerId;
            if (effectiveProviderId) {
                await this.captureSnapshot(
                    tenantId,
                    effectiveProviderId,
                    newVersion,
                    newCredentials,
                );
            } else {
                this.logger.warn(
                    `bumpVersion for tenant ${tenantId} v${newVersion}: caller supplied ` +
                        `credentials but no providerId and the row lacks one. Snapshot skipped.`,
                );
            }
        }

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
     * Persist a `(tenantId, providerId, credentialVersion)` snapshot to
     * the history table. Idempotent on the natural key — re-calling with
     * the same tuple is a no-op (the migration's UNIQUE index turns the
     * second INSERT into a `ConflictException`; we swallow it because
     * "the snapshot already exists" is exactly what the caller wants).
     *
     * `credentialsEncrypted` is stored verbatim — encryption is the
     * secret-store resolver layer's responsibility (P3.2 / EW-748). This
     * column never touches plaintext; the bag passed in MUST already be
     * the at-rest encrypted form (or in the inline:/dev case, the bag
     * the operator wants persisted as-is).
     */
    async captureSnapshot(
        tenantId: string,
        providerId: string,
        credentialVersion: number,
        credentialsEncrypted: Record<string, unknown>,
    ): Promise<void> {
        try {
            // Use `insert` (not `save`) so we get a clean PK-conflict on
            // re-insert rather than an UPDATE — the natural key is the
            // unique index `(tenantId, providerId, credentialVersion)`
            // and snapshots are immutable. We translate the conflict
            // into a no-op below.
            //
            // `orIgnore: true` would also work on Postgres (TypeORM emits
            // `ON CONFLICT DO NOTHING`), and it avoids paying the cost
            // of the secondary lookup. Use it when supported; fall back
            // to catch-and-swallow on drivers that don't (better-sqlite3
            // and older TypeORM versions still understand the boolean).
            await this.snapshotRepo
                .createQueryBuilder()
                .insert()
                .into(TenantCredentialSnapshot)
                .values({
                    tenantId,
                    providerId,
                    credentialVersion,
                    credentialsEncrypted,
                })
                .orIgnore()
                .execute();
            this.logger.debug(
                `Captured credential snapshot for tenant=${tenantId} provider=${providerId} ` +
                    `v=${credentialVersion}`,
            );
        } catch (err) {
            // Defensive: if `.orIgnore()` somehow doesn't suppress the
            // unique-constraint violation (driver-specific behaviour),
            // detect-and-swallow on the natural-key conflict so the
            // method stays idempotent.
            const message = err instanceof Error ? err.message : String(err);
            const isUniqueViolation = /duplicate key|unique constraint|UNIQUE constraint/i.test(
                message,
            );
            if (!isUniqueViolation) {
                throw err;
            }
            this.logger.debug(
                `captureSnapshot idempotent no-op for tenant=${tenantId} provider=${providerId} ` +
                    `v=${credentialVersion} (snapshot already exists)`,
            );
        }
    }

    /**
     * Resolves the credential snapshot for a specific `(tenantId,
     * version)` tuple. Used by the worker host when handling an in-flight
     * run whose enqueue captured `version` — the snapshot MUST still be
     * the credential set that was active at enqueue time, even if the
     * tenant has rotated since.
     *
     * # Resolution paths
     *
     *   - `version === current`: return the current overlay row directly.
     *     The bag isn't needed because the live secret-store resolver
     *     still has the current `credentialsSecretRef` to dereference.
     *   - `version !== current` (historical): look up
     *     `tenant_credential_snapshot` by
     *     `(tenantId, providerId, credentialVersion)`. If found,
     *     synthesise a {@link TenantJobRuntimeConfig}-shaped object that
     *     carries the historical version while inheriting the tenant's
     *     current `mode`/`enabled` (those are tenant-level metadata, not
     *     version-pinned). The historical `credentialsEncrypted` bag is
     *     re-issued as an `inline:` `credentialsSecretRef` so the
     *     existing secret-store resolver chain can dereference it
     *     without a custom snapshot scheme — the in-process resolver
     *     already supports `inline:<base64-json>`.
     *   - `version !== current` AND no snapshot row: return `null`. The
     *     worker host treats this as `CREDENTIAL_DRAINED` (the rotation
     *     advanced past anything we've captured); call sites already
     *     handle null per
     *     `packages/tasks/src/trigger/worker/services/tenant-runtime-binding-resolver.service.ts`.
     *   - Tenant has no overlay row at all: return `null` (same as P1).
     */
    async resolveSnapshot(
        tenantId: string,
        version: number,
    ): Promise<TenantJobRuntimeConfig | null> {
        const row = await this.repository.findOne({ where: { tenantId } });
        if (!row) {
            return null;
        }
        if (row.credentialVersion === version) {
            return row;
        }

        // Historical path — read from the snapshot history table. Scope
        // by `providerId` too so a tenant that switched providers at
        // some point can't accidentally resolve a snapshot from the
        // wrong runtime (the natural key is the same triple the migration
        // indexes uniquely).
        const snapshot = await this.snapshotRepo.findOne({
            where: {
                tenantId,
                providerId: row.providerId,
                credentialVersion: version,
            },
        });
        if (!snapshot) {
            this.logger.warn(
                `resolveSnapshot miss for tenant ${tenantId}: requested v${version}, ` +
                    `current v${row.credentialVersion} and no history row found. ` +
                    `Worker host will treat as drained.`,
            );
            return null;
        }

        // Synthesise a TenantJobRuntimeConfig-shaped object using the
        // current row's tenant-level metadata (mode/enabled — these
        // describe the tenant's overlay state, not the credentials) and
        // the snapshot's per-version fields. The encrypted bag is re-
        // issued as `inline:<base64-json>` so the existing secret-store
        // resolver chain dereferences it through the same path it uses
        // for dev / test inline credentials. Operators running a real
        // secret store still hit this synthesised inline pointer; the
        // bag itself never round-trips through their store on the
        // historical path (it's already the resolved form by virtue of
        // having been captured at enqueue time).
        const inlinePointer = `inline:${Buffer.from(
            JSON.stringify(snapshot.credentialsEncrypted),
        ).toString('base64')}`;

        const synthesised: TenantJobRuntimeConfig = {
            tenantId,
            providerId: snapshot.providerId,
            credentialsSecretRef: inlinePointer,
            credentialVersion: snapshot.credentialVersion,
            mode: row.mode,
            enabled: row.enabled,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
            updatedAt: snapshot.capturedAt,
        };

        this.logger.debug(
            `resolveSnapshot served historical v${version} for tenant ${tenantId} ` +
                `(current is v${row.credentialVersion})`,
        );
        return synthesised;
    }
}
