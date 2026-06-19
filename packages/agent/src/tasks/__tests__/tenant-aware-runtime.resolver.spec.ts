import type { IJobRuntimeProvider, JobRuntimeDispatchers } from '@ever-works/plugin';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { CredentialVersionService } from '../credential-version.service';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import { InMemoryJobRuntimeProviderRegistry } from '../job-runtime.providers';
import type { SecretStoreResolver } from '../secret-store-resolver.interface';
import { TenantCredentialCache } from '../tenant-credential.cache';
import { TenantAwareRuntimeResolver } from '../tenant-aware-runtime.resolver';

/**
 * EW-742 P3 / EW-747 (T24) + P3.2 — tenant-aware resolver unit tests.
 *
 * Covers:
 *
 *   - null / undefined / no-row / inherit / disabled → instance default
 *     (T23 fallback, plus the kill switch path);
 *   - byo + override modes with `enabled = true`:
 *     - happy path: resolver builds the snapshot, calls
 *       `provider.bindToTenant()`, caches the binding, returns the
 *       bound provider;
 *     - fallback 1: provider doesn't expose `bindToTenant?` →
 *       instance default + `Logger.warn`;
 *     - fallback 2: `SecretStoreResolver.resolve` returns `null` →
 *       instance default + `Logger.warn`;
 *     - fallback 3: `provider.bindToTenant` returns `undefined` →
 *       instance default + `Logger.warn`;
 *     - fallback 4: throws anywhere → instance default + `Logger.warn`
 *       (defence-in-depth, contract says implementations don't throw);
 *     - cache hit: second resolve for the same
 *       `(tenantId, providerId, credentialVersion)` skips the secret
 *       store + bind call entirely;
 *   - `getEffectiveBinding` returns the metadata T22 / stamper uses;
 *   - `registry.getActive()` returning `null` propagates as `null` (the
 *     EW-683 in-process dev fallback semantic — preserved).
 */
