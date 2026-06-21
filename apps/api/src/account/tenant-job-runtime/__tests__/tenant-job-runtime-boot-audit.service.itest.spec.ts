// EW-742 P5.1 (T35b) — INTEGRATION-level spec for the boot-time
// `operator_allowlist_boot` audit writer. Drives multiple
// `captureBootSnapshot()` invocations and `onApplicationBootstrap()`
// against a shared in-memory audit store so the dedupe-by-hash contract
// + config-flip detection + bootstrap failure swallow are exercised
// against the same surface they hit in production. Complements the
// existing unit spec at `tenant-job-runtime-boot-audit.service.spec.ts`.
//
// NEW cases (vs. the existing spec):
//   - 5 simulated pod restarts on the same config → ONE persisted boot
//     row (dedupe semantic)
//   - Operator flips `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING` →
//     fresh row is appended despite the same allow-list
//   - Operator shrinks `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` →
//     fresh row is appended
//   - Hash determinism: same effective providers in DIFFERENT operator
//     order produce the same hash (canonical-sort dedupe)
//   - `onApplicationBootstrap` calls captureBootSnapshot via the public
//     surface (proves the bootstrap hook is wired)
//   - `appendAuditRow` failure → bootstrap swallows + logs (not throws)
//   - First-write contract — single payload shape spot-check
//   - `findLatestBootAudit` failure → bootstrap still swallows

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

/**
 * Build a `TenantJobRuntimeService` test double whose `findLatestBootAudit`
 * + `appendAuditRow` operate against a shared in-memory list. Mirrors the
 * real service contract used by the boot writer.
 */
function buildBootServiceWithStore() {
    const store: Array<Pick<TenantJobRuntimeAudit, 'action' | 'after' | 'occurredAt'>> = [];

    const findLatestBootAudit = jest.fn(async () => {
        const matches = store
            .filter((r) => r.action === 'operator_allowlist_boot')
            .slice()
            .sort(
                (a, b) =>
                    (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0),
            );
        return matches[0] ?? null;
    });

    const appendAuditRow = jest.fn(
        async (payload: {
            tenantId: string | null;
            actorUserId: string | null;
            action: string;
            before: Record<string, unknown> | null;
            after: Record<string, unknown> | null;
            credentialVersion: number | null;
        }) => {
            store.push({
                action: payload.action,
                after: payload.after as Record<string, unknown> | null,
                occurredAt: new Date(),
            } as any);
        },
    );

    const serviceMock = { findLatestBootAudit, appendAuditRow } as unknown as jest.Mocked<
        Pick<TenantJobRuntimeService, 'findLatestBootAudit' | 'appendAuditRow'>
    >;

    return {
        service: serviceMock,
        store,
    };
}

