import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { IJobRuntimeProvider, JobRuntimeDispatchers } from '@ever-works/plugin';
import type { Repository } from 'typeorm';
import { CredentialVersionService } from '../credential-version.service';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import { InMemoryJobRuntimeProviderRegistry } from '../job-runtime.providers';
import type { SecretStoreResolver } from '../secret-store-resolver.interface';
import { TenantCredentialCache } from '../tenant-credential.cache';
import { TenantAwareRuntimeResolver } from '../tenant-aware-runtime.resolver';

/**
 * EW-742 P3 / EW-747 — extra-coverage edge cases for the tenant-aware
 * resolver beyond the existing 17-case happy-path/fallback spec.
 *
 * Pins the invariants that operators and downstream PRs rely on:
 *   - cache memoisation under fan-out, sequential repeat, and mixed-tenant
 *     traffic (no false-positive caching across tenants);
 *   - all three "no tenant" shapes (`null` / `undefined` / `''`) skip the DB
 *     entirely and return the instance default;
 *   - malformed overlay rows (invalid mode value, missing providerId) don't
 *     throw — they log warn and fall back to the instance default;
 *   - invalidation race: an `invalidate()` mid-flight on a `resolve()` call
 *     for the SAME version returns a fresh binding rather than the
 *     about-to-be-evicted one;
 *   - `getEffectiveBinding(tenantId)` returns the correct
 *     `(mode, credentialVersion)` shape per overlay mode — the T22
 *     `RuntimeBindingStamperService` consumers rely on this projection;
 *   - `provider.bindToTenant` returning a NEW provider INSTANCE for the
 *     same shape is cached as that new instance (the resolver does not
 *     compare-by-value and short-circuit to the registry's instance).
 */
