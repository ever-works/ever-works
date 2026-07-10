import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import { RuntimeBindingStamperService } from '../runtime-binding-stamper.service';

/**
 * EW-742 P3.1 / T22 — extra-coverage deep cases beyond the 9-case
 * baseline `runtime-binding-stamper.service.spec.ts`.
 *
 *   - 100 concurrent stamp() calls for distinct tenants — no cross-talk;
 *   - 100 concurrent stamp() calls for the same tenant — all return the
 *     same row's `(providerId, credentialVersion)`;
 *   - stamp() with mode === 'override' returns the row's data;
 *   - stamp() on a row where `enabled` is missing/falsy variants → null/null;
 *   - stamp() reads ONLY the 5 columns it needs (no over-fetch — pins the
 *     `select:` hint in the source);
 *   - stamp() emits no warn on a normal happy path;
 *   - stamp() with a thrown non-Error (string / number) still fails-open
 *     and warns;
 *   - stamp() with a thrown error whose message is empty — warn still
 *     emitted (no crash on missing message).
 */
describe('RuntimeBindingStamperService — deep edge cases (EW-742 P3.1 / T22)', () => {
    function buildConfigRow(
        overrides: Partial<TenantJobRuntimeConfig> = {},
    ): TenantJobRuntimeConfig {
        const now = new Date('2026-06-20T12:00:00.000Z');
        return {
            tenantId: randomUUID(),
            providerId: 'trigger',
            credentialsSecretRef: 'inline:eyJhY2Nlc3NUb2tlbiI6InRyIn0=',
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

    function buildStamper(
        opts: {
            repoFindOneImpl?: jest.Mock;
            repoFindOneReturn?: TenantJobRuntimeConfig | null;
            repoFindOneThrows?: unknown;
        } = {},
    ): { stamper: RuntimeBindingStamperService; configRepo: ConfigRepoMock } {
        const configRepo: ConfigRepoMock = {
            findOne:
                opts.repoFindOneImpl ??
                (opts.repoFindOneThrows !== undefined
                    ? jest.fn().mockRejectedValue(opts.repoFindOneThrows)
                    : jest.fn().mockResolvedValue(opts.repoFindOneReturn ?? null)),
        };
        const stamper = new RuntimeBindingStamperService(
            configRepo as unknown as Repository<TenantJobRuntimeConfig>,
        );
        return { stamper, configRepo };
    }

    describe('happy-path output shape', () => {
        it('returns row providerId + credentialVersion for byo + enabled', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    providerId: 'temporal',
                    credentialVersion: 33,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: 'temporal',
                credentialVersion: 33,
            });
        });

        it('returns row providerId + credentialVersion for override + enabled', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'override',
                    providerId: 'bullmq',
                    credentialVersion: 5,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: 'bullmq',
                credentialVersion: 5,
            });
        });

        it('emits NO warn on a successful stamp (no log noise per call)', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const tenantId = randomUUID();
                const { stamper } = buildStamper({
                    repoFindOneReturn: buildConfigRow({
                        tenantId,
                        mode: 'byo',
                        enabled: true,
                    }),
                });
                await stamper.stamp(tenantId);
                expect(warnSpy).not.toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('reads ONLY the 5 columns it needs (pins the select: hint)', async () => {
            const tenantId = randomUUID();
            const { stamper, configRepo } = buildStamper({
                repoFindOneReturn: buildConfigRow({ tenantId, mode: 'byo', enabled: true }),
            });
            await stamper.stamp(tenantId);
            // The repo lookup uses `select:` to read exactly these 5.
            expect(configRepo.findOne).toHaveBeenCalledWith({
                where: { tenantId },
                select: ['tenantId', 'providerId', 'credentialVersion', 'mode', 'enabled'],
            });
        });
    });

    describe('null/null short-circuits', () => {
        it.each([
            ['null tenant', null],
            ['undefined tenant', undefined],
            ['empty string tenant', ''],
        ])('returns null/null without touching repo for %s', async (_label, value) => {
            const { stamper, configRepo } = buildStamper();
            const result = await stamper.stamp(value as string | null | undefined);
            expect(result).toEqual({ providerId: null, credentialVersion: null });
            expect(configRepo.findOne).not.toHaveBeenCalled();
        });

        it('returns null/null for inherit + enabled', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'inherit',
                    enabled: true,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: null,
                credentialVersion: null,
            });
        });

        it('returns null/null for inherit + disabled (double-falsy)', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'inherit',
                    enabled: false,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: null,
                credentialVersion: null,
            });
        });

        it('returns null/null for byo + disabled (kill switch)', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    enabled: false,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: null,
                credentialVersion: null,
            });
        });

        it('returns null/null for override + disabled (kill switch)', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'override',
                    enabled: false,
                }),
            });
            await expect(stamper.stamp(tenantId)).resolves.toEqual({
                providerId: null,
                credentialVersion: null,
            });
        });
    });

    describe('fail-open semantics', () => {
        it('warns + null/null when repository throws a string (non-Error)', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const tenantId = randomUUID();
                const { stamper } = buildStamper({
                    repoFindOneThrows: 'bare-string-rejection',
                });
                await expect(stamper.stamp(tenantId)).resolves.toEqual({
                    providerId: null,
                    credentialVersion: null,
                });
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0]?.[0]).toMatch(/bare-string-rejection/);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('warns + null/null when repository throws an Error with empty message', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const tenantId = randomUUID();
                const { stamper } = buildStamper({
                    repoFindOneThrows: new Error(''),
                });
                await expect(stamper.stamp(tenantId)).resolves.toEqual({
                    providerId: null,
                    credentialVersion: null,
                });
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0]?.[0]).toMatch(/overlay lookup failed/);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('warns + null/null when repository throws a number', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const tenantId = randomUUID();
                const { stamper } = buildStamper({
                    repoFindOneThrows: 12345,
                });
                await expect(stamper.stamp(tenantId)).resolves.toEqual({
                    providerId: null,
                    credentialVersion: null,
                });
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0]?.[0]).toMatch(/12345/);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('includes the tenantId in the warn message for operator-side correlation', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const tenantId = randomUUID();
                const { stamper } = buildStamper({
                    repoFindOneThrows: new Error('connection reset by peer'),
                });
                await stamper.stamp(tenantId);
                expect(warnSpy.mock.calls[0]?.[0]).toContain(tenantId);
                expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fail-open|instance default/);
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe('concurrency invariants', () => {
        it("100 concurrent stamps for distinct tenants return each tenant's OWN row data", async () => {
            const rows = new Map<string, TenantJobRuntimeConfig>();
            for (let i = 0; i < 100; i++) {
                const tenantId = randomUUID();
                rows.set(
                    tenantId,
                    buildConfigRow({
                        tenantId,
                        providerId: i % 2 === 0 ? 'trigger' : 'temporal',
                        credentialVersion: i,
                        mode: 'byo',
                        enabled: true,
                    }),
                );
            }
            const repoFindOneImpl = jest.fn(
                async ({ where }: { where: { tenantId: string } }) =>
                    rows.get(where.tenantId) ?? null,
            );
            const { stamper } = buildStamper({ repoFindOneImpl });

            const tenantIds = Array.from(rows.keys());
            const results = await Promise.all(tenantIds.map((t) => stamper.stamp(t)));

            results.forEach((r, idx) => {
                const tenantId = tenantIds[idx];
                const row = rows.get(tenantId)!;
                expect(r).toEqual({
                    providerId: row.providerId,
                    credentialVersion: row.credentialVersion,
                });
            });
        });

        it('100 concurrent stamps for the SAME tenant return identical row data', async () => {
            const tenantId = randomUUID();
            const { stamper } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    providerId: 'pgboss',
                    credentialVersion: 11,
                }),
            });
            const results = await Promise.all(
                Array.from({ length: 100 }, () => stamper.stamp(tenantId)),
            );
            results.forEach((r) => {
                expect(r).toEqual({ providerId: 'pgboss', credentialVersion: 11 });
            });
        });

        it('mixed-tenant fan-out with one failing tenant does NOT poison the others', async () => {
            const goodTenant = randomUUID();
            const badTenant = randomUUID();
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            try {
                const repoFindOneImpl = jest.fn(
                    async ({ where }: { where: { tenantId: string } }) => {
                        if (where.tenantId === badTenant) {
                            throw new Error('row corruption for bad tenant');
                        }
                        return buildConfigRow({
                            tenantId: where.tenantId,
                            mode: 'byo',
                            enabled: true,
                            credentialVersion: 9,
                        });
                    },
                );
                const { stamper } = buildStamper({ repoFindOneImpl });

                const [goodResult, badResult, goodAgain] = await Promise.all([
                    stamper.stamp(goodTenant),
                    stamper.stamp(badTenant),
                    stamper.stamp(goodTenant),
                ]);

                expect(goodResult).toEqual({ providerId: 'trigger', credentialVersion: 9 });
                expect(goodAgain).toEqual({ providerId: 'trigger', credentialVersion: 9 });
                expect(badResult).toEqual({ providerId: null, credentialVersion: null });
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe('no caching — every stamp hits the repo', () => {
        it('20 sequential stamps for the same tenant call findOne 20 times', async () => {
            // The stamper is deliberately NOT cached (the T21 cache lives
            // in the resolver path; the stamper is a metadata write
            // helper and the row read on every enqueue is the source of
            // truth for `credentialVersion`). Pin that contract.
            const tenantId = randomUUID();
            const { stamper, configRepo } = buildStamper({
                repoFindOneReturn: buildConfigRow({
                    tenantId,
                    mode: 'byo',
                    enabled: true,
                    credentialVersion: 2,
                }),
            });
            for (let i = 0; i < 20; i++) {
                await stamper.stamp(tenantId);
            }
            expect(configRepo.findOne).toHaveBeenCalledTimes(20);
        });
    });
});
