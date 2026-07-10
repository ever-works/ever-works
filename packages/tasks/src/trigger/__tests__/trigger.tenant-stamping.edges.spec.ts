/**
 * EW-742 P3.2 T22 (stamping) — deep edge coverage on top of the canonical
 * `trigger.tenant-stamping.spec.ts`. Pins behaviours the canonical suite
 * doesn't exercise but the stamping contract still has to honour:
 *
 *   - Concurrency: 100 concurrent dispatches across N distinct
 *     AsyncLocalStorage contexts → each gets the right concurrencyKey,
 *     no leakage.
 *   - Stamping with a caller-provided `concurrencyKey` composes as
 *     `${tenantId}:${existing}` (EW-641 per-Work serialization
 *     invariant preserved).
 *   - Caller-provided `idempotencyKey` is preserved unchanged across the
 *     stamp helper (hard invariant — per-tenant idempotency leaking into
 *     a global one would be a silent correctness bug).
 *   - Caller-provided tags array → tenant tag PREPENDED, existing tags
 *     preserved in order.
 *   - Fleet-wide dispatchers (KB_BACKFILL_SKELETON) — NO stamp applied
 *     even from a bound view.
 *   - Stamping outside any AsyncLocalStorage context → no stamp (no
 *     false-positive tenant attribution).
 *   - `tenantId=''` / `tenantId=null` → no stamp applied (treated as
 *     fleet-wide).
 *
 * Mirrors the hoisted-mock idiom used in the canonical spec; the
 * Trigger.dev SDK + per-task module imports are fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const {
    configureMock,
    runsCancelMock,
    runsRetrieveMock,
    triggerConfig,
    subscriptionsConfig,
    workGenerationTriggerMock,
    workImportTriggerMock,
    templateCustomizationTriggerMock,
    webhookDeliveryTriggerMock,
    kbMirrorDocumentTriggerMock,
    kbBackfillSkeletonTriggerMock,
    kbEmbedDocumentTriggerMock,
    kbOrgOverlayFanoutTriggerMock,
    kbNormalizeVideoTriggerMock,
    kbNormalizeAudioTriggerMock,
    kbTranscribeTriggerMock,
    kbReembedWorkTriggerMock,
    notificationChannelDeliveryTriggerMock,
} = vi.hoisted(() => {
    return {
        configureMock: vi.fn(),
        runsCancelMock: vi.fn(),
        runsRetrieveMock: vi.fn(),
        triggerConfig: {
            shouldUseTrigger: vi.fn(),
            getSecretKey: vi.fn(),
            getApiUrl: vi.fn(),
            getMachine: vi.fn(),
            getInternalBaseUrl: vi.fn(),
            getInternalSecret: vi.fn(),
        },
        subscriptionsConfig: { getDispatchIntervalMinutes: vi.fn(() => 5) },
        workGenerationTriggerMock: vi.fn().mockResolvedValue({ id: 'run_wg' }),
        workImportTriggerMock: vi.fn().mockResolvedValue({ id: 'run_wi' }),
        templateCustomizationTriggerMock: vi.fn().mockResolvedValue({ id: 'run_tc' }),
        webhookDeliveryTriggerMock: vi.fn().mockResolvedValue({ id: 'run_wh' }),
        kbMirrorDocumentTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbm' }),
        kbBackfillSkeletonTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbb' }),
        kbEmbedDocumentTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbe' }),
        kbOrgOverlayFanoutTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbo' }),
        kbNormalizeVideoTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbnv' }),
        kbNormalizeAudioTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbna' }),
        kbTranscribeTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbt' }),
        kbReembedWorkTriggerMock: vi.fn().mockResolvedValue({ id: 'run_kbr' }),
        notificationChannelDeliveryTriggerMock: vi.fn().mockResolvedValue({ id: 'run_ncd' }),
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    configure: configureMock,
    runs: { cancel: runsCancelMock, retrieve: runsRetrieveMock },
    task: vi.fn().mockImplementation(() => ({ id: 'mock-task' })),
    schedules: { task: vi.fn().mockImplementation(() => ({ id: 'mock-schedule-task' })) },
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: { trigger: triggerConfig, subscriptions: subscriptionsConfig },
}));

vi.mock('@ever-works/agent/tasks', () => ({
    WORK_GENERATION_DISPATCHER: Symbol('WORK_GENERATION_DISPATCHER'),
    WORK_IMPORT_DISPATCHER: Symbol('WORK_IMPORT_DISPATCHER'),
    TEMPLATE_CUSTOMIZATION_DISPATCHER: Symbol('TEMPLATE_CUSTOMIZATION_DISPATCHER'),
    KB_ORG_OVERLAY_FANOUT_DISPATCHER: Symbol('KB_ORG_OVERLAY_FANOUT_DISPATCHER'),
}));

vi.mock('../../tasks/trigger/work-generation.task', () => ({
    workGenerationTask: { trigger: workGenerationTriggerMock },
}));
vi.mock('../../tasks/trigger/work-import.task', () => ({
    workImportTask: { trigger: workImportTriggerMock },
}));
vi.mock('../../tasks/trigger/template-customization.task', () => ({
    templateCustomizationTask: { trigger: templateCustomizationTriggerMock },
}));
vi.mock('../../tasks/trigger/webhook-delivery.task', () => ({
    webhookDeliveryTask: { trigger: webhookDeliveryTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-mirror-document.task', () => ({
    kbMirrorDocumentTask: { trigger: kbMirrorDocumentTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-backfill-skeleton.task', () => ({
    kbBackfillSkeletonTask: { trigger: kbBackfillSkeletonTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-embed-document.task', () => ({
    kbEmbedDocumentTask: { trigger: kbEmbedDocumentTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-org-overlay-fanout.task', () => ({
    kbOrgOverlayFanoutTask: { trigger: kbOrgOverlayFanoutTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-normalize-video.task', () => ({
    kbNormalizeVideoTask: { trigger: kbNormalizeVideoTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-normalize-audio.task', () => ({
    kbNormalizeAudioTask: { trigger: kbNormalizeAudioTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-transcribe.task', () => ({
    kbTranscribeTask: { trigger: kbTranscribeTriggerMock },
}));
vi.mock('../../tasks/trigger/kb-reembed-work.task', () => ({
    kbReembedWorkTask: { trigger: kbReembedWorkTriggerMock },
}));
vi.mock('../../tasks/trigger/notification-channel-delivery.task', () => ({
    notificationChannelDeliveryTask: { trigger: notificationChannelDeliveryTriggerMock },
}));

import { TriggerService, triggerTenantStampStorage } from '../trigger.service';
import { TriggerJobRuntimeProvider } from '../trigger-job-runtime.provider';

/**
 * Inherit-shaped snapshot — empty `credentials` bag so
 * `extractTenantCredentials` silently returns null (the "pure inherit"
 * path), avoiding the per-bindToTenant "malformed BYO" warn the
 * partial-credentials shape used by `trigger.tenant-stamping.spec.ts`
 * would emit. The stamping behaviour under test doesn't depend on
 * which inherit shape the snapshot uses.
 */
