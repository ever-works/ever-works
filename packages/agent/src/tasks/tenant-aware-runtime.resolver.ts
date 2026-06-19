import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IJobRuntimeProvider, JobRuntimeId } from '@ever-works/plugin';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';
import { CredentialVersionService } from './credential-version.service';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from './job-runtime.providers';
import { SECRET_STORE_RESOLVER, type SecretStoreResolver } from './secret-store-resolver.interface';
import { TenantCredentialCache } from './tenant-credential.cache';

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
 * # Scope on `main` after EW-742 P3.2 (this PR)
 *
 *   - `null` / `undefined` tenantId → instance default (the EW-683
 *     pre-tenancy code path, byte-identical — no DB hit).
 *   - No overlay row → instance default (T23 fallback).
 *   - `mode === 'inherit'` → instance default (T23 fallback).
 *   - `enabled === false` → instance default (soft kill switch).
 *   - `mode === 'byo' | 'override'` with `enabled === true`:
 *     1. cache check against `(tenantId, providerId, credentialVersion)`;
 *     2. on miss, resolve `credentialsSecretRef` via
 *        {@link SecretStoreResolver};
 *     3. call `activeProvider.bindToTenant(snapshot)` (EW-686 P2
 *        contract);
 *     4. cache the bound provider; return it.
 *     Any null/undefined/throw anywhere in this chain falls back to
 *     the instance default and logs at `warn`.
 *
 * # What's STILL deferred
 *
 *   - **T22 per-dispatcher wiring**: dispatch call sites still need to
 *     call `RuntimeBindingStamperService.stamp(tenantId)` and persist
 *     `credentialVersion` into each run record. {@link getEffectiveBinding}
 *     already returns the metadata callers will use; each dispatcher
 *     migration is its own PR.
 *   - **Per-provider `bindToTenant` implementations**: each
 *     `IJobRuntimeProvider` implementation needs to actually wire the
 *     hook (Trigger.dev/TriggerService is the first — EW-686 P2 only
 *     shipped the contract). Until each provider implements it, this
 *     resolver's path 1 fallback (`provider.bindToTenant is not a
 *     function`) fires and we silently revert to the instance default
 *     for that provider.
 *   - **Non-`inline:` secret-store schemes**: the bundled
 *     `InProcessSecretStoreResolver` only supports `inline:` for dev /
 *     test. Production deployments must bind a real
 *     {@link SecretStoreResolver} for their scheme (`vault:`, `k8s:`,
 *     `op:`, etc.).
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
        @Inject(SECRET_STORE_RESOLVER)
        private readonly secretStoreResolver: SecretStoreResolver,
        private readonly credentialCache: TenantCredentialCache,
    ) {}

    /**
     * Resolves the {@link IJobRuntimeProvider} that should service work
     * for `tenantId`. Returns `null` when no provider is registered
     * (the EW-683 in-process dev fallback semantic — preserved from
     * `JobRuntimeProviderRegistry.getActive()`).
     *
     * For `byo` / `override` modes with `enabled = true`, delegates to
     * {@link bindForOverlay} which resolves credentials + calls
     * `provider.bindToTenant(snapshot)` + memoises via
     * {@link TenantCredentialCache}. See the class JSDoc for the full
     * happy-path + fallback contract.
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

        // mode === 'byo' | 'override' AND enabled — actual tenant
        // binding path. EW-742 P3.2 wiring: resolve the credential
        // snapshot, call provider.bindToTenant(snapshot), memoise via
        // TenantCredentialCache. Every failure mode falls back to the
        // instance default and logs at warn so operators can diagnose.
        return this.bindForOverlay(tenantId, row);
    }

    /**
     * EW-742 P3.2 — drives the actual byo/override bind path. Factored
     * out of {@link resolve} so the happy path stays readable and the
     * cache-miss flow (resolve secret → snapshot → bindToTenant) is one
     * linear function.
     *
     * Five fallback-to-instance-default paths, each logged at warn:
     *   1. Active provider doesn't expose `bindToTenant?` at all
     *      (provider doesn't support per-tenant binding).
     *   2. `SecretStoreResolver.resolve` returns `null` (unknown scheme,
     *      missing entry, malformed payload).
     *   3. `provider.bindToTenant(snapshot)` returns `undefined`
     *      (provider rejects the snapshot for its own reasons).
     *   4. Anywhere in the chain throws (defence-in-depth — the contract
     *      says implementations don't throw, but if one does, an
     *      enqueue MUST NOT fail because of overlay resolution).
     *   5. `this.registry.getActive()` returns `null` (EW-683 in-process
     *      dev fallback — preserved).
     */
    private async bindForOverlay(
        tenantId: string,
        row: TenantJobRuntimeConfig,
    ): Promise<IJobRuntimeProvider | null> {
        const activeProvider = this.registry.getActive();
        if (!activeProvider) {
            // EW-683 in-process dev fallback — preserved.
            return null;
        }

        if (typeof activeProvider.bindToTenant !== 'function') {
            // Path 1: provider doesn't support per-tenant binding.
            // Push providers that don't expose a way to swap credentials
            // (or providers whose implementation doesn't override the
            // optional contract) fall through to the instance default.
            this.logger.warn(
                `tenant ${tenantId} overlay mode=${row.mode} providerId=${row.providerId} ` +
                    `credentialVersion=${row.credentialVersion}: active provider ` +
                    `"${activeProvider.runtimeId}" does not implement bindToTenant() — ` +
                    `falling back to instance default. Either upgrade the provider or set ` +
                    `mode=inherit on the overlay.`,
            );
            return activeProvider;
        }

        // Cache check — keyed by (tenantId, providerId, credentialVersion).
        // Same key the worker host will resolve against when handling the
        // run later, so an in-flight run keeps its pinned snapshot.
        const cacheKey = activeProvider.runtimeId;
        const cached = this.credentialCache.get<IJobRuntimeProvider>(
            tenantId,
            cacheKey,
            row.credentialVersion,
        );
        if (cached) {
            return cached;
        }

        // Cache miss — resolve the credentials, build the snapshot, ask
        // the provider to bind, cache the binding.
        let credentials: Record<string, unknown> | null;
        try {
            credentials = await this.secretStoreResolver.resolve(row.credentialsSecretRef);
        } catch (err) {
            // Path 4 — contract says resolvers fail-open with null, but
            // defend against a thrown error anyway. Never let overlay
            // resolution block an enqueue.
            this.logger.warn(
                `tenant ${tenantId} overlay mode=${row.mode}: SecretStoreResolver threw ` +
                    `(${err instanceof Error ? err.message : String(err)}) — falling back ` +
                    `to instance default.`,
            );
            return activeProvider;
        }

        if (!credentials) {
            // Path 2: resolver returned null. Already logged warn inside
            // the resolver itself; add the tenant context here for
            // operators tracing from the enqueue side.
            this.logger.warn(
                `tenant ${tenantId} overlay mode=${row.mode}: SecretStoreResolver returned ` +
                    `null for credentialsSecretRef "${row.credentialsSecretRef}" — falling back ` +
                    `to instance default.`,
            );
            return activeProvider;
        }

        let bound: IJobRuntimeProvider | undefined;
        try {
            bound = activeProvider.bindToTenant({
                tenantId,
                providerId: activeProvider.runtimeId as JobRuntimeId,
                credentialVersion: row.credentialVersion,
                credentials,
            });
        } catch (err) {
            // Path 4 — same defence as the resolver branch above.
            this.logger.warn(
                `tenant ${tenantId} overlay mode=${row.mode}: provider.bindToTenant threw ` +
                    `(${err instanceof Error ? err.message : String(err)}) — falling back ` +
                    `to instance default.`,
            );
            return activeProvider;
        }

        if (!bound) {
            // Path 3: provider rejected the snapshot. Already explained
            // in the contract — provider returns undefined when it
            // doesn't want to bind THIS particular snapshot (e.g. the
            // credentials are valid-shaped but unusable). Fall back.
            this.logger.warn(
                `tenant ${tenantId} overlay mode=${row.mode}: provider.bindToTenant returned ` +
                    `undefined — falling back to instance default.`,
            );
            return activeProvider;
        }

        // Cache the bound provider for subsequent enqueues against the
        // same (tenantId, providerId, credentialVersion). Eviction is
        // version-bump-driven (CredentialVersionService bumps + the
        // controller invalidates the cache), so no need to scope the
        // TTL tighter than the cache's default.
        this.credentialCache.set(tenantId, cacheKey, row.credentialVersion, bound);
        return bound;
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
