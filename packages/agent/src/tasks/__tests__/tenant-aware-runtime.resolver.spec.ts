import type { IJobRuntimeProvider, JobRuntimeDispatchers } from '@ever-works/plugin';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { CredentialVersionService } from '../credential-version.service';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import { InMemoryJobRuntimeProviderRegistry } from '../job-runtime.providers';
import { TenantAwareRuntimeResolver } from '../tenant-aware-runtime.resolver';

/**
 * EW-742 P3 / EW-747 (T24) — tenant-aware resolver unit tests.
 *
 * Covers the minimal-viable subset of T20 + T23 that ships this PR:
 *
 *   - null / undefined / no-row / inherit / disabled → instance default
 *     (T23 fallback, plus the kill switch path);
 *   - byo + override modes with `enabled = true` → instance default
 *     (P3.1 honest stopgap — see resolver class JSDoc), with
 *     `Logger.debug` proving the deferral was logged;
 *   - `getEffectiveBinding` returns the metadata T22 will need to stamp
 *     onto the run record at enqueue time;
 *   - `registry.getActive()` returning `null` propagates as `null` (the
 *     EW-683 in-process dev fallback semantic — preserved).
 *
 * Deliberately NOT covered here (deferred PRs own these):
 *   - T21 (cache hit/miss + invalidation on rotation)
 *   - T22 (enqueue-site `credentialVersion` capture)
 *   - per-provider credential injection (EW-686 P2)
 */