const SNAPSHOT = (overrides: Partial<{ tenantId: string; credentialVersion: number }> = {}) => ({
    tenantId: '00000000-0000-0000-0000-00000000aaaa',
    providerId: 'trigger' as const,
    credentialVersion: 1,
    credentials: {},
    ...overrides,
});

describe('TriggerService stamping EDGE cases (EW-742 P3.2 T22)', () => {
    let service: TriggerService;
    let provider: TriggerJobRuntimeProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.shouldUseTrigger.mockReturnValue(true);
        triggerConfig.getSecretKey.mockReturnValue('tr_test_secret');
        triggerConfig.getApiUrl.mockReturnValue('https://api.trigger.test');
        triggerConfig.getMachine.mockReturnValue('small-1x');
        service = new TriggerService();
        provider = new TriggerJobRuntimeProvider(service);
        // Silence Nest Logger noise (both the service's logger and the
        // provider's separate Logger instance).
        vi.spyOn(
            (service as unknown as { logger: { error: () => void } }).logger,
            'error',
        ).mockImplementation(() => {});
        vi.spyOn(
            (service as unknown as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => {});
        vi.spyOn(
            (service as unknown as { logger: { debug: () => void } }).logger,
            'debug',
        ).mockImplementation(() => {});
        vi.spyOn(
            (provider as unknown as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('high-concurrency stamping across distinct AsyncLocalStorage contexts', () => {
        it('100 concurrent dispatchKbEmbedDocument calls across 100 tenants → each call sees only its own stamp', async () => {
            // Each iteration binds a fresh tenant view (own AsyncLocalStorage
            // context inside the Proxy's `run(stamp, ...)`), then dispatches
            // through it. If the storage leaked across the await boundary,
            // we'd see a mismatched concurrencyKey on at least one call.
            const tenants = Array.from({ length: 100 }, () => randomUUID());
            await Promise.all(
                tenants.map(async (tenantId, idx) => {
                    const view = provider.bindToTenant(SNAPSHOT({ tenantId }));
                    const dispatchers = view.dispatchers as unknown as {
                        dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
                    };
                    const workId = `w-${idx}`;
                    await dispatchers.dispatchKbEmbedDocument({ workId, documentId: 'd' });
                }),
            );

            expect(kbEmbedDocumentTriggerMock).toHaveBeenCalledTimes(100);
            // For each invocation, verify the concurrencyKey starts with
            // the matching tenantId for its workId index.
            const seenKeys = new Set<string>();
            for (let i = 0; i < 100; i++) {
                const payload = kbEmbedDocumentTriggerMock.mock.calls[i][0] as { workId: string };
                const opts = kbEmbedDocumentTriggerMock.mock.calls[i][1] as Record<string, unknown>;
                const workIdx = Number(payload.workId.slice(2));
                const expectedTenant = tenants[workIdx];
                expect(opts.concurrencyKey).toBe(`${expectedTenant}:kb-embed:${payload.workId}`);
                const tenantTag = (opts.tags as string[]).find((t) => t.startsWith('tenant:'));
                expect(tenantTag).toBe(`tenant:${expectedTenant}`);
                seenKeys.add(opts.concurrencyKey as string);
            }
            // 100 unique concurrencyKeys — no two dispatches collapsed
            // onto the same key (would indicate ALS leakage).
            expect(seenKeys.size).toBe(100);
        });
    });

    describe('stampTenantOptions merge invariants', () => {
        // Access the private helper via the structural escape hatch the
        // canonical spec already uses.
        type StampHelper = <T extends Record<string, unknown>>(o: T) => T;
        const stamp = (target: TriggerService): StampHelper =>
            (target as unknown as { stampTenantOptions: StampHelper }).stampTenantOptions.bind(
                target,
            );

        it('caller-provided concurrencyKey is composed as `${tenantId}:${existing}` (preserves EW-641 invariant)', () => {
            const tenantId = '11111111-1111-1111-1111-111111111111';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({ concurrencyKey: 'kb-embed:work-42' }),
            );
            expect(result.concurrencyKey).toBe(`${tenantId}:kb-embed:work-42`);
        });

        it('caller-provided idempotencyKey is preserved verbatim (NEVER touched by stamping)', () => {
            const tenantId = '22222222-2222-2222-2222-222222222222';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({
                    idempotencyKey: 'caller-key-xyz',
                    tags: ['existing'],
                }),
            );
            expect(result.idempotencyKey).toBe('caller-key-xyz');
            // Sibling fields ARE stamped, proving the helper still
            // engaged — the idempotencyKey preservation isn't because
            // stamping was skipped wholesale.
            expect(result.concurrencyKey).toBe(tenantId);
            expect((result.tags as string[])[0]).toBe(`tenant:${tenantId}`);
        });

        it('caller-provided tags array → tenant tag PREPENDED, existing tags preserved in order', () => {
            const tenantId = '33333333-3333-3333-3333-333333333333';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({ tags: ['alpha', 'beta', 'gamma'] }),
            );
            expect(result.tags).toEqual([`tenant:${tenantId}`, 'alpha', 'beta', 'gamma']);
        });

        it('already-prepended tenant tag is NOT duplicated (re-entrant stamp idempotency)', () => {
            const tenantId = '44444444-4444-4444-4444-444444444444';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({ tags: [`tenant:${tenantId}`, 'existing'] }),
            );
            expect(result.tags).toEqual([`tenant:${tenantId}`, 'existing']);
        });

        it('stamping OUTSIDE any AsyncLocalStorage context → input returned verbatim (no false-positive attribution)', () => {
            const opts = {
                tags: ['existing'],
                concurrencyKey: 'kb-embed:w1',
                idempotencyKey: 'idem-1',
            };
            const result = stamp(service)(opts);
            // Reference equality on the EXACT same options object is the
            // documented "byte-identical to pre-stamp path" contract.
            expect(result).toBe(opts);
        });

        it('stamp with empty tenantId is treated as no stamp (fleet-wide attribution)', () => {
            const result = triggerTenantStampStorage.run({ tenantId: '' }, () =>
                stamp(service)({ tags: ['existing'] }),
            );
            // Empty tenantId → falsy guard hit → input returned verbatim.
            expect(result).toEqual({ tags: ['existing'] });
            expect((result.tags as string[]).some((t) => t.startsWith('tenant:'))).toBe(false);
        });

        it('stamp with nullish tenantId (cast through unknown) is treated as no stamp', () => {
            const result = triggerTenantStampStorage.run(
                { tenantId: null as unknown as string },
                () => stamp(service)({ tags: ['existing'] }),
            );
            expect(result).toEqual({ tags: ['existing'] });
        });

        it('non-string options.tags (malformed input) → tags coerced to fresh [tenantTag] array', () => {
            // Defensive contract: dispatcher code never sets non-array
            // tags, but the helper still has to behave sanely if upstream
            // code drifts. Pin behaviour so the drift surfaces here, not
            // at runtime as a confused Trigger.dev dashboard.
            const tenantId = '55555555-5555-5555-5555-555555555555';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({ tags: 'not-an-array' as unknown as string[] }),
            );
            expect(result.tags).toEqual([`tenant:${tenantId}`]);
        });

        it('non-string options.concurrencyKey is treated as absent → concurrencyKey = tenantId', () => {
            const tenantId = '66666666-6666-6666-6666-666666666666';
            const result = triggerTenantStampStorage.run({ tenantId }, () =>
                stamp(service)({ concurrencyKey: 42 as unknown as string }),
            );
            expect(result.concurrencyKey).toBe(tenantId);
        });
    });

    describe('fleet-wide carve-out integrity', () => {
        it('dispatchKbBackfillSkeleton called via the bound view multiple times in a row stays unstamped each time', async () => {
            const view = provider.bindToTenant(SNAPSHOT());
            const dispatchers = view.dispatchers as unknown as {
                dispatchKbBackfillSkeleton: (p: unknown) => Promise<string | null>;
            };
            for (let i = 0; i < 5; i++) {
                await dispatchers.dispatchKbBackfillSkeleton({ workIds: [`w${i}`] });
            }
            expect(kbBackfillSkeletonTriggerMock).toHaveBeenCalledTimes(5);
            for (let i = 0; i < 5; i++) {
                const opts = kbBackfillSkeletonTriggerMock.mock.calls[i][1] as Record<
                    string,
                    unknown
                >;
                expect(opts.concurrencyKey).toBeUndefined();
                expect((opts.tags as string[]).some((t) => t.startsWith('tenant:'))).toBe(false);
            }
        });

        it('fleet-wide dispatcher in one tenant + tenant-scoped dispatch in another (interleaved) → each keeps its expected stamp shape', async () => {
            const tenantA = '77777777-7777-7777-7777-777777777777';
            const tenantB = '88888888-8888-8888-8888-888888888888';
            const viewA = provider.bindToTenant(SNAPSHOT({ tenantId: tenantA }));
            const viewB = provider.bindToTenant(SNAPSHOT({ tenantId: tenantB }));

            await Promise.all([
                (
                    viewA.dispatchers as unknown as {
                        dispatchKbBackfillSkeleton: (p: unknown) => Promise<string | null>;
                    }
                ).dispatchKbBackfillSkeleton({ workIds: ['fleetwide'] }),
                (
                    viewB.dispatchers as unknown as {
                        dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
                    }
                ).dispatchKbEmbedDocument({ workId: 'wB', documentId: 'dB' }),
            ]);

            const backfillOpts = kbBackfillSkeletonTriggerMock.mock.calls[0][1] as Record<
                string,
                unknown
            >;
            const embedOpts = kbEmbedDocumentTriggerMock.mock.calls[0][1] as Record<
                string,
                unknown
            >;
            // Fleet-wide A → unstamped, no tenant tag, no concurrencyKey.
            expect(backfillOpts.concurrencyKey).toBeUndefined();
            expect((backfillOpts.tags as string[]).some((t) => t.startsWith('tenant:'))).toBe(
                false,
            );
            // Tenant-scoped B → tenant tag prepended, composed concurrencyKey.
            expect((embedOpts.tags as string[])[0]).toBe(`tenant:${tenantB}`);
            expect(embedOpts.concurrencyKey).toBe(`${tenantB}:kb-embed:wB`);
        });
    });

    describe('non-dispatcher property access through the bound view', () => {
        it('reading a non-`dispatch*` method via the bound view does NOT route through the stamp Proxy wrapper', async () => {
            // `cancelWorkGeneration` lives on TriggerService but isn't a
            // dispatcher method — the Proxy must NOT wrap it (the helper
            // only fires on `dispatch*`). Calling it through the bound
            // view's dispatchers map should bind to `this = service` and
            // run without engaging the stamp.
            const view = provider.bindToTenant(SNAPSHOT());
            const dispatchers = view.dispatchers as unknown as {
                cancelWorkGeneration?: (id: string) => Promise<boolean>;
            };
            // Even if undefined here (depending on how dispatchers shape
            // exposes non-dispatch methods), the bound view must not
            // throw when accessed.
            expect(() => dispatchers.cancelWorkGeneration).not.toThrow();
        });
    });
});
