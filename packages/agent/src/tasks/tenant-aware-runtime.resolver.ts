import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IJobRuntimeProvider } from '@ever-works/plugin';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';
import { CredentialVersionService } from './credential-version.service';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from './job-runtime.providers';

/**
 * EW-742 P3 / EW-747 (T20 + T23) — tenant-aware job-runtime resolver.
 *
 * Sits between the dispatch call sites and the EW-685 P0 T4 binding
 * factory registry, so the same `*_DISPATCHER` seam can pick a tenant's
 * overlay provider rather than always returning the instance-global
 * active provider. Today every call site still goes through the binding
 * factory and the instance default; this resolver is the next step
 * toward the per-tenant overlay described in
 * [`plan.md` §10 P3](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#p3--dispatcher-routing-tenant-aware-resolver--credential-version-capture)
 * and [ADR-017](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md).
 *
 * # Scope of THIS PR (minimal viable T20 + T23 + T24)
 *
 *   - `null` / `undefined` tenantId → instance default (the EW-683
 *     pre-tenancy code path, byte-identical — no DB hit).
 *   - No overlay row → instance default (T23 fallback).
 *   - `mode === 'inherit'` → instance default (T23 fallback).
 *   - `enabled === false` → instance default (soft kill switch).
 *   - `mode === 'byo' | 'override'` with `enabled === true` → returns the
 *     instance default for now with a `Logger.debug` noting the deferral.
 *     The honest stopgap: the entity exists, the row is read, the
 *     decision is made, but actually swapping the active provider's
 *     credentials requires the per-provider credential-binding API that
 *     lives in EW-686 P2 territory (see TODO block below).
 *
 * # Deferred to follow-up PRs (called out as TODO, NOT silently skipped)
 *
 *   - **T21 — credential cache (15–60s LRU keyed by
 *     `(tenantId, providerId, credentialVersion)`)**: every `resolve()`
 *     call hits the database today. Will land in
 *     `packages/agent/src/tasks/tenant-credential.cache.ts`.
 *   - **T22 — credential version capture at every enqueue**: dispatch
 *     call sites need to stamp `credentialVersion` into the run record
 *     so the worker host can resolve the same snapshot when the job
 *     runs. {@link getEffectiveBinding} already returns the metadata
 *     callers will need; no enqueue-site changes ship in this PR.
 *   - **Per-provider credential-binding API (EW-686 P2)**: until the
 *     active `IJobRuntimeProvider` exposes a way to bind a specific
 *     credential snapshot for one call, `byo` and `override` cannot
 *     functionally swap credentials. The resolver reads the row and
 *     logs the decision, but returns the instance default's provider —
 *     the code path is in place, only the per-provider hook is missing.
 *
 * # Why no `getActive(tenantId)` extension on the registry
 *
 * EW-685 P0 T4 kept the registry interface deliberately minimal —
 * `register` + `getActive()`. Pushing the tenant lookup into the
 * registry would force every registry consumer to think about tenants
 * even when they don't have one (e.g. boot-time `register()` of the
 * default provider). The resolver wraps the registry instead: the
 * registry stays concerned with "what provider is bound for this
 * deployment", the resolver decides "which provider does THIS tenant
 * resolve to right now". Same separation `CredentialVersionService`
 * and the overlay entity already use.
 */
@Injectable()
export class TenantAwareRuntimeResolver {
    private readonly logger = new Logger(TenantAwareRuntimeResolver.name);

    constructor(
        @Inject(JOB_RUNTIME_PROVIDER_REGISTRY)
        private readonly registry: JobRuntimeProviderRegistry,
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly configRepository: Repository<TenantJobRuntimeConfig>,
        private readonly credentialVersionService: CredentialVersionService,
    ) {}

