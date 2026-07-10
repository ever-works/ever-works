import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
    TenantJobRuntimeAudit,
    TenantJobRuntimeConfig,
    TenantRuntimeProviderAllowlist,
} from '@ever-works/agent/entities';
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
        // EW-752 P5.1 (T35a + T35b) — per-tenant allow-list overlay repo
        // and the DataSource for the atomic delete-then-insert of
        // `replaceTenantAllowlist`. Both are injected via NestJS DI in
        // production; unit specs that only exercise the EW-742 P5
        // surface area may pass `undefined` for the new params.
        @InjectRepository(TenantRuntimeProviderAllowlist)
        private readonly allowlistRepo: Repository<TenantRuntimeProviderAllowlist>,
        @InjectDataSource()
        private readonly dataSource: DataSource,
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

    // ─── EW-752 P5.1 (T35a + T35b) — per-tenant allow-list overlay ─────

    /**
     * Return the per-tenant allow-list provider ids for `tenantId` in
     * insertion order (`createdAt ASC`). Empty array when the tenant
     * has no overlay rows — callers interpret that as "inherit the
     * global list" (when the gating flag is on) or simply ignore the
     * overlay (when the gating flag is off).
     *
     * The result is narrowed against `TENANT_JOB_RUNTIME_PROVIDER_IDS`
     * so a legacy row with a now-removed provider id is silently
     * dropped — matches the resolver's "global is the upper bound"
     * semantic so the read surface stays consistent with what
     * `getAvailableProvidersForTenant` returns.
     */
    async listTenantAllowlist(tenantId: string): Promise<TenantJobRuntimeProviderId[]> {
        const rows = await this.allowlistRepo.find({
            where: { tenantId },
            order: { createdAt: 'ASC' },
        });
        const known = new Set<string>(TENANT_JOB_RUNTIME_PROVIDER_IDS);
        return rows
            .map((row) => row.providerId)
            .filter((id): id is TenantJobRuntimeProviderId => known.has(id));
    }

    /**
     * Atomically replace the whole per-tenant allow-list row set inside
     * one transaction (delete-then-insert). An empty `providerIds[]`
     * clears the overlay (tenant falls back to inheriting the global
     * list when the gating flag is on).
     *
     * Defensive re-validation of each providerId against the static
     * `TENANT_JOB_RUNTIME_PROVIDER_IDS` list mirrors the DTO-layer
     * `IsIn` check — the controller already 400s unknown ids via the
     * DTO, but we re-check here so a programmatic caller (tests, future
     * internal callers) can never write a row with an unknown id.
     *
     * Emits one `operator_allowlist_change` audit row whose `before` /
     * `after` snapshots are the providerId arrays. The audit write
     * happens after the transaction commits — if the audit insert
     * fails, the mutation is still reflected in the table. We accept
     * that asymmetry because: (a) the per-tenant overlay is itself a
     * forward-only artefact (the row set IS the latest state), so a
     * missed audit row is recoverable from the table; (b) wrapping the
     * audit insert in the same transaction would couple the operator
     * surface to the audit repo's availability, which is worse.
     */
    async replaceTenantAllowlist(
        tenantId: string,
        providerIds: TenantJobRuntimeProviderId[] | readonly TenantJobRuntimeProviderId[],
        createdBy: string | null,
    ): Promise<TenantJobRuntimeProviderId[]> {
        const known = new Set<string>(TENANT_JOB_RUNTIME_PROVIDER_IDS);
        const validated: TenantJobRuntimeProviderId[] = [];
        for (const id of providerIds) {
            if (!known.has(id)) {
                throw new BadRequestException(
                    `provider '${id}' is not a known runtime — must be one of ` +
                        `${TENANT_JOB_RUNTIME_PROVIDER_IDS.join(', ')}`,
                );
            }
            validated.push(id);
        }

        const before = await this.listTenantAllowlist(tenantId);

        await this.dataSource.transaction(async (manager) => {
            const repo = manager.getRepository(TenantRuntimeProviderAllowlist);
            await repo.delete({ tenantId });
            if (validated.length > 0) {
                const rows = validated.map((providerId) =>
                    repo.create({
                        tenantId,
                        providerId,
                        createdBy,
                    }),
                );
                await repo.save(rows);
            }
        });

        const after = await this.listTenantAllowlist(tenantId);
        await this.emitAuditRaw({
            tenantId,
            actorUserId: createdBy,
            action: 'operator_allowlist_change',
            before: { providerIds: before },
            after: { providerIds: after },
            credentialVersion: null,
        });

        return after;
    }

    /**
     * Remove a single (tenantId, providerId) row from the per-tenant
     * allow-list. Returns true when a row was actually removed, false
     * when none matched. Only emits an `operator_allowlist_change`
     * audit row when a row was removed — a no-op delete should not
     * pollute the audit trail.
     */
    async deleteTenantAllowlistEntry(
        tenantId: string,
        providerId: TenantJobRuntimeProviderId,
        deletedBy: string | null,
    ): Promise<boolean> {
        const before = await this.listTenantAllowlist(tenantId);
        const result = await this.allowlistRepo.delete({ tenantId, providerId });
        const removed = (result.affected ?? 0) > 0;
        if (!removed) {
            return false;
        }
        const after = await this.listTenantAllowlist(tenantId);
        await this.emitAuditRaw({
            tenantId,
            actorUserId: deletedBy,
            action: 'operator_allowlist_change',
            before: { providerIds: before },
            after: { providerIds: after },
            credentialVersion: null,
        });
        return true;
    }

    /**
     * EW-752 P5.1 — resolver for the per-tenant intersection.
     *
     * Three states:
     *   1. `isPerTenantGatingEnabled()` is OFF → return the global list.
     *      The per-tenant table is ignored entirely; behaviour matches
     *      the EW-742 P5 global-only allow-list byte-for-byte. The
     *      table can be populated ahead of the flag flip safely.
     *   2. Flag is ON + tenant has zero rows → return the global list.
     *      Empty per-tenant row set is the INHERIT default, NOT "tenant
     *      has nothing". Enabling the flag without populating the table
     *      is a no-op for every existing tenant.
     *   3. Flag is ON + tenant has rows → return `global ∩ per-tenant`,
     *      preserving the global list's order. Entries in the per-tenant
     *      set that are NOT in the global list are silently dropped —
     *      the global env var is the upper bound (operators can shrink
     *      the platform-wide list and any tenant overlay that
     *      referenced a removed provider just stops resolving it).
     */
    async getAvailableProvidersForTenant(tenantId: string): Promise<TenantJobRuntimeProviderId[]> {
        const global = this.getAvailableProviders();
        if (!config.tenantJobRuntime.isPerTenantGatingEnabled()) {
            return global;
        }
        const perTenant = await this.listTenantAllowlist(tenantId);
        if (perTenant.length === 0) {
            return global;
        }
        const perTenantSet = new Set<string>(perTenant);
        return global.filter((id) => perTenantSet.has(id));
    }

    // ─── EW-752 P5.1 (T35b) — boot-time audit row helpers ──────────────

    /**
     * Return the most recent `operator_allowlist_boot` audit row
     * regardless of tenantId (boot rows always carry `tenantId = NULL`
     * but the query is intentionally tenant-agnostic — the boot audit
     * is global state).
     */
    async findLatestBootAudit(): Promise<TenantJobRuntimeAudit | null> {
        const row = await this.auditRepository.findOne({
            where: { action: 'operator_allowlist_boot' },
            order: { occurredAt: 'DESC' },
        });
        return row ?? null;
    }

    /**
     * Insert a boot-time `operator_allowlist_boot` audit row with
     * `tenantId = NULL`. Convenience wrapper used by
     * `TenantJobRuntimeBootAuditService` so the boot writer doesn't need
     * to know about the audit repo directly. Does NOT decorate `after`
     * with `operatorAllowedProviders` (that wrapper is for tenant-scoped
     * mutation rows where the allow-list is contextual; the boot row's
     * `after` blob already captures the allow-list directly).
     */
    async writeBootAudit(snapshot: {
        allowedProviders: string[];
        perTenantGatingEnabled: boolean;
        hash: string;
    }): Promise<void> {
        await this.emitAuditRaw({
            tenantId: null,
            actorUserId: null,
            action: 'operator_allowlist_boot',
            before: null,
            after: { ...snapshot },
            credentialVersion: null,
        });
    }

    /**
     * Append an audit row with full control over the payload (incl. a
     * NULL `tenantId` for the boot-time row). Used by the boot writer
     * and the per-tenant allow-list mutations. Skips the
     * `operatorAllowedProviders` decoration that `emitAudit` applies
     * to per-tenant mutations — the snapshots passed in here already
     * capture exactly the state the caller wants persisted.
     *
     * Exposed publicly so `TenantJobRuntimeBootAuditService` can call
     * it through its existing `service` reference; the boot service
     * delegates via `appendAuditRow` rather than reaching into the
     * audit repo so the test surface stays at the service boundary.
     */
    async appendAuditRow(payload: {
        tenantId: string | null;
        actorUserId: string | null;
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        credentialVersion: number | null;
    }): Promise<void> {
        await this.emitAuditRaw(payload);
    }

    /**
     * Internal raw audit insert — no `operatorAllowedProviders`
     * decoration, supports nullable `tenantId`. Used by every code path
     * that wants to write a row without the per-mutation snapshot
     * decoration (boot row + per-tenant allow-list mutations whose
     * before/after blobs are already the canonical state).
     */
    private async emitAuditRaw(payload: {
        tenantId: string | null;
        actorUserId: string | null;
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        credentialVersion: number | null;
    }): Promise<void> {
        const audit = this.auditRepository.create(payload as Partial<TenantJobRuntimeAudit>);
        await this.auditRepository.save(audit);
        this.logger.debug(
            `Audit: tenant=${payload.tenantId ?? 'NULL'} action=${payload.action} ` +
                `version=${payload.credentialVersion ?? 'null'}`,
        );
    }
}