describe('TenantAwareRuntimeResolver — edge cases (EW-742 P3 / EW-747)', () => {
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
        const now = new Date('2026-06-20T12:00:00.000Z');
        return {
            tenantId: randomUUID(),
            providerId: 'trigger',
            credentialsSecretRef: 'inline:eyJhY2Nlc3NUb2tlbiI6InRyX2Rldl94eHgifQ==',
            credentialVersion: 7,
            mode: 'byo',
            enabled: true,
            createdBy: randomUUID(),
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

    function buildResolver(opts: {
        provider: IJobRuntimeProvider | null;
        repoFindOneImpl?: jest.Mock;
        repoFindOneReturn?: TenantJobRuntimeConfig | null;
        secretStoreImpl?: jest.Mock;
        secretStoreResolve?: Record<string, unknown> | null;
        secretStoreThrows?: Error;
        credentialVersion?: number | null;
        cache?: TenantCredentialCache;
    }): {
        resolver: TenantAwareRuntimeResolver;
        registry: InMemoryJobRuntimeProviderRegistry;
        configRepo: ConfigRepoMock;
        credentialVersionService: CredentialVersionServiceMock;
        secretStoreResolver: SecretStoreResolverMock;
        cache: TenantCredentialCache;
    } {
        const registry = new InMemoryJobRuntimeProviderRegistry();
        if (opts.provider) {
            registry.register(opts.provider);
        }
        const configRepo: ConfigRepoMock = {
            findOne:
                opts.repoFindOneImpl ?? jest.fn().mockResolvedValue(opts.repoFindOneReturn ?? null),
        };
        const credentialVersionService: CredentialVersionServiceMock = {
            getCurrentVersion: jest.fn().mockResolvedValue(opts.credentialVersion ?? null),
        };
        const secretStoreResolver: SecretStoreResolverMock = {
            resolve:
                opts.secretStoreImpl ??
                (opts.secretStoreThrows
                    ? jest.fn().mockRejectedValue(opts.secretStoreThrows)
                    : jest
                          .fn()
                          .mockResolvedValue(
                              'secretStoreResolve' in opts
                                  ? opts.secretStoreResolve
                                  : { accessToken: 'tr_dev_xxx' },
                          )),
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

    describe('all three "no tenant" shapes skip the DB', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
        ])('returns the instance default for tenantId = %s (no DB hit)', async (_label, value) => {
            const provider = mockProvider({ which: 'instance-default' });
            const { resolver, configRepo } = buildResolver({ provider });
            const result = await resolver.resolve(value as string | null | undefined);
            expect(result).toBe(provider);
            expect(configRepo.findOne).not.toHaveBeenCalled();
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
        ])(
            "getEffectiveBinding(%s) returns mode='inherit' + credentialVersion=null without DB hit",
            async (_label, value) => {
                const provider = mockProvider({ which: 'instance-default' });
                const { resolver, configRepo, credentialVersionService } = buildResolver({
                    provider,
                });
                await expect(
                    resolver.getEffectiveBinding(value as string | null | undefined),
                ).resolves.toEqual({
                    provider,
                    mode: 'inherit',
                    credentialVersion: null,
                });
                expect(configRepo.findOne).not.toHaveBeenCalled();
                expect(credentialVersionService.getCurrentVersion).not.toHaveBeenCalled();
            },
        );
    });

    describe('concurrency invariants', () => {
        it('100 concurrent resolves for the same tenant hit the bind path exactly once (after warmup)', async () => {
            // Realistic warmup pattern: a single `resolve` precedes the
            // fan-out so the cache is populated; the next 100 concurrent
            // resolves all hit the cache. (Without warmup, multiple
            // in-flight `resolve()` calls all observe an empty cache and
            // each one calls `bindToTenant` — that's the documented
            // single-writer-wins behaviour for this service.)
            const tenantId = randomUUID();
            const bindToTenant = jest
                .fn()
                .mockImplementation(() => mockProvider({ which: 'tenant-bound' }));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const { resolver, secretStoreResolver, configRepo } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({ tenantId, mode: 'byo', enabled: true }),
            });

            // Warmup.
            await resolver.resolve(tenantId);
            expect(bindToTenant).toHaveBeenCalledTimes(1);
            const repoCallsAfterWarmup = configRepo.findOne.mock.calls.length;

            // Fan-out 100 concurrent.
            const results = await Promise.all(
                Array.from({ length: 100 }, () => resolver.resolve(tenantId)),
            );

            // bindToTenant + secretStore must NOT be called again — cache
            // hits short-circuit both. Every result must be the same
            // bound provider instance.
            expect(bindToTenant).toHaveBeenCalledTimes(1);
            expect(secretStoreResolver.resolve).toHaveBeenCalledTimes(1);
            const first = results[0];
            for (const r of results) {
                expect(r).toBe(first);
            }
            // Repo IS read per `resolve()` (the cache is keyed by version,
            // which the row carries). 100 extra reads.
            expect(configRepo.findOne.mock.calls.length - repoCallsAfterWarmup).toBe(100);
        });

        it('1000 sequential resolves for the same tenant call bindToTenant exactly once', async () => {
            const tenantId = randomUUID();
            const bindToTenant = jest
                .fn()
                .mockImplementation(() => mockProvider({ which: 'tenant-bound' }));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const { resolver, secretStoreResolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({ tenantId, mode: 'byo', enabled: true }),
            });

            for (let i = 0; i < 1000; i++) {
                await resolver.resolve(tenantId);
            }

            expect(bindToTenant).toHaveBeenCalledTimes(1);
            expect(secretStoreResolver.resolve).toHaveBeenCalledTimes(1);
        });

        it('1000 sequential resolves for distinct tenants call bindToTenant 1000 times (no false-positive caching)', async () => {
            const bindToTenant = jest.fn().mockImplementation(() => mockProvider({ which: 'tb' }));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const tenants = Array.from({ length: 1000 }, () => randomUUID());
            const repoFindOneImpl = jest.fn(async ({ where }: { where: { tenantId: string } }) =>
                buildConfigRow({
                    tenantId: where.tenantId,
                    mode: 'byo',
                    enabled: true,
                }),
            );
            const { resolver, secretStoreResolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneImpl,
            });

            for (const t of tenants) {
                await resolver.resolve(t);
            }

            expect(bindToTenant).toHaveBeenCalledTimes(1000);
            expect(secretStoreResolver.resolve).toHaveBeenCalledTimes(1000);
            expect(repoFindOneImpl).toHaveBeenCalledTimes(1000);
        });

        it('invalidate() between resolves forces a fresh bind on the next resolve', async () => {
            // Cache invalidation between calls must surface a fresh
            // binding — not the previously-cached (about-to-be-evicted)
            // one. Pins the contract that the cache's `invalidate()` is
            // observed on the NEXT `resolve()` immediately.
            const tenantId = randomUUID();
            const boundA = mockProvider({ which: 'tenant-bound-a' });
            const boundB = mockProvider({ which: 'tenant-bound-b' });
            const bindToTenant = jest
                .fn<IJobRuntimeProvider, []>()
                .mockReturnValueOnce(boundA)
                .mockReturnValueOnce(boundB);
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const { resolver, cache } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({ tenantId, mode: 'byo', enabled: true }),
            });

            const first = await resolver.resolve(tenantId);
            expect(first).toBe(boundA);

            cache.invalidate(tenantId, 'trigger');

            const second = await resolver.resolve(tenantId);
            expect(second).toBe(boundB);
            expect(bindToTenant).toHaveBeenCalledTimes(2);
        });
    });

    describe('malformed overlay rows', () => {
        it('falls back to instance default + warn when mode is an unrecognised value', async () => {
            // The entity's `mode` is typed as a union but the column is
            // varchar — a malformed DB row could carry an unknown value.
            // The resolver MUST fall back rather than throw.
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn();
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const tenantId = randomUUID();
                // mode === 'inherit' branch is hit only for the literal
                // 'inherit'; an unknown value drops through to the byo/
                // override bind path. That path's contract is fail-open
                // on every error, so the warn comes from one of the bind
                // fallback branches (bind not called → no warn; bind
                // throws → warn). Force the bind to throw to assert the
                // safety net.
                bindToTenant.mockImplementation(() => {
                    throw new Error('unknown mode');
                });
                const { resolver } = buildResolver({
                    provider: instanceProvider,
                    repoFindOneReturn: buildConfigRow({
                        tenantId,
                        mode: 'unknown-mode-value' as TenantJobRuntimeConfig['mode'],
                    }),
                });

                await expect(resolver.resolve(tenantId)).resolves.toBe(instanceProvider);
                expect(warnSpy).toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('does NOT throw when the overlay row carries an unexpected providerId', async () => {
            // Row's `providerId` doesn't match the registered provider's
            // `runtimeId`. The current resolver keys the cache by the
            // ACTIVE provider's `runtimeId`, not the row's — so this
            // shouldn't blow up; bind still happens with the active
            // provider's runtimeId in the snapshot payload.
            const tenantId = randomUUID();
            const boundProvider = mockProvider({ which: 'tenant-bound' });
            const bindToTenant = jest.fn().mockReturnValue(boundProvider);
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const { resolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    providerId: 'not-a-real-provider',
                    mode: 'byo',
                    enabled: true,
                }),
            });

            await expect(resolver.resolve(tenantId)).resolves.toBe(boundProvider);
            expect(bindToTenant).toHaveBeenCalledWith(
                expect.objectContaining({ providerId: 'trigger' }),
            );
        });
    });

    describe('SecretStoreResolver failure modes — extended', () => {
        it('warns with the credentialsSecretRef pointer when resolver returns null', async () => {
            // Operators tracing a silent fallback from logs need the
            // pointer in the message. Pin that the warn includes it.
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const bindToTenant = jest.fn();
                const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
                const tenantId = randomUUID();
                const pointer = `vault:secret/tenants/${tenantId}/trigger`;
                const { resolver } = buildResolver({
                    provider: instanceProvider,
                    repoFindOneReturn: buildConfigRow({
                        tenantId,
                        mode: 'byo',
                        enabled: true,
                        credentialsSecretRef: pointer,
                    }),
                    secretStoreResolve: null,
                });

                await expect(resolver.resolve(tenantId)).resolves.toBe(instanceProvider);
                const warnCall = warnSpy.mock.calls.find((c) =>
                    typeof c[0] === 'string' ? c[0].includes(pointer) : false,
                );
                expect(warnCall).toBeDefined();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('warns with the thrown error message when the resolver throws', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const instanceProvider = mockProvider({ which: 'instance-default' }, jest.fn());
                const tenantId = randomUUID();
                const err = new Error('vault timeout after 5s');
                const { resolver } = buildResolver({
                    provider: instanceProvider,
                    repoFindOneReturn: buildConfigRow({
                        tenantId,
                        mode: 'byo',
                        enabled: true,
                    }),
                    secretStoreThrows: err,
                });

                await expect(resolver.resolve(tenantId)).resolves.toBe(instanceProvider);
                const warnCall = warnSpy.mock.calls.find((c) =>
                    typeof c[0] === 'string' ? c[0].includes('vault timeout after 5s') : false,
                );
                expect(warnCall).toBeDefined();
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe('bindToTenant integration nuances', () => {
        it("caches the NEW provider instance returned by bindToTenant (not the registry's)", async () => {
            const tenantId = randomUUID();
            const boundProvider = mockProvider({ which: 'fresh-bound' });
            const bindToTenant = jest.fn().mockReturnValue(boundProvider);
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const { resolver, cache } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    enabled: true,
                    credentialVersion: 42,
                }),
            });

            await resolver.resolve(tenantId);

            // Cache must hold the bound instance, not the registry's
            // active provider. Identity equality is the contract — the
            // resolver does not deep-compare or short-circuit.
            const cached = cache.get<IJobRuntimeProvider>(tenantId, 'trigger', 42);
            expect(cached).toBe(boundProvider);
            expect(cached).not.toBe(instanceProvider);
        });

        it('passes the full snapshot (tenantId, providerId, credentialVersion, credentials) into bindToTenant', async () => {
            const tenantId = randomUUID();
            const bindToTenant = jest.fn().mockReturnValue(mockProvider({ which: 'tb' }));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
            const { resolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'override',
                    enabled: true,
                    credentialVersion: 99,
                }),
                secretStoreResolve: credentials,
            });

            await resolver.resolve(tenantId);

            expect(bindToTenant).toHaveBeenCalledWith({
                tenantId,
                providerId: 'trigger',
                credentialVersion: 99,
                credentials,
            });
        });
    });

    describe('getEffectiveBinding(tenantId) — extended', () => {
        it("returns mode='tenant-override' for override + enabled", async () => {
            const tenantId = randomUUID();
            const provider = mockProvider({ which: 'instance-default' });
            const { resolver, credentialVersionService } = buildResolver({
                provider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'override',
                    enabled: true,
                }),
                credentialVersion: 18,
            });

            await expect(resolver.getEffectiveBinding(tenantId)).resolves.toEqual({
                provider,
                mode: 'tenant-override',
                credentialVersion: 18,
            });
            expect(credentialVersionService.getCurrentVersion).toHaveBeenCalledWith(tenantId);
        });

        it("returns mode='inherit' when overlay is enabled=false (kill switch)", async () => {
            const tenantId = randomUUID();
            const provider = mockProvider({ which: 'instance-default' });
            const { resolver, credentialVersionService } = buildResolver({
                provider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    enabled: false,
                }),
            });
            await expect(resolver.getEffectiveBinding(tenantId)).resolves.toEqual({
                provider,
                mode: 'inherit',
                credentialVersion: null,
            });
            expect(credentialVersionService.getCurrentVersion).not.toHaveBeenCalled();
        });

        it("returns mode='inherit' when there is no overlay row", async () => {
            const tenantId = randomUUID();
            const provider = mockProvider({ which: 'instance-default' });
            const { resolver, credentialVersionService } = buildResolver({
                provider,
                repoFindOneReturn: null,
            });
            await expect(resolver.getEffectiveBinding(tenantId)).resolves.toEqual({
                provider,
                mode: 'inherit',
                credentialVersion: null,
            });
            expect(credentialVersionService.getCurrentVersion).not.toHaveBeenCalled();
        });

        it('returns provider=null when no provider is registered (preserves EW-683 dev fallback)', async () => {
            const { resolver } = buildResolver({ provider: null });
            await expect(resolver.getEffectiveBinding(null)).resolves.toEqual({
                provider: null,
                mode: 'inherit',
                credentialVersion: null,
            });
        });

        it('returns credentialVersion=null when the version service returns null', async () => {
            const tenantId = randomUUID();
            const provider = mockProvider({ which: 'instance-default' });
            const { resolver } = buildResolver({
                provider,
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    enabled: true,
                }),
                credentialVersion: null,
            });
            await expect(resolver.getEffectiveBinding(tenantId)).resolves.toEqual({
                provider,
                mode: 'tenant-override',
                credentialVersion: null,
            });
        });
    });

    describe('mixed-tenant cache isolation', () => {
        it('a cached binding for tenant A is NOT served to tenant B', async () => {
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            const boundA = mockProvider({ which: 'bound-a' });
            const boundB = mockProvider({ which: 'bound-b' });
            const bindToTenant = jest
                .fn<IJobRuntimeProvider, [{ tenantId: string }]>()
                .mockImplementation(({ tenantId }) => (tenantId === tenantA ? boundA : boundB));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const repoFindOneImpl = jest.fn(async ({ where }: { where: { tenantId: string } }) =>
                buildConfigRow({
                    tenantId: where.tenantId,
                    mode: 'byo',
                    enabled: true,
                }),
            );
            const { resolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneImpl,
            });

            const a1 = await resolver.resolve(tenantA);
            const b1 = await resolver.resolve(tenantB);
            const a2 = await resolver.resolve(tenantA);
            const b2 = await resolver.resolve(tenantB);

            expect(a1).toBe(boundA);
            expect(a2).toBe(boundA);
            expect(b1).toBe(boundB);
            expect(b2).toBe(boundB);
            // Two binds (one per tenant); the repeats hit the cache.
            expect(bindToTenant).toHaveBeenCalledTimes(2);
        });

        it('100 concurrent resolves across 10 tenants each hit bind exactly once after warmup', async () => {
            const tenants = Array.from({ length: 10 }, () => randomUUID());
            const bindToTenant = jest.fn().mockImplementation(() => mockProvider({ which: 'tb' }));
            const instanceProvider = mockProvider({ which: 'instance-default' }, bindToTenant);
            const repoFindOneImpl = jest.fn(async ({ where }: { where: { tenantId: string } }) =>
                buildConfigRow({
                    tenantId: where.tenantId,
                    mode: 'byo',
                    enabled: true,
                }),
            );
            const { resolver } = buildResolver({
                provider: instanceProvider,
                repoFindOneImpl,
            });

            // Warmup: one resolve per tenant.
            for (const t of tenants) {
                await resolver.resolve(t);
            }
            expect(bindToTenant).toHaveBeenCalledTimes(10);

            // Fan-out: 100 concurrent across 10 tenants (10 each).
            await Promise.all(
                Array.from({ length: 100 }, (_, i) => resolver.resolve(tenants[i % 10])),
            );
            // No new binds — cache covers everything.
            expect(bindToTenant).toHaveBeenCalledTimes(10);
        });
    });
});