describe('TenantAwareRuntimeResolver (EW-742 P3 / EW-747 T20 + T23 + T24 + P3.2)', () => {
    /**
     * Build a minimal {@link IJobRuntimeProvider} test double. We only
     * exercise identity here — the resolver hands the registry's
     * provider back as-is (or the bound result of `bindToTenant`) — so
     * the `dispatchers` payload is just a sentinel string keyed by
     * `which`.
     *
     * `bindToTenant` is optional in the type; pass it explicitly when a
     * test needs to exercise the new P3.2 bind path.
     */
    function mockProvider(
        dispatchers: JobRuntimeDispatchers = { sentinel: 'instance-default' },
        bindToTenant?: IJobRuntimeProvider['bindToTenant'],
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
            bindToTenant,
        } satisfies IJobRuntimeProvider;
    }

    function buildConfigRow(
        overrides: Partial<TenantJobRuntimeConfig> = {},
    ): TenantJobRuntimeConfig {
        const now = new Date('2026-06-18T12:00:00.000Z');
        return {
            tenantId: 'tenant-1',
            providerId: 'trigger',
            credentialsSecretRef: 'inline:eyJhY2Nlc3NUb2tlbiI6InRyX2Rldl94eHgifQ==',
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

    type SecretStoreResolverMock = SecretStoreResolver & {
        resolve: jest.Mock;
    };

    function buildResolver(
        opts: {
            registry?: InMemoryJobRuntimeProviderRegistry;
            repoFindOneReturn?: TenantJobRuntimeConfig | null;
            credentialVersion?: number | null;
            secretStoreResolve?: Record<string, unknown> | null;
            secretStoreThrows?: Error;
            cache?: TenantCredentialCache;
        } = {},
    ): {
        resolver: TenantAwareRuntimeResolver;
        registry: InMemoryJobRuntimeProviderRegistry;
        configRepo: ConfigRepoMock;
        credentialVersionService: CredentialVersionServiceMock;
        secretStoreResolver: SecretStoreResolverMock;
        cache: TenantCredentialCache;
    } {
        const registry = opts.registry ?? new InMemoryJobRuntimeProviderRegistry();
        const configRepo: ConfigRepoMock = {
            findOne: jest.fn().mockResolvedValue(opts.repoFindOneReturn ?? null),
        };
        const credentialVersionService: CredentialVersionServiceMock = {
            getCurrentVersion: jest.fn().mockResolvedValue(opts.credentialVersion ?? null),
        };
        const secretStoreResolver: SecretStoreResolverMock = {
            resolve: opts.secretStoreThrows
                ? jest.fn().mockRejectedValue(opts.secretStoreThrows)
                : jest
                      .fn()
                      .mockResolvedValue(
                          'secretStoreResolve' in opts
                              ? opts.secretStoreResolve
                              : { accessToken: 'tr_dev_xxx' },
                      ),
        };
        const cache = opts.cache ?? new TenantCredentialCache();
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
            credentialVersionService,
            secretStoreResolver,
            cache,
        };
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

        it('returns the instance default + warn when byo + enabled but provider has no bindToTenant', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                // mockProvider() with no bindToTenant arg ⇒ undefined
                const provider = mockProvider({ which: 'instance-default' });
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(provider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0]?.[0]).toMatch(/does not implement bindToTenant/);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('returns the bound provider when byo + enabled and bindToTenant is wired (happy path)', async () => {
            const boundProvider = mockProvider({ which: 'tenant-bound' });
            const bindToTenant = jest.fn().mockReturnValue(boundProvider);
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(instanceProvider);
            const { resolver, secretStoreResolver, cache } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({
                    mode: 'byo',
                    enabled: true,
                    providerId: 'trigger',
                    credentialVersion: 7,
                }),
                secretStoreResolve: { accessToken: 'tr_dev_xxx' },
            });

            const result = await resolver.resolve('tenant-1');
            expect(result).toBe(boundProvider);
            expect(secretStoreResolver.resolve).toHaveBeenCalledWith(
                'inline:eyJhY2Nlc3NUb2tlbiI6InRyX2Rldl94eHgifQ==',
            );
            expect(bindToTenant).toHaveBeenCalledWith({
                tenantId: 'tenant-1',
                providerId: 'trigger',
                credentialVersion: 7,
                credentials: { accessToken: 'tr_dev_xxx' },
            });
            // Cache is populated against (tenantId, providerId, version)
            // for the next call to skip the secret resolution + bind.
            expect(cache.get('tenant-1', 'trigger', 7)).toBe(boundProvider);
        });

        it('hits the cache on a repeat resolve for the same (tenantId, providerId, credentialVersion)', async () => {
            const boundProvider = mockProvider({ which: 'tenant-bound' });
            const bindToTenant = jest.fn().mockReturnValue(boundProvider);
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(instanceProvider);
            const { resolver, secretStoreResolver } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
            });

            await resolver.resolve('tenant-1');
            await resolver.resolve('tenant-1');

            // First call resolves + binds; second call short-circuits
            // on cache hit. Both calls still read the DB row (the cache
            // is keyed by version, which the row carries).
            expect(secretStoreResolver.resolve).toHaveBeenCalledTimes(1);
            expect(bindToTenant).toHaveBeenCalledTimes(1);
        });

        it('falls back to instance default + warn when SecretStoreResolver returns null', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn();
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(instanceProvider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                    secretStoreResolve: null,
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(instanceProvider);
                expect(bindToTenant).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringMatching(/SecretStoreResolver returned null/),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('falls back to instance default + warn when SecretStoreResolver throws', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn();
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(instanceProvider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                    secretStoreThrows: new Error('vault timeout'),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(instanceProvider);
                expect(bindToTenant).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringMatching(/SecretStoreResolver threw.*vault timeout/),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('falls back to instance default + warn when bindToTenant returns undefined', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn().mockReturnValue(undefined);
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(instanceProvider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(instanceProvider);
                expect(bindToTenant).toHaveBeenCalledTimes(1);
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringMatching(/bindToTenant returned undefined/),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('falls back to instance default + warn when bindToTenant throws', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn().mockImplementation(() => {
                    throw new Error('provider misconfigured');
                });
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(instanceProvider);
                const { resolver } = buildResolver({
                    registry,
                    repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: true }),
                });

                await expect(resolver.resolve('tenant-1')).resolves.toBe(instanceProvider);
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringMatching(/bindToTenant threw.*provider misconfigured/),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("returns the instance default when overlay row enabled = false (kill switch, even with mode = 'byo')", async () => {
            // Soft kill switch behaves exactly like inherit so the operator
            // can quickly fall back without dropping the credential pointer.
            const provider = mockProvider({ which: 'instance-default' });
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(provider);
            const { resolver, secretStoreResolver } = buildResolver({
                registry,
                repoFindOneReturn: buildConfigRow({ mode: 'byo', enabled: false }),
            });

            await expect(resolver.resolve('tenant-1')).resolves.toBe(provider);
            // Kill switch short-circuits BEFORE the bind path — neither
            // the resolver nor bindToTenant should be called.
            expect(secretStoreResolver.resolve).not.toHaveBeenCalled();
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
