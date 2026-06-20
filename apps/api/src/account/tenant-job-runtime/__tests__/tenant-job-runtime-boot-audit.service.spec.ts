// EW-752 P5.1 (T35b) — service-level spec for the boot-time writer of
// the `operator_allowlist_boot` audit row. Drives the dedupe loop +
// failure swallow without spinning the full NestJS bootstrap.

jest.mock('@ever-works/agent/entities', () => ({
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import type { TenantJobRuntimeAudit } from '@ever-works/agent/entities';
import { TenantJobRuntimeBootAuditService } from '../tenant-job-runtime-boot-audit.service';
import type { TenantJobRuntimeService } from '../tenant-job-runtime.service';

const PER_TENANT_GATING_ENV = 'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING';
const GLOBAL_ALLOWLIST_ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';

describe('TenantJobRuntimeBootAuditService — boot snapshot dedupe (P5.1 T35b)', () => {
    let bootService: TenantJobRuntimeBootAuditService;
    let serviceMock: jest.Mocked<
        Pick<TenantJobRuntimeService, 'findLatestBootAudit' | 'appendAuditRow'>
    >;

    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

    beforeEach(() => {
        serviceMock = {
            findLatestBootAudit: jest.fn(),
            appendAuditRow: jest.fn(),
        } as any;
        bootService = new TenantJobRuntimeBootAuditService(serviceMock as any);

        // Default env so each test starts from a known operator snapshot.
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
    });

    afterEach(() => {
        if (originalGating === undefined) {
            delete process.env[PER_TENANT_GATING_ENV];
        } else {
            process.env[PER_TENANT_GATING_ENV] = originalGating;
        }
        if (originalGlobal === undefined) {
            delete process.env[GLOBAL_ALLOWLIST_ENV];
        } else {
            process.env[GLOBAL_ALLOWLIST_ENV] = originalGlobal;
        }
    });

    it('writes a row when no prior boot row exists', async () => {
        serviceMock.findLatestBootAudit.mockResolvedValue(null);

        const result = await bootService.captureBootSnapshot();

        expect(result.wrote).toBe(true);
        expect(serviceMock.appendAuditRow).toHaveBeenCalledTimes(1);
        const payload = serviceMock.appendAuditRow.mock.calls[0][0];
        expect(payload.action).toBe('operator_allowlist_boot');
        expect(payload.tenantId).toBeNull();
        expect(payload.before).toBeNull();
        expect(payload.after).toMatchObject({
            allowedProviders: ['trigger', 'temporal'],
            perTenantGatingEnabled: false,
            hash: expect.any(String),
        });
    });

    it('writes a row when the latest boot row hash differs', async () => {
        serviceMock.findLatestBootAudit.mockResolvedValue({
            // Mismatched hash → dedupe loop fires the insert.
            after: {
                allowedProviders: ['trigger'],
                perTenantGatingEnabled: false,
                hash: 'stale-hash-from-prior-config',
            },
        } as unknown as TenantJobRuntimeAudit);

        const result = await bootService.captureBootSnapshot();

        expect(result.wrote).toBe(true);
        expect(serviceMock.appendAuditRow).toHaveBeenCalledTimes(1);
    });

    it('does NOT write when the latest boot row hash matches (dedupe)', async () => {
        // First call writes — capture its hash so we can hand it back as
        // the "latest" stored row.
        serviceMock.findLatestBootAudit.mockResolvedValueOnce(null);
        const first = await bootService.captureBootSnapshot();
        expect(first.wrote).toBe(true);

        // Second call sees the previous hash → dedupe.
        serviceMock.findLatestBootAudit.mockResolvedValueOnce({
            after: {
                allowedProviders: ['trigger', 'temporal'],
                perTenantGatingEnabled: false,
                hash: first.hash,
            },
        } as unknown as TenantJobRuntimeAudit);

        const second = await bootService.captureBootSnapshot();

        expect(second.wrote).toBe(false);
        expect(second.hash).toBe(first.hash);
        // appendAuditRow was called only once across both invocations.
        expect(serviceMock.appendAuditRow).toHaveBeenCalledTimes(1);
    });

    it('swallows errors and logs (does NOT throw) when the audit insert fails', async () => {
        serviceMock.findLatestBootAudit.mockRejectedValue(new Error('DB down'));
        // The bootstrap entry-point is the swallow surface — not
        // captureBootSnapshot. Going through onApplicationBootstrap
        // exercises the try/catch contract directly.
        await expect(bootService.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(serviceMock.appendAuditRow).not.toHaveBeenCalled();
    });
});
