import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantJobRuntimeAudit, TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import { config } from '../../config/constants';
import {
    TenantJobRuntimeConfigResponseDto,
    TenantJobRuntimeRotateResponseDto,
} from './dto/tenant-job-runtime-response.dto';
import {
    TENANT_JOB_RUNTIME_PROVIDER_IDS,
    TenantJobRuntimeProviderId,
    UpsertTenantJobRuntimeConfigDto,
} from './dto/upsert-tenant-job-runtime.dto';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) —
 * service layer for the 5 admin endpoints under
 * `/api/account/job-runtime/...`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 API surface](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#4-api-surface)
 * Tasks: [`tasks.md` T14](../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 * ADR: [ADR-017](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
 *
 * Responsibilities:
 *   - GET — load the tenant's overlay row, redact credentials, or return
 *     the synthetic `mode: inherit` default when no row exists (FR-7).
 *   - PUT — upsert with validation + audit row + `credentialVersion` bump
 *     on credentials change (FR-13).
 *   - rotate — bump credential version via `CredentialVersionService`
 *     (ADR-017 §3 graceful drain) + audit row.
 *   - force-invalidate — rate-limited in the controller (≤1/min/tenant);
 *     emits a `force_invalidate` audit row and bumps the credential
 *     version. The actual in-flight run kill is P3+ concern.
 *   - DELETE — revert to `inherit` (sets mode='inherit', clears
 *     credentialsSecretRef, keeps the row, bumps credentialVersion, emits
 *     audit row).
 *
 * **EW-742 P5 additions (T33-T35):**
 *   - `getAvailableProviders()` reads the operator allow-list env var
 *     (`EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`) via
 *     `config.tenantJobRuntime` and returns the filtered list the UI
 *     picker should render.
 *   - `upsertConfig` rejects with `BadRequestException` when the
 *     submitted `providerId` is excluded by the operator allow-list
 *     (FR-9). The static enum check on the DTO still runs first; this
 *     guard is the dynamic, env-driven layer.
 *   - Audit rows now capture `operatorAllowedProviders` snapshot in
 *     the `before` / `after` JSON blobs so future readers can correlate
 *     a mutation with the allow-list active at that moment. No new
 *     entity — extends the existing redacted snapshot helper.
 *
 * **Out of scope here (deferred PRs):**
 *   - Reachability probe against the provider's `provisionTenant` — P4.
 *   - Per-tenant whitelist behind a flag (P5.1 follow-up per plan.md
 *     §10 P5 "deferred to v2 behind a flag").
 *   - In-flight run kill on force-invalidate (FR-6 hard kill) — P3+.
 */
@Injectable()
export class TenantJobRuntimeService {
    private readonly logger = new Logger(TenantJobRuntimeService.name);

    constructor(
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly configRepository: Repository<TenantJobRuntimeConfig>,
        @InjectRepository(TenantJobRuntimeAudit)
        private readonly auditRepository: Repository<TenantJobRuntimeAudit>,
        private readonly credentialVersionService: CredentialVersionService,
    ) {}

    /**
     * EW-742 P5 (T34) — return the operator-allowed provider ids the
     * tenant picker should render. Reads the
     * `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` env var through the
     * shared config layer; empty / unset → all 5 bundled providers.
     *
     * Defensive narrow: the config layer is the canonical filter and
     * already drops unknown ids, but it returns `string[]` (no
     * agent/feature import in `apps/api/src/config`). We re-narrow
     * against the DTO-side allow-list so the returned type matches the
     * existing wire enum without a downstream cast.
     */
    getAvailableProviders(): TenantJobRuntimeProviderId[] {
        const known = new Set<string>(TENANT_JOB_RUNTIME_PROVIDER_IDS);
        return config.tenantJobRuntime
            .getAllowedProviders()
            .filter((id): id is TenantJobRuntimeProviderId => known.has(id));
    }

    /**
     * GET — returns the tenant's overlay row or a synthetic `mode: inherit`
     * default. NULL-safe per FR-7 — never throws on missing row. Credentials
     * are always redacted.
     */
    async getConfig(tenantId: string): Promise<TenantJobRuntimeConfigResponseDto> {
        const row = await this.configRepository.findOne({ where: { tenantId } });
        if (!row) {
            return this.toSyntheticInherit(tenantId);
        }
        return this.toResponse(row);
    }

    /**
     * PUT — upsert the overlay row. Validation invariants enforced here
     * (in addition to the DTO-level shape checks):
     *   - `mode = inherit` MUST NOT carry a `credentialsSecretRef` (the
     *     DTO already enforces presence-when-not-inherit; we cover the
     *     inverse here to prevent a stale tenant pointer leaking).
     *
     * Emits a `create` or `update` audit row. Bumps `credentialVersion`
     * whenever `credentialsSecretRef` changes (rotation-equivalent semantic
     * — captures the moment of a new credential pointer landing).
     */
    async upsertConfig(
        tenantId: string,
        actorUserId: string,
        dto: UpsertTenantJobRuntimeConfigDto,
    ): Promise<TenantJobRuntimeConfigResponseDto> {
        if (dto.mode === 'inherit' && dto.credentialsSecretRef) {
            throw new BadRequestException(
                'credentialsSecretRef must be omitted when mode = inherit',
            );
        }

        // EW-742 P5 (T34) — operator allow-list gate. Static DTO enum
        // catches unknown ids; this guard catches ids the operator has
        // restricted via EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS.
        // Skipped for `mode = inherit` because inherit uses the
        // platform-default credentials regardless of providerId.
        const allowedProviders = this.getAvailableProviders();
        if (dto.mode !== 'inherit' && !allowedProviders.includes(dto.providerId)) {
            throw new BadRequestException(
                `provider '${dto.providerId}' is disabled by the operator. ` +
                    `Allowed providers: ${allowedProviders.join(', ') || '(none)'}`,
            );
        }

        const existing = await this.configRepository.findOne({ where: { tenantId } });
        const before = existing ? this.redactRowForAudit(existing) : null;

        // Determine whether to bump credentialVersion. A bump fires when:
        //   - this is a brand-new row (start at version 1 — that's the
        //     entity default; no bump call needed);
        //   - the credentialsSecretRef changed (new pointer = new
        //     credential snapshot from the worker host's POV).
        // Provider change without ref change does NOT bump on its own —
        // the cache key includes providerId so the dispatcher already
        // separates snapshots per provider.
        const credentialsChanged =
            !!existing && existing.credentialsSecretRef !== (dto.credentialsSecretRef ?? null);

        let saved: TenantJobRuntimeConfig;
        if (existing) {
            existing.providerId = dto.providerId;
            existing.mode = dto.mode;
            existing.credentialsSecretRef = dto.credentialsSecretRef ?? null;
            existing.enabled = dto.enabled ?? existing.enabled;
            if (credentialsChanged) {
                existing.credentialVersion = existing.credentialVersion + 1;
            }
            saved = await this.configRepository.save(existing);
        } else {
            const fresh = this.configRepository.create({
                tenantId,
                providerId: dto.providerId,
                mode: dto.mode,
                credentialsSecretRef: dto.credentialsSecretRef ?? null,
                credentialVersion: 1,
                enabled: dto.enabled ?? true,
                createdBy: actorUserId,
            });
            saved = await this.configRepository.save(fresh);
        }

        await this.emitAudit({
            tenantId,
            actorUserId,
            action: existing ? 'update' : 'create',
            before,
            after: this.redactRowForAudit(saved),
            credentialVersion: saved.credentialVersion,
        });

        return this.toResponse(saved);
    }

    /**
     * Bump `credentialVersion` for graceful-drain rotation. Errors if no
     * overlay row exists (rotating `inherit` has no semantic meaning —
     * inherit uses platform-default credentials, not a tenant-scoped
     * version).
     */
    async rotateCredential(
        tenantId: string,
        actorUserId: string,
    ): Promise<TenantJobRuntimeRotateResponseDto> {
        const existing = await this.configRepository.findOne({ where: { tenantId } });
        if (!existing) {
            throw new NotFoundException(
                'Cannot rotate: tenant has no overlay row (mode = inherit uses platform credentials)',
            );
        }
        const newVersion = await this.credentialVersionService.bumpVersion(tenantId);
        if (newVersion === null) {
            // Shouldn't happen — we just confirmed the row exists. Defensive:
            // a concurrent DELETE could have removed it between our find +
            // bump. Surface as 409.
            throw new ConflictException(
                'Cannot rotate: overlay row disappeared mid-call (concurrent revert)',
            );
        }

        await this.emitAudit({
            tenantId,
            actorUserId,
            action: 'rotate',
            before: this.redactRowForAudit(existing),
            after: { ...this.redactRowForAudit(existing), credentialVersion: newVersion },
            credentialVersion: newVersion,
        });

        return { credentialVersion: newVersion };
    }

    /**
     * Operator-only break-glass kill switch. P2.0 behaviour: bump
     * `credentialVersion` + emit `force_invalidate` audit row. The actual
     * in-flight run kill (FR-6 hard kill) is P3+ when the dispatcher knows
     * how to enumerate runs by `(tenantId, credentialVersion)`.
     *
     * Rate limiting (≤1/min/tenant) is owned by the controller via
     * @Throttle on the route handler.
     */
    async forceInvalidate(
        tenantId: string,
        actorUserId: string,
    ): Promise<TenantJobRuntimeRotateResponseDto> {
        const existing = await this.configRepository.findOne({ where: { tenantId } });
        if (!existing) {
            throw new NotFoundException(
                'Cannot force-invalidate: tenant has no overlay row (mode = inherit uses platform credentials)',
            );
        }
        const newVersion = await this.credentialVersionService.bumpVersion(tenantId);
        if (newVersion === null) {
            throw new ConflictException(
                'Cannot force-invalidate: overlay row disappeared mid-call (concurrent revert)',
            );
        }

        await this.emitAudit({
            tenantId,
            actorUserId,
            action: 'force_invalidate',
            before: this.redactRowForAudit(existing),
            after: { ...this.redactRowForAudit(existing), credentialVersion: newVersion },
            credentialVersion: newVersion,
        });

        return { credentialVersion: newVersion };
    }

    /**
     * DELETE — revert to `mode: inherit`. Keeps the row (history +
     * credentialVersion preserved per plan.md §4), clears
     * `credentialsSecretRef`, bumps `credentialVersion` (so any worker
     * still holding the old credential snapshot drains gracefully), and
     * emits a `delete` audit row.
     *
     * Returns the post-revert response so the UI can refresh without an
     * extra GET.
     */
    async revertToInherit(
        tenantId: string,
        actorUserId: string,
    ): Promise<TenantJobRuntimeConfigResponseDto> {
        const existing = await this.configRepository.findOne({ where: { tenantId } });
        if (!existing) {
            // Already inherit — return the synthetic default. Idempotent
            // DELETE is the expected REST semantic.
            return this.toSyntheticInherit(tenantId);
        }

        const before = this.redactRowForAudit(existing);
        existing.mode = 'inherit';
        existing.credentialsSecretRef = null;
        existing.credentialVersion = existing.credentialVersion + 1;
        const saved = await this.configRepository.save(existing);

        await this.emitAudit({
            tenantId,
            actorUserId,
            action: 'delete',
            before,
            after: this.redactRowForAudit(saved),
            credentialVersion: saved.credentialVersion,
        });

        return this.toResponse(saved);
    }

    /**
     * Maps a persisted row to the wire DTO. Credentials are redacted —
     * only `hasCredentials` + the last 4 chars of the ref are exposed.
     */
    private toResponse(row: TenantJobRuntimeConfig): TenantJobRuntimeConfigResponseDto {
        return {
            tenantId: row.tenantId,
            providerId: row.providerId as TenantJobRuntimeConfigResponseDto['providerId'],
            mode: row.mode,
            hasCredentials: row.credentialsSecretRef !== null,
            credentialsSecretRefRedacted: this.redactRef(row.credentialsSecretRef),
            credentialVersion: row.credentialVersion,
            enabled: row.enabled,
            createdBy: row.createdBy,
            createdAt: row.createdAt ? row.createdAt.toISOString() : null,
            updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
        };
    }

    /**
     * Synthetic NULL-safe inherit default (FR-7). Returned by GET when no
     * overlay row exists, and by DELETE when the tenant is already in
     * inherit mode.
     */
    private toSyntheticInherit(tenantId: string): TenantJobRuntimeConfigResponseDto {
        return {
            tenantId,
            providerId: null,
            mode: 'inherit',
            hasCredentials: false,
            credentialsSecretRefRedacted: null,
            credentialVersion: null,
            enabled: true,
            createdBy: null,
            createdAt: null,
            updatedAt: null,
        };
    }

    /**
     * Show only the last 4 chars of the secret ref so operators can
     * distinguish two pointers in the audit log without seeing the full
     * opaque value. NULL passes through.
     */
    private redactRef(ref: string | null): string | null {
        if (!ref) {
            return null;
        }
        if (ref.length <= 4) {
            return '***';
        }
        return `***${ref.slice(-4)}`;
    }

    /**
     * Build the redacted snapshot the audit row stores in `before` / `after`.
     * Per the entity's documentation, secrets MUST be masked at write time
     * — the audit log records the LAST 4 chars of the ref only (matching the
     * GET response redaction), never the full ref or the underlying blob.
     */
    private redactRowForAudit(row: TenantJobRuntimeConfig): Record<string, unknown> {
        return {
            tenantId: row.tenantId,
            providerId: row.providerId,
            mode: row.mode,
            credentialsSecretRefRedacted: this.redactRef(row.credentialsSecretRef),
            hasCredentials: row.credentialsSecretRef !== null,
            credentialVersion: row.credentialVersion,
            enabled: row.enabled,
        };
    }

    /**
     * Append-only write to `tenant_job_runtime_audit`. Failures are
     * surfaced (NOT swallowed) — if the audit row can't land we treat the
     * mutation as failed so the operator never sees a divergent state
     * (overlay row updated without an audit trail).
     *
     * EW-742 P5 (T35) — every `before` / `after` snapshot is decorated
     * with `operatorAllowedProviders: string[]` so future audit-log
     * reads can correlate a mutation with the operator's active
     * allow-list at the time. There's no runtime "disable" event we
     * could capture separately — operators change the env var and
     * redeploy — so we snapshot per-mutation. Null `before` / `after`
     * (e.g. fresh row → `before = null`) is left as-is to preserve the
     * existing semantic ("no previous state recorded").
     */
    private async emitAudit(payload: {
        tenantId: string;
        actorUserId: string | null;
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        credentialVersion: number | null;
    }): Promise<void> {
        const operatorAllowedProviders = this.getAvailableProviders();
        const decorate = (
            snapshot: Record<string, unknown> | null,
        ): Record<string, unknown> | null => {
            if (snapshot === null) return null;
            return { ...snapshot, operatorAllowedProviders };
        };

        const audit = this.auditRepository.create({
            ...payload,
            before: decorate(payload.before),
            after: decorate(payload.after),
        });
        await this.auditRepository.save(audit);
        this.logger.debug(
            `Audit: tenant=${payload.tenantId} action=${payload.action} ` +
                `version=${payload.credentialVersion ?? 'null'} ` +
                `allow-list=[${operatorAllowedProviders.join(',')}]`,
        );
    }
}