    /**
     * Resolves the {@link IJobRuntimeProvider} that should service work
     * for `tenantId`. Returns `null` when no provider is registered
     * (the EW-683 in-process dev fallback semantic — preserved from
     * `JobRuntimeProviderRegistry.getActive()`).
     *
     * Honest stopgap for `byo` / `override` modes: see the class JSDoc
     * — we read the row, log the decision, and return the instance
     * default because the per-provider credential-binding hook isn't
     * shipped yet.
     */
    async resolve(tenantId: string | null | undefined): Promise<IJobRuntimeProvider | null> {
        if (!tenantId) {
            // Preserve the pre-tenancy code path byte-identically: no
            // tenant context → instance default, no DB hit.
            return this.registry.getActive();
        }

        const row = await this.configRepository.findOne({ where: { tenantId } });
        if (!row) {
            // T23 fallback: tenant has never opted in to the overlay,
            // behave exactly like the instance default.
            return this.registry.getActive();
        }

        if (!row.enabled) {
            // Soft kill switch (plan.md §3 / entity JSDoc): operator or
            // tenant can disable the overlay row without dropping the
            // credential pointer; resolver MUST treat as inherit.
            return this.registry.getActive();
        }

        if (row.mode === 'inherit') {
            // Same as no row — explicit inherit. Defensive branch so a
            // future audit-log diff can distinguish "row exists but
            // inherit" from "no row" at the resolver level.
            return this.registry.getActive();
        }

        // mode === 'byo' | 'override' AND enabled — honest stopgap.
        // See the class JSDoc "Scope of THIS PR" + the per-provider
        // credential-binding API note. Logger.debug rather than warn
        // because this is the documented behaviour for P3, not a fault.
        this.logger.debug(
            `tenant ${tenantId} overlay mode=${row.mode} providerId=${row.providerId} ` +
                `credentialVersion=${row.credentialVersion}: returning instance default ` +
                `(tenant override deferred to P3.1 — credential injection wiring lands ` +
                `once per-provider credential-binding API exists)`,
        );
        return this.registry.getActive();
    }

    /**
     * Returns the same provider as {@link resolve} plus the metadata
     * callers need for run-record stamping (T22 will use this to
     * capture `credentialVersion` at enqueue time so the worker host
     * resolves the same snapshot via
     * {@link CredentialVersionService.resolveSnapshot}).
     *
     * Mode mapping:
     *   - `null` / `undefined` tenantId → `mode = 'inherit'`,
     *     `credentialVersion = null`.
     *   - No overlay row OR `mode = 'inherit'` OR `enabled = false` →
     *     `mode = 'inherit'`, `credentialVersion = null`.
     *   - `mode = 'byo' | 'override'` AND `enabled = true` →
     *     `mode = 'tenant-override'`, `credentialVersion` from
     *     {@link CredentialVersionService.getCurrentVersion}.
     *
     * The returned `provider` is whatever {@link resolve} would return
     * today — including the honest-stopgap behaviour for byo/override.
     */
    async getEffectiveBinding(tenantId: string | null | undefined): Promise<{
        provider: IJobRuntimeProvider | null;
        mode: 'inherit' | 'tenant-override';
        credentialVersion: number | null;
    }> {
        if (!tenantId) {
            return {
                provider: this.registry.getActive(),
                mode: 'inherit',
                credentialVersion: null,
            };
        }

        const row = await this.configRepository.findOne({ where: { tenantId } });
        if (!row || !row.enabled || row.mode === 'inherit') {
            return {
                provider: this.registry.getActive(),
                mode: 'inherit',
                credentialVersion: null,
            };
        }

        // byo / override + enabled — read the current version so T22
        // can stamp it onto the run record. The provider itself is
        // still the instance default (see class JSDoc on the
        // per-provider credential-binding API deferral).
        const credentialVersion = await this.credentialVersionService.getCurrentVersion(tenantId);
        return {
            provider: this.registry.getActive(),
            mode: 'tenant-override',
            credentialVersion,
        };
    }
}
