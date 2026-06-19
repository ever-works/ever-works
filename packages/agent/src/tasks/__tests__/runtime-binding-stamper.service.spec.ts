import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';
import { RuntimeBindingStamperService } from '../runtime-binding-stamper.service';

/**
 * EW-742 P3.1 / T22 — enqueue-site `credentialVersion` capture helper.
 *
 * Covers the six branches the helper supports:
 *   - null tenant → `{ null, null }` without touching the repo;
 *   - no overlay row → `{ null, null }`;
 *   - inherit mode → `{ null, null }`;
 *   - disabled overlay → `{ null, null }`;
 *   - byo + override + enabled → row's `(providerId, credentialVersion)`;
 *   - repository throws → `{ null, null }` + `Logger.warn` (fail-open).
 *
 * Mirrors the pattern in `tenant-aware-runtime.resolver.spec.ts` for the
 * adjacent resolver — same row shape, same mock style — so the two
 * services stay legible side-by-side as the dispatcher wiring (the
 * per-call-site adoption of `await stamper.stamp(...)`) lands one at a
 * time on top.
 */
describe('RuntimeBindingStamperService (EW-742 P3.1 / T22)', () => {
    function buildConfigRow(
        overrides: Partial<TenantJobRuntimeConfig> = {},
    ): TenantJobRuntimeConfig {
        const now = new Date('2026-06-19T12:00:00.000Z');
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

    function buildStamper(
        opts: {
            repoFindOneReturn?: TenantJobRuntimeConfig | null;
            repoFindOneThrows?: Error;
        } = {},
    ): { stamper: RuntimeBindingStamperService; configRepo: ConfigRepoMock } {
        const configRepo: ConfigRepoMock = {
            findOne: opts.repoFindOneThrows
                ? jest.fn().mockRejectedValue(opts.repoFindOneThrows)
                : jest.fn().mockResolvedValue(opts.repoFindOneReturn ?? null),
        };
        const stamper = new RuntimeBindingStamperService(
            configRepo as unknown as Repository<TenantJobRuntimeConfig>,
        );
        return { stamper, configRepo };
    }

    it('returns null/null without touching the repo for null tenant', async () => {
        const { stamper, configRepo } = buildStamper();
        const result = await stamper.stamp(null);
        expect(result).toEqual({ providerId: null, credentialVersion: null });
        expect(configRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns null/null without touching the repo for undefined tenant', async () => {
        const { stamper, configRepo } = buildStamper();
        const result = await stamper.stamp(undefined);
        expect(result).toEqual({ providerId: null, credentialVersion: null });
        expect(configRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns null/null when no overlay row exists', async () => {
        const { stamper, configRepo } = buildStamper({ repoFindOneReturn: null });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: null, credentialVersion: null });
        expect(configRepo.findOne).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1' },
            select: ['tenantId', 'providerId', 'credentialVersion', 'mode', 'enabled'],
        });
    });

    it('returns null/null when overlay mode is inherit', async () => {
        const { stamper } = buildStamper({
            repoFindOneReturn: buildConfigRow({ mode: 'inherit' }),
        });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: null, credentialVersion: null });
    });

    it('returns null/null when overlay row is disabled (soft kill switch)', async () => {
        const { stamper } = buildStamper({
            repoFindOneReturn: buildConfigRow({ enabled: false }),
        });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: null, credentialVersion: null });
    });

    it('returns row providerId + credentialVersion for byo + enabled', async () => {
        const { stamper } = buildStamper({
            repoFindOneReturn: buildConfigRow({
                mode: 'byo',
                providerId: 'temporal',
                credentialVersion: 12,
            }),
        });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: 'temporal', credentialVersion: 12 });
    });

    it('returns row providerId + credentialVersion for override + enabled', async () => {
        const { stamper } = buildStamper({
            repoFindOneReturn: buildConfigRow({
                mode: 'override',
                providerId: 'pgboss',
                credentialVersion: 3,
            }),
        });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: 'pgboss', credentialVersion: 3 });
    });

    it('fails open with null/null + Logger.warn when the repo throws', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { stamper } = buildStamper({
            repoFindOneThrows: new Error('connection terminated'),
        });
        const result = await stamper.stamp('tenant-1');
        expect(result).toEqual({ providerId: null, credentialVersion: null });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/overlay lookup failed/);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/connection terminated/);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fail-open/);
        warnSpy.mockRestore();
    });
});
