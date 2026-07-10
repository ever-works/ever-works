import type { IJobRuntimeProvider, JobRuntimeDispatchers } from '@ever-works/plugin';
import type { Repository } from 'typeorm';
import { CredentialVersionService } from '../credential-version.service';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import type { JobRuntimeProviderRegistry } from '../job-runtime.providers';
import type { SecretStoreResolver } from '../secret-store-resolver.interface';
import { TenantCredentialCache } from '../tenant-credential.cache';
import { TenantAwareRuntimeResolver } from '../tenant-aware-runtime.resolver';

/**
 * EW-742 T37 closeout — cross-provider tenant isolation (mocks-only).
 *
 * The base `tenant-aware-runtime.resolver.spec.ts` pins single-provider
 * routing + the five fallback paths. This spec layers the cross-provider
 * isolation invariant on top: when two tenants resolve through providers
 * impersonating DIFFERENT runtimes (here `pgboss` + `temporal`), the
 * resolver MUST route each tenant to its own provider's bound view and
 * never cross-contaminate.
 *
 * # Why this is mocks-only
 *
 * Real cross-provider isolation (tenant A on pg-boss + tenant B on
 * Temporal in the SAME api process, with actual `pg-boss` and
 * `@temporalio/worker` instances side-by-side) is T32 real-infra
 * territory. The contract-surface guarantees that protect tenants from
 * each other don't need the network — they live in:
 *
 *   1. the resolver picking the right provider for each tenant;
 *   2. the provider's `bindToTenant` memo being per-provider, not shared;
 *   3. {@link TenantCredentialCache} keying on `(tenantId, providerId,
 *      version)` so an invalidate for tenant A never drops tenant B;
 *   4. fail-open semantics (FR-5): if provider A throws for tenant A,
 *      tenant B (a different provider) MUST keep working.
 *
 * Wiring the SUT against a `TenantRoutingRegistry` test double is the
 * smallest possible vehicle for those invariants — no DB, no NestJS
 * `Test.createTestingModule`, no `IJobRuntimeProvider` plugin packages
 * dragged in as runtime deps.
 *
 * # Why a custom registry instead of two resolvers
 *
 * The shipped `JobRuntimeProviderRegistry.getActive()` takes no tenant
 * arg — single-active-runtime per process per EW-683 §4. To exercise
 * "tenant A → pgboss, tenant B → temporal" against ONE resolver
 * instance, this spec wires a {@link TenantRoutingRegistry} test double
 * whose `getActive()` returns whichever provider the resolver is
 * currently bind-resolving for. The hook is the `configRepo.findOne`
 * side effect: every `resolve(tenantId)` call hits `findOne({ where:
 * { tenantId } })` BEFORE `registry.getActive()` (see
 * `tenant-aware-runtime.resolver.ts` L109 vs L161), so the findOne
 * mock can flip the registry's "current tenant" pointer in lockstep.
 *
 * This mirrors how T36 + T40 (`runJobRuntimeTenantContractSuite` in
 * `@ever-works/plugin/contracts-conformance`) prove cross-tenant
 * isolation at the plugin contract surface; this spec covers the
 * RESOLVER end of the same invariant.
 */