describe('TenantAwareRuntimeResolver (EW-742 P3 / EW-747 T20 + T23 + T24)', () => {
    /**
     * Build a minimal {@link IJobRuntimeProvider} test double. We only
     * exercise identity here — the resolver hands the registry's
     * provider back as-is — so the `dispatchers` payload is just a
     * sentinel string keyed by `which`.
     */
    function mockProvider(
        dispatchers: JobRuntimeDispatchers = { sentinel: 'instance-default' },
    ): IJobRuntimeProvider {
        return {
            id: 'mock',
            name: 'Mock Provider',
            version: '0.0.0-test',
            category: 'job-runtime' as IJobRuntimeProvider['category'],
            capabilities: [],
            settingsSchema: { type: 'object', properties: {} },
            runtimeId: 'trigger',
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
        } satisfies IJobRuntimeProvider;
    }

    function buildConfigRow(
        overrides: Partial<TenantJobRuntimeConfig> = {},
    ): TenantJobRuntimeConfig {
        const now = new Date('2026-06-18T12:00:00.000Z');
        return {
            tenantId: 'tenant-1',
            providerId: 'trigger',
            credentialsSecretRef: 'tenant-job-runtime:abc123:trigger:v1',
            credentialVersion: 7,
            mode: 'byo',
            enabled: true,
            createdBy: 'user-1',
            createdAt: now,
            updatedAt: now,
            ...overrides,
        } as TenantJobRuntimeConfig;
    }

    type ConfigRepoMock = Pick<Repository<TenantJobRuntimeConfig>, 'findOne'> & {
        findOne: jest.Mock;
    };

    type CredentialVersionServiceMock = Pick<CredentialVersionService, 'getCurrentVersion'> & {
        getCurrentVersion: jest.Mock;
    };

    function buildResolver(
        opts: {
            registry?: InMemoryJobRuntimeProviderRegistry;
            repoFindOneReturn?: TenantJobRuntimeConfig | null;
            credentialVersion?: number | null;
        } = {},
    ): {
        resolver: TenantAwareRuntimeResolver;
        registry: InMemoryJobRuntimeProviderRegistry;
        configRepo: ConfigRepoMock;
        credentialVersionService: CredentialVersionServiceMock;
    } {
        const registry = opts.registry ?? new InMemoryJobRuntimeProviderRegistry();
        const configRepo: ConfigRepoMock = {
            findOne: jest.fn().mockResolvedValue(opts.repoFindOneReturn ?? null),
        };
        const credentialVersionService: CredentialVersionServiceMock = {
            getCurrentVersion: jest.fn().mockResolvedValue(opts.credentialVersion ?? null),
        };
        const resolver = new TenantAwareRuntimeResolver(
            registry,
            configRepo as unknown as Repository<TenantJobRuntimeConfig>,
            credentialVersionService as unknown as CredentialVersionService,
        );
        return { resolver, registry, configRepo, credentialVersionService };
    }

    describe('resolve(tenantId)', () => {
        it('returns the instance default when tenantId is null (no DB hit)', async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, configRepo } = buildResolver({ registry });

            await expect(resolver.resolve(null)).resolves.toBe(provider);
            // Pre-tenancy code path is byte-identical — no DB read at all.
            expect(configRepo.findOne).not.toHaveBeenCalled();
        });

        it('returns the instance default when tenantId is undefined (no DB hit)', async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, configRepo } = buildResolver({ registry });

            await expect(resolver.resolve(undefined)).resolves.toBe(provider);
            expect(configRepo.findOne).not.toHaveBeenCalled();
        });

        it('returns the instance default when the tenant has no overlay row (T23 fallback)', async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, configRepo } = buildResolver({
                registry,
                repoFindOneReturn: null,
            });

            await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
            expect(configRepo.findOne).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
        });

        it("returns the instance default when overlay row mode = 'inherit' (T23 fallback)", async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({ mode: 'inherit', credentialsSecretRef: null }),
            });

            await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
        });

        it("returns the instance default when overlay row mode = 'byo' + enabled (P3 stopgap), and logs the deferral", async () => {
            const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
            try {
                const provider = mockProvider({ which: 'instance-default' });
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(provider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
                expect(debugSpy).toHaveBeenCalledTimes(1);
                const message = debugSpy.mock.calls[0][0] as string;
                expect(message).toContain('tenant tenant-1 overlay mode=byo');
                expect(message).toContain('tenant override deferred to P3.1');
            } finally {
                debugSpy.mockRestore();
            }
        });

        it("returns the instance default when overlay row mode = 'override' + enabled (P3 stopgap), and logs the deferral", async () => {
            const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
            try {
                const provider = mockProvider({ which: 'instance-default' });
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(provider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({
                        mode: 'override',
                        enabled: true,
                        providerId: 'temporal',
                    }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
                expect(debugSpy).toHaveBeenCalledTimes(1);
                const message = debugSpy.mock.calls[0][0] as string;
                expect(message).toContain('overlay mode=override');
                expect(message).toContain('providerId=temporal');
            } finally {
                debugSpy.mockRestore();
            }
        });

        it("returns the instance default when overlay row enabled = false (kill switch, even with mode = 'byo')", async () => {
            // Soft kill switch behaves exactly like inherit so the operator
            // can quickly fall back without dropping the credential pointer.
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
            try {
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: false }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
                // Kill switch is silent — no "deferred to P3.1" log because
                // the resolver short-circuits before the byo/override branch.
                expect(debugSpy).not.toHaveBeenCalled();
            } finally {
                debugSpy.mockRestore();
            }
        });

        it('returns null when no provider is registered (preserves EW-683 in-process dev fallback)', async () => {
            // The whole point of `getActive(): IJobRuntimeProvider | null`
            // returning null is so the API's existing in-process fallback
            // kicks in. The resolver MUST surface that null through to the
            // caller, not swallow it.
            const registry = new InMemoryJobRuntimeProviderRegistry();
            const { resolver } = buildResolver({ registry });

            await expect(resolver.resolve('tenant-1')).resolves.toBeNull();
            await expect(resolver.resolve(null)).resolves.toBeNull();
        });
    });

    describe('getEffectiveBinding(tenantId)', () => {
        it("returns mode='inherit' + credentialVersion=null when tenantId is null (no DB hit)", async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, configRepo, credentialVersionService } = buildResolver({ registry });

            await expect(resolver.getEffectiveBinding(null)).resolves.toEqual({
                provider,
                mode: 'inherit',
                credentialVersion: null,
            });
            expect(configRepo.findOne).not.toHaveBeenCalled();
            expect(credentialVersionService.getCurrentVersion).not.toHaveBeenCalled();
        });

        it("returns mode='inherit' + credentialVersion=null when the overlay row is in inherit mode", async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, credentialVersionService } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({ mode: 'inherit', credentialsSecretRef: null }),
            });

            await expect(resolver.getEffectiveBinding('tenant-1')).resolves.toEqual({
                provider,
                mode: 'inherit',
                credentialVersion: null,
            });
            // Version lookup is skipped on inherit — it's a meaningless
            // call for the platform-default credentials (P1 semantic).
            expect(credentialVersionService.getCurrentVersion).not.toHaveBeenCalled();
        });

        it("returns mode='tenant-override' + credentialVersion from the service when overlay row is byo + enabled", async () => {
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, credentialVersionService } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                credentialVersion: 42,
            });

            await expect(resolver.getEffectiveBinding('tenant-1')).resolves.toEqual({
                provider,
                mode: 'tenant-override',
                credentialVersion: 42,
            });
            expect(credentialVersionService.getCurrentVersion).toHaveBeenCalledWith('tenant-1');
        });
    });

    describe('robustness', () => {
        it('does not throw when the repository returns null for an unknown tenant', async () => {
            // Explicit no-throw guarantee: the resolver MUST treat a
            // missing overlay row as "use the instance default" rather
            // than surfacing a 500. Test sibling to the no-row T23
            // fallback case above — that one proves the return value,
            // this one pins the no-throw promise so a future refactor
            // (e.g. switching to `findOneOrFail`) can't silently regress.
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(mockProvider({ which: 'instance-default' }));
            const { resolver } = buildResolver({ registry, repoFindOneReturn: null });

            await expect(resolver.resolve('unknown-tenant')).resolves.not.toThrow;
            await expect(resolver.getEffectiveBinding('unknown-tenant')).resolves.toMatchObject({
                mode: 'inherit',
                credentialVersion: null,
            });
        });
    });
});