describe('TenantJobRuntimeBootAuditService — boot audit dedupe (integration, EW-742 P5.1 T35b)', () => {
    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

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

    it('writes exactly ONE boot row when 5 pods restart against the same config (dedupe)', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
        const { service, store } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        const results = [];
        for (let i = 0; i < 5; i++) {
            results.push(await boot.captureBootSnapshot());
        }

        // First call writes; remaining 4 dedupe by hash.
        expect(results.map((r) => r.wrote)).toEqual([true, false, false, false, false]);
        expect(store).toHaveLength(1);
        expect(service.appendAuditRow).toHaveBeenCalledTimes(1);
        // Every call returns the same hash (deterministic).
        const hashes = new Set(results.map((r) => r.hash));
        expect(hashes.size).toBe(1);
    });

    it('appends a NEW row after the operator flips perTenantGating ON', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
        const { service, store } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        const first = await boot.captureBootSnapshot();
        expect(first.wrote).toBe(true);

        // Operator flips the flag and restarts a pod — fresh row written.
        process.env[PER_TENANT_GATING_ENV] = 'true';
        const second = await boot.captureBootSnapshot();
        expect(second.wrote).toBe(true);
        expect(second.hash).not.toBe(first.hash);
        expect(store).toHaveLength(2);
    });

    it('appends a NEW row after the operator shrinks the global allow-list', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
        const { service, store } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        await boot.captureBootSnapshot();

        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
        const after = await boot.captureBootSnapshot();

        expect(after.wrote).toBe(true);
        expect(store).toHaveLength(2);
    });

    it('hash is deterministic across operator-declared ordering (canonical sort)', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';

        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
        const aPair = buildBootServiceWithStore();
        const aBoot = new TenantJobRuntimeBootAuditService(aPair.service as any);
        const a = await aBoot.captureBootSnapshot();

        // Same providers in DIFFERENT order — should hash the same.
        process.env[GLOBAL_ALLOWLIST_ENV] = 'bullmq,trigger,temporal';
        const bPair = buildBootServiceWithStore();
        const bBoot = new TenantJobRuntimeBootAuditService(bPair.service as any);
        const b = await bBoot.captureBootSnapshot();

        expect(a.hash).toBe(b.hash);
    });

    it('emits a different hash when the underlying provider SET differs (not just order)', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';

        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
        const aPair = buildBootServiceWithStore();
        const aBoot = new TenantJobRuntimeBootAuditService(aPair.service as any);
        const a = await aBoot.captureBootSnapshot();

        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
        const bPair = buildBootServiceWithStore();
        const bBoot = new TenantJobRuntimeBootAuditService(bPair.service as any);
        const b = await bBoot.captureBootSnapshot();

        expect(a.hash).not.toBe(b.hash);
    });

    it('persists action=operator_allowlist_boot with tenantId=null + canonical after payload', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'true';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
        const { service } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        await boot.captureBootSnapshot();

        const payload = service.appendAuditRow.mock.calls[0][0];
        expect(payload.tenantId).toBeNull();
        expect(payload.actorUserId).toBeNull();
        expect(payload.action).toBe('operator_allowlist_boot');
        expect(payload.before).toBeNull();
        expect(payload.after).toMatchObject({
            allowedProviders: ['trigger', 'temporal'],
            perTenantGatingEnabled: true,
            hash: expect.any(String),
        });
        expect(payload.credentialVersion).toBeNull();
    });

    it('onApplicationBootstrap delegates to captureBootSnapshot (wires the lifecycle hook)', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
        const { service, store } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        await boot.onApplicationBootstrap();
        expect(store).toHaveLength(1);
    });

    it('swallows + logs when the audit insert (appendAuditRow) fails — does NOT throw', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
        const service = {
            findLatestBootAudit: jest.fn().mockResolvedValue(null),
            appendAuditRow: jest.fn().mockRejectedValue(new Error('audit insert failed')),
        };
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(service.appendAuditRow).toHaveBeenCalledTimes(1);
    });

    it('swallows + logs when findLatestBootAudit throws (DB transient)', async () => {
        const service = {
            findLatestBootAudit: jest.fn().mockRejectedValue(new Error('DB down')),
            appendAuditRow: jest.fn(),
        };
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();
        // Never reached the insert because the read threw.
        expect(service.appendAuditRow).not.toHaveBeenCalled();
    });

    it('dedupe is order-invariant — pod restart in DIFFERENT operator order still dedupes', async () => {
        process.env[PER_TENANT_GATING_ENV] = 'false';
        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
        const { service, store } = buildBootServiceWithStore();
        const boot = new TenantJobRuntimeBootAuditService(service as any);

        const first = await boot.captureBootSnapshot();
        expect(first.wrote).toBe(true);

        // Operator reorders the env without changing the effective set.
        // Should be treated as the same config → dedupe.
        process.env[GLOBAL_ALLOWLIST_ENV] = 'bullmq,temporal,trigger';
        const second = await boot.captureBootSnapshot();

        expect(second.wrote).toBe(false);
        expect(second.hash).toBe(first.hash);
        expect(store).toHaveLength(1);
    });
});