describe('Cross-provider tenant isolation (EW-742 T37 closeout, mocks-only)', () => {
    const TENANT_A = 'tenant-a-pgboss';
    const TENANT_B = 'tenant-b-temporal';

    /**
     * Build a per-runtime test double. Each one gets a distinct
     * `runtimeId` (so the cache key `(tenantId, runtimeId, version)`
     * differs across providers) and a sentinel dispatcher object —
     * referential equality on the sentinel is what proves routing
     * landed on the right provider.
     */
    function mockProvider(
        runtimeId: 'pgboss' | 'temporal',
        dispatchers: JobRuntimeDispatchers,
        bindToTenant?: IJobRuntimeProvider['bindToTenant'],
    ): IJobRuntimeProvider {
        return {
            id: `mock-${runtimeId}`,
            name: `Mock ${runtimeId} Provider`,
            version: '0.0.0-test',
            category: 'job-runtime' as IJobRuntimeProvider['category'],
            capabilities: [],
            settingsSchema: { type: 'object', properties: {} },
            runtimeId,
            dispatchers,
            async registerSchedules() {
                /* no-op */
            },
            async cancel() {
                return false;
            },
            async getRunStatus() {
                return 'unknown';
            },
            isEnabled() {
                return true;
            },
            async onLoad() {
                /* no-op */
            },
            async onUnload() {
                /* no-op */
            },
            bindToTenant,
        } satisfies IJobRuntimeProvider;
    }

    /**
     * Registry double that maps `tenantId → IJobRuntimeProvider`. The
     * "current tenant" pointer is flipped by the configRepo.findOne
     * mock before each call to `resolve()` reaches `getActive()` — this
     * is the seam that lets a single resolver instance route two
     * tenants to two different providers.
     */
    class TenantRoutingRegistry implements JobRuntimeProviderRegistry {
        private readonly providers = new Map<string, IJobRuntimeProvider>();
        // The "default" provider returned when no tenant context is set
        // (matches the EW-683 single-active-runtime semantic for null /
        // undefined tenant IDs). Set to whatever provider was registered
        // first — arbitrary, but stable.
        private defaultProvider: IJobRuntimeProvider | null = null;
        private currentTenant: string | null = null;

        bindTenant(tenantId: string, provider: IJobRuntimeProvider): void {
            this.providers.set(tenantId, provider);
            if (this.defaultProvider === null) {
                this.defaultProvider = provider;
            }
        }

        setCurrentTenant(tenantId: string | null): void {
            this.currentTenant = tenantId;
        }

        register(provider: IJobRuntimeProvider): void {
            // Not used by these tests — bindings are scoped by tenant.
            // Implement to satisfy the interface; last-write-wins as the
            // base registry does.
            this.defaultProvider = provider;
        }

        getActive(): IJobRuntimeProvider | null {
            if (this.currentTenant === null) {
                return this.defaultProvider;
            }
            return this.providers.get(this.currentTenant) ?? this.defaultProvider;
        }
    }

    function buildConfigRow(
        tenantId: string,
        providerId: 'pgboss' | 'temporal',
        overrides: Partial<TenantJobRuntimeConfig> = {},
    ): TenantJobRuntimeConfig {
        const now = new Date('2026-06-21T12:00:00.000Z');
        return {
            tenantId,
            providerId,
            // Different inline pointers per tenant so the
            // SecretStoreResolver mock can return per-tenant credential
            // bags and the assertions can prove provider A's bindToTenant
            // got tenant A's bag (not tenant B's).
            credentialsSecretRef: `inline:${tenantId}-${providerId}-secret`,
            credentialVersion: 1,
            mode: 'byo',
            enabled: true,
            createdBy: 'operator-1',
            createdAt: now,
            updatedAt: now,
            ...overrides,
        } as TenantJobRuntimeConfig;
    }

    /**
     * Fixture builder — wires the routing registry, a tenant-aware
     * configRepo mock that updates the registry's "current tenant" as
     * a side effect of `findOne`, per-tenant secret bags, and a fresh
     * cache. Returns hooks for each test to drive bindings + assertions.
     */
    function buildFixture() {
        const registry = new TenantRoutingRegistry();

        // Distinct sentinel dispatchers — referential identity is what
        // proves routing landed on the right provider. Keyed by
        // `runtimeId` so a "is this the pgboss or temporal view?" check
        // is just an object-identity test.
        const pgbossDispatchers: JobRuntimeDispatchers = { which: 'pgboss-dispatchers' };
        const temporalDispatchers: JobRuntimeDispatchers = { which: 'temporal-dispatchers' };

        // bindToTenant returns a per-(tenant, version) bound view so a
        // cache check on a repeat resolve can short-circuit, and so
        // call-count assertions on the mock prove the resolver isn't
        // calling the WRONG provider's bindToTenant.
        const pgbossBound: JobRuntimeDispatchers = { which: 'pgboss-bound' };
        const temporalBound: JobRuntimeDispatchers = { which: 'temporal-bound' };

        const pgbossBindToTenant = jest
            .fn<
                IJobRuntimeProvider | undefined,
                Parameters<NonNullable<IJobRuntimeProvider['bindToTenant']>>
            >()
            .mockImplementation((snapshot) =>
                mockProvider('pgboss', pgbossBound, () => {
                    throw new Error(
                        `re-binding a bound view is not expected in T37 (snapshot=${snapshot.tenantId})`,
                    );
                }),
            );
        const temporalBindToTenant = jest
            .fn<
                IJobRuntimeProvider | undefined,
                Parameters<NonNullable<IJobRuntimeProvider['bindToTenant']>>
            >()
            .mockImplementation((snapshot) =>
                mockProvider('temporal', temporalBound, () => {
                    throw new Error(
                        `re-binding a bound view is not expected in T37 (snapshot=${snapshot.tenantId})`,
                    );
                }),
            );

        const pgbossProvider = mockProvider('pgboss', pgbossDispatchers, pgbossBindToTenant);
        const temporalProvider = mockProvider(
            'temporal',
            temporalDispatchers,
            temporalBindToTenant,
        );

        registry.bindTenant(TENANT_A, pgbossProvider);
        registry.bindTenant(TENANT_B, temporalProvider);

        // Per-tenant overlay rows. The findOne mock returns the right
        // row for the requested tenant AND flips the registry's
        // current-tenant pointer so the resolver's downstream
        // `getActive()` lands on the matching provider.
        const rowA = buildConfigRow(TENANT_A, 'pgboss');
        const rowB = buildConfigRow(TENANT_B, 'temporal');
        const rowsByTenant = new Map<string, TenantJobRuntimeConfig>([
            [TENANT_A, rowA],
            [TENANT_B, rowB],
        ]);

        const configRepo = {
            findOne: jest.fn().mockImplementation(async (opts: { where: { tenantId: string } }) => {
                const tenantId = opts.where.tenantId;
                registry.setCurrentTenant(tenantId);
                return rowsByTenant.get(tenantId) ?? null;
            }),
        };

        // Per-tenant credential bags. Identity matters — the assertions
        // verify the right bag landed in the right provider's
        // bindToTenant call.
        const credsA = { driver: 'pgboss', accessToken: `pg-${TENANT_A}` } as const;
        const credsB = { driver: 'temporal', accessToken: `temp-${TENANT_B}` } as const;
        const credsByPointer = new Map<string, Record<string, unknown>>([
            [rowA.credentialsSecretRef, { ...credsA }],
            [rowB.credentialsSecretRef, { ...credsB }],
        ]);
        const secretStoreResolver: SecretStoreResolver & { resolve: jest.Mock } = {
            resolve: jest.fn().mockImplementation(async (pointer: string) => {
                return credsByPointer.get(pointer) ?? null;
            }),
        };

        const credentialVersionService = {
            getCurrentVersion: jest.fn().mockResolvedValue(1),
        };

        const cache = new TenantCredentialCache();
        const resolver = new TenantAwareRuntimeResolver(
            registry,
            configRepo as unknown as Repository<TenantJobRuntimeConfig>,
            credentialVersionService as unknown as CredentialVersionService,
            secretStoreResolver,
            cache,
        );

        return {
            resolver,
            registry,
            configRepo,
            secretStoreResolver,
            cache,
            pgbossProvider,
            temporalProvider,
            pgbossBindToTenant,
            temporalBindToTenant,
            pgbossBound,
            temporalBound,
            rowA,
            rowB,
            credsA,
            credsB,
        };
    }

    it('routes tenant A to pgboss and tenant B to temporal, regardless of call order', async () => {
        const fx = buildFixture();

        // Resolve B first to prove call order is irrelevant — the
        // routing decision is bound to the tenantId, not to any
        // implicit "last registered" or first-call state.
        const boundB = await fx.resolver.resolve(TENANT_B);
        const boundA = await fx.resolver.resolve(TENANT_A);

        // Each tenant's bound view must carry its own provider's
        // dispatchers sentinel — referential identity guarantees no
        // accidental object-shape coincidence is hiding a swap.
        expect(boundA?.runtimeId).toBe('pgboss');
        expect(boundA?.dispatchers).toBe(fx.pgbossBound);
        expect(boundB?.runtimeId).toBe('temporal');
        expect(boundB?.dispatchers).toBe(fx.temporalBound);

        // Each provider's bindToTenant fired exactly once and got its
        // OWN tenant's snapshot (tenantId + providerId + credentials
        // all aligned with the per-tenant fixtures).
        expect(fx.pgbossBindToTenant).toHaveBeenCalledTimes(1);
        expect(fx.pgbossBindToTenant).toHaveBeenCalledWith({
            tenantId: TENANT_A,
            providerId: 'pgboss',
            credentialVersion: 1,
            credentials: fx.credsA,
        });
        expect(fx.temporalBindToTenant).toHaveBeenCalledTimes(1);
        expect(fx.temporalBindToTenant).toHaveBeenCalledWith({
            tenantId: TENANT_B,
            providerId: 'temporal',
            credentialVersion: 1,
            credentials: fx.credsB,
        });
    });

    it("resolving tenant A's binding never invokes tenant B's provider.bindToTenant", async () => {
        const fx = buildFixture();

        // Drive tenant A through the bind path multiple times — repeat
        // resolves should hit the cache after the first, but the
        // important invariant is that NONE of those calls touches the
        // temporal provider's bind hook.
        await fx.resolver.resolve(TENANT_A);
        await fx.resolver.resolve(TENANT_A);
        await fx.resolver.resolve(TENANT_A);

        expect(fx.pgbossBindToTenant).toHaveBeenCalledTimes(1);
        // The cross-contamination check: temporal's bindToTenant MUST
        // stay at zero invocations because tenant A never routes to it.
        expect(fx.temporalBindToTenant).not.toHaveBeenCalled();
        // And the secret-store resolver only dereferenced tenant A's
        // pointer — tenant B's secret was never touched.
        expect(fx.secretStoreResolver.resolve).toHaveBeenCalledTimes(1);
        expect(fx.secretStoreResolver.resolve).toHaveBeenCalledWith(fx.rowA.credentialsSecretRef);
    });

    it("invalidating tenant A's cache does not re-bind tenant B (per-tenant cache eviction)", async () => {
        const fx = buildFixture();

        // Warm both tenants' caches.
        await fx.resolver.resolve(TENANT_A);
        await fx.resolver.resolve(TENANT_B);
        expect(fx.pgbossBindToTenant).toHaveBeenCalledTimes(1);
        expect(fx.temporalBindToTenant).toHaveBeenCalledTimes(1);

        // Force-invalidate ONLY tenant A's pgboss binding. This is the
        // operator-initiated path from
        // `POST /api/account/job-runtime/force-invalidate` — see
        // `TenantCredentialCache.invalidate` JSDoc.
        fx.cache.invalidate(TENANT_A, 'pgboss');

        // Tenant A's next resolve must miss the cache → re-bind.
        // Tenant B's next resolve must HIT the cache → no re-bind.
        await fx.resolver.resolve(TENANT_A);
        await fx.resolver.resolve(TENANT_B);

        expect(fx.pgbossBindToTenant).toHaveBeenCalledTimes(2);
        // Tenant B is unaffected by the tenant-A invalidate — call
        // count stays at exactly 1.
        expect(fx.temporalBindToTenant).toHaveBeenCalledTimes(1);
    });

    it('fault in pgboss for tenant A falls open to that provider as default; temporal keeps serving tenant B (FR-5)', async () => {
        const fx = buildFixture();

        // Make pgboss.bindToTenant throw — the resolver MUST catch +
        // log + return the (unbound) instance default for tenant A
        // rather than propagating an error. This is the fail-open
        // contract from FR-5 / class JSDoc path 4.
        fx.pgbossBindToTenant.mockImplementationOnce(() => {
            throw new Error('pgboss connection refused');
        });

        const boundA = await fx.resolver.resolve(TENANT_A);
        const boundB = await fx.resolver.resolve(TENANT_B);

        // Tenant A's resolve returns the pgboss provider's UNBOUND view
        // (the instance default for tenant A's route, NOT the bound
        // sentinel). The runtimeId is still `pgboss` because the
        // fallback returns the active provider as-is.
        expect(boundA?.runtimeId).toBe('pgboss');
        expect(boundA?.dispatchers).toBe(fx.pgbossProvider.dispatchers);
        // And critically — the fault didn't leak into tenant B's
        // resolve. Tenant B's temporal binding is the normal bound
        // view, identical to the happy-path case.
        expect(boundB?.runtimeId).toBe('temporal');
        expect(boundB?.dispatchers).toBe(fx.temporalBound);
        expect(fx.temporalBindToTenant).toHaveBeenCalledTimes(1);
    });

    it('sequential A→B→A round-trips never cross-pollinate bound views (cache identity check)', async () => {
        const fx = buildFixture();

        const firstA = await fx.resolver.resolve(TENANT_A);
        const firstB = await fx.resolver.resolve(TENANT_B);
        const secondA = await fx.resolver.resolve(TENANT_A);
        const secondB = await fx.resolver.resolve(TENANT_B);

        // Identity stability per tenant: the cache returns the SAME
        // bound-view object for repeat resolves of the same
        // `(tenantId, providerId, version)`. If the cache key ever
        // collided across runtimes (e.g. accidentally keyed only by
        // tenantId), tenant B's second resolve would return tenant A's
        // bound view. Pin both halves of the invariant explicitly.
        expect(firstA).toBe(secondA);
        expect(firstB).toBe(secondB);
        expect(firstA).not.toBe(firstB);

        // And the per-provider bind hooks each fired exactly once
        // across all four resolves — the cache absorbed every repeat.
        expect(fx.pgbossBindToTenant).toHaveBeenCalledTimes(1);
        expect(fx.temporalBindToTenant).toHaveBeenCalledTimes(1);

        // NOTE — we intentionally don't ship a `Promise.all([resolve(A),
        // resolve(B)])` test against this fixture: the resolver's
        // `getActive()` is a no-arg API (EW-683 single-active-runtime),
        // so the routing trick here uses a shared `currentTenant`
        // pointer flipped by findOne. Two concurrent resolves through
        // the same registry double would race the pointer — that's a
        // fixture limitation, not a SUT race. Real concurrent
        // cross-provider safety lives at the API binding layer and is
        // already covered by the T36 conformance suite + the T32
        // real-infra job in `.github/workflows/ci.yml`.
    });
});
