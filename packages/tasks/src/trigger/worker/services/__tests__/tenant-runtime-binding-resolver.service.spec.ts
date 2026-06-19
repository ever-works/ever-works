import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    OrganizationRepository,
    TemplateCustomizationRepository,
    WebhookSubscriptionRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { TenantRuntimeBindingResolverService } from '../tenant-runtime-binding-resolver.service';

/**
 * EW-742 P3.2 T22 (worker-host consumption) — unit tests for the
 * resolver service that picks up `(providerId, credentialVersion)` off
 * worker payloads and calls `CredentialVersionService.resolveSnapshot`.
 *
 * Covers every branch in the JSDoc state machine:
 *   - no-binding (missing field, missing tenantId, missing service)
 *   - resolved (happy path)
 *   - drained (snapshot rotated past requested version)
 *   - error (resolveSnapshot threw)
 *
 * Plus the `resolveForWork` convenience wrapper.
 */
describe('TenantRuntimeBindingResolverService (EW-742 P3.2 T22 worker-host)', () => {
    const TENANT_ID = '00000000-0000-0000-0000-00000000aaaa';
    const WORK_ID = '11111111-1111-1111-1111-111111111111';

    function buildResolver(opts: {
        snapshot?: TenantJobRuntimeConfig | null;
        resolveThrows?: boolean;
        workTenantId?: string | null;
        workFindThrows?: boolean;
        omitCredentialVersionService?: boolean;
        omitWorkRepository?: boolean;
    }) {
        const credentialVersionService = {
            resolveSnapshot: opts.resolveThrows
                ? vi.fn().mockRejectedValue(new Error('boom'))
                : vi.fn().mockResolvedValue(opts.snapshot ?? null),
        } as unknown as CredentialVersionService;

        const workRepository = {
            findById: opts.workFindThrows
                ? vi.fn().mockRejectedValue(new Error('db boom'))
                : vi.fn().mockResolvedValue(
                      opts.workTenantId === undefined
                          ? null
                          : ({ id: WORK_ID, tenantId: opts.workTenantId } as any),
                  ),
        } as unknown as WorkRepository;

        return new TenantRuntimeBindingResolverService(
            opts.omitCredentialVersionService ? undefined : credentialVersionService,
            opts.omitWorkRepository ? undefined : workRepository,
        );
    }

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('resolve()', () => {
        it('returns "no-binding" when providerId is null (pre-T22 payload)', async () => {
            const r = buildResolver({});
            const out = await r.resolve(
                { providerId: null, credentialVersion: 5 },
                TENANT_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when credentialVersion is null', async () => {
            const r = buildResolver({});
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: null },
                TENANT_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when both fields are absent', async () => {
            const r = buildResolver({});
            const out = await r.resolve({}, TENANT_ID);
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when tenantId is null even with valid fields', async () => {
            const r = buildResolver({});
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: 5 },
                null,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when CredentialVersionService is not wired', async () => {
            const r = buildResolver({ omitCredentialVersionService: true });
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: 5 },
                TENANT_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "resolved" with the snapshot on the happy path', async () => {
            const snapshot = {
                tenantId: TENANT_ID,
                providerId: 'trigger',
                credentialVersion: 5,
                mode: 'byo',
                enabled: true,
            } as TenantJobRuntimeConfig;
            const r = buildResolver({ snapshot });
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: 5 },
                TENANT_ID,
            );
            expect(out).toEqual({
                status: 'resolved',
                snapshot,
                providerId: 'trigger',
                credentialVersion: 5,
                tenantId: TENANT_ID,
            });
        });

        it('returns "drained" when resolveSnapshot returns null (rotated past version)', async () => {
            const r = buildResolver({ snapshot: null });
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: 5 },
                TENANT_ID,
            );
            expect(out).toEqual({
                status: 'drained',
                providerId: 'trigger',
                credentialVersion: 5,
                tenantId: TENANT_ID,
            });
        });

        it('returns "error" + fails open when resolveSnapshot throws', async () => {
            const r = buildResolver({ resolveThrows: true });
            const out = await r.resolve(
                { providerId: 'trigger', credentialVersion: 5 },
                TENANT_ID,
            );
            expect(out).toEqual({ status: 'error' });
        });
    });

    describe('resolveForWork()', () => {
        it('looks up tenantId via WorkRepository and delegates to resolve()', async () => {
            const snapshot = {
                tenantId: TENANT_ID,
                providerId: 'trigger',
                credentialVersion: 5,
                mode: 'override',
                enabled: true,
            } as TenantJobRuntimeConfig;
            const r = buildResolver({ snapshot, workTenantId: TENANT_ID });

            const out = await r.resolveForWork(
                { providerId: 'trigger', credentialVersion: 5 },
                WORK_ID,
            );
            expect(out.status).toBe('resolved');
            expect(out.tenantId).toBe(TENANT_ID);
        });

        it('returns "no-binding" when WorkRepository is not wired', async () => {
            const r = buildResolver({ omitWorkRepository: true });
            const out = await r.resolveForWork(
                { providerId: 'trigger', credentialVersion: 5 },
                WORK_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when WorkRepository.findById throws', async () => {
            const r = buildResolver({ workFindThrows: true });
            const out = await r.resolveForWork(
                { providerId: 'trigger', credentialVersion: 5 },
                WORK_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when Work has no tenantId (pre-EW-655 row)', async () => {
            const r = buildResolver({ workTenantId: null });
            const out = await r.resolveForWork(
                { providerId: 'trigger', credentialVersion: 5 },
                WORK_ID,
            );
            // tenantId is null → resolve() short-circuits to no-binding.
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('passes through the pre-T22 no-binding when payload lacks the pair', async () => {
            const r = buildResolver({ workTenantId: TENANT_ID });
            const out = await r.resolveForWork({}, WORK_ID);
            expect(out).toEqual({ status: 'no-binding' });
        });
    });

    // EW-742 P3.2 T22 — non-workId convenience wrappers.
    describe('resolveForOrganization()', () => {
        const ORG_ID = '22222222-2222-2222-2222-222222222222';
        const SNAPSHOT = {
            tenantId: TENANT_ID,
            providerId: 'trigger',
            credentialVersion: 5,
            mode: 'byo',
            enabled: true,
        } as TenantJobRuntimeConfig;

        function build(opts: {
            orgTenantId?: string | null;
            orgFindThrows?: boolean;
            omitOrgRepository?: boolean;
            snapshot?: TenantJobRuntimeConfig | null;
        }) {
            const credentialVersionService = {
                resolveSnapshot: vi.fn().mockResolvedValue(opts.snapshot ?? null),
            } as unknown as CredentialVersionService;
            const orgRepository = {
                findById: opts.orgFindThrows
                    ? vi.fn().mockRejectedValue(new Error('db boom'))
                    : vi.fn().mockResolvedValue(
                          opts.orgTenantId === undefined
                              ? null
                              : ({ id: ORG_ID, tenantId: opts.orgTenantId } as any),
                      ),
            } as unknown as OrganizationRepository;
            return new TenantRuntimeBindingResolverService(
                credentialVersionService,
                undefined,
                opts.omitOrgRepository ? undefined : orgRepository,
                undefined,
            );
        }

        it('resolves snapshot via org → tenantId', async () => {
            const r = build({ orgTenantId: TENANT_ID, snapshot: SNAPSHOT });
            const out = await r.resolveForOrganization(
                { providerId: 'trigger', credentialVersion: 5 },
                ORG_ID,
            );
            expect(out.status).toBe('resolved');
            expect(out.tenantId).toBe(TENANT_ID);
        });

        it('returns "no-binding" when OrganizationRepository is not wired', async () => {
            const r = build({ omitOrgRepository: true });
            const out = await r.resolveForOrganization(
                { providerId: 'trigger', credentialVersion: 5 },
                ORG_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when OrganizationRepository.findById throws', async () => {
            const r = build({ orgFindThrows: true });
            const out = await r.resolveForOrganization(
                { providerId: 'trigger', credentialVersion: 5 },
                ORG_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when org has no tenantId', async () => {
            const r = build({ orgTenantId: null });
            const out = await r.resolveForOrganization(
                { providerId: 'trigger', credentialVersion: 5 },
                ORG_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });
    });

    describe('resolveForSubscription()', () => {
        const SUB_ID = '44444444-4444-4444-4444-444444444444';
        const SNAPSHOT = {
            tenantId: TENANT_ID,
            providerId: 'trigger',
            credentialVersion: 5,
            mode: 'byo',
            enabled: true,
        } as TenantJobRuntimeConfig;

        function build(opts: {
            subTenantId?: string | null;
            subFindThrows?: boolean;
            omitRepository?: boolean;
            snapshot?: TenantJobRuntimeConfig | null;
        }) {
            const credentialVersionService = {
                resolveSnapshot: vi.fn().mockResolvedValue(opts.snapshot ?? null),
            } as unknown as CredentialVersionService;
            const subRepository = {
                findById: opts.subFindThrows
                    ? vi.fn().mockRejectedValue(new Error('db boom'))
                    : vi.fn().mockResolvedValue(
                          opts.subTenantId === undefined
                              ? null
                              : ({ id: SUB_ID, tenantId: opts.subTenantId } as any),
                      ),
            } as unknown as WebhookSubscriptionRepository;
            return new TenantRuntimeBindingResolverService(
                credentialVersionService,
                undefined,
                undefined,
                undefined,
                opts.omitRepository ? undefined : subRepository,
            );
        }

        it('resolves snapshot via subscription → tenantId', async () => {
            const r = build({ subTenantId: TENANT_ID, snapshot: SNAPSHOT });
            const out = await r.resolveForSubscription(
                { providerId: 'trigger', credentialVersion: 5 },
                SUB_ID,
            );
            expect(out.status).toBe('resolved');
            expect(out.tenantId).toBe(TENANT_ID);
        });

        it('returns "no-binding" when WebhookSubscriptionRepository is not wired', async () => {
            const r = build({ omitRepository: true });
            const out = await r.resolveForSubscription(
                { providerId: 'trigger', credentialVersion: 5 },
                SUB_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when findById throws', async () => {
            const r = build({ subFindThrows: true });
            const out = await r.resolveForSubscription(
                { providerId: 'trigger', credentialVersion: 5 },
                SUB_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when subscription has no tenantId', async () => {
            const r = build({ subTenantId: null });
            const out = await r.resolveForSubscription(
                { providerId: 'trigger', credentialVersion: 5 },
                SUB_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });
    });

    describe('resolveForCustomization()', () => {
        const CUST_ID = '33333333-3333-3333-3333-333333333333';
        const SNAPSHOT = {
            tenantId: TENANT_ID,
            providerId: 'trigger',
            credentialVersion: 5,
            mode: 'override',
            enabled: true,
        } as TenantJobRuntimeConfig;

        function build(opts: {
            rowTenantId?: string | null;
            rowFindThrows?: boolean;
            omitRepository?: boolean;
            snapshot?: TenantJobRuntimeConfig | null;
        }) {
            const credentialVersionService = {
                resolveSnapshot: vi.fn().mockResolvedValue(opts.snapshot ?? null),
            } as unknown as CredentialVersionService;
            const repo = {
                findById: opts.rowFindThrows
                    ? vi.fn().mockRejectedValue(new Error('db boom'))
                    : vi.fn().mockResolvedValue(
                          opts.rowTenantId === undefined
                              ? null
                              : ({ id: CUST_ID, tenantId: opts.rowTenantId } as any),
                      ),
            } as unknown as TemplateCustomizationRepository;
            return new TenantRuntimeBindingResolverService(
                credentialVersionService,
                undefined,
                undefined,
                opts.omitRepository ? undefined : repo,
            );
        }

        it('resolves snapshot via customization row → tenantId', async () => {
            const r = build({ rowTenantId: TENANT_ID, snapshot: SNAPSHOT });
            const out = await r.resolveForCustomization(
                { providerId: 'trigger', credentialVersion: 5 },
                CUST_ID,
            );
            expect(out.status).toBe('resolved');
            expect(out.tenantId).toBe(TENANT_ID);
        });

        it('returns "no-binding" when TemplateCustomizationRepository is not wired', async () => {
            const r = build({ omitRepository: true });
            const out = await r.resolveForCustomization(
                { providerId: 'trigger', credentialVersion: 5 },
                CUST_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });

        it('returns "no-binding" when findById throws', async () => {
            const r = build({ rowFindThrows: true });
            const out = await r.resolveForCustomization(
                { providerId: 'trigger', credentialVersion: 5 },
                CUST_ID,
            );
            expect(out).toEqual({ status: 'no-binding' });
        });
    });
});
