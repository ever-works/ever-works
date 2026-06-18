/**
 * EW-686 P1 — unit tests for {@link TriggerJobRuntimeProvider}, the
 * thin adapter that exposes the existing `TriggerService` through the
 * new pluggable `IJobRuntimeProvider` contract (EW-685 P0).
 *
 * The adapter is intentionally a delegation wrapper — every
 * `IJobRuntimeProvider` method routes straight back into
 * `TriggerService`, which already implements the IJobRuntimeProvider
 * *method* surface on its own (it just deliberately doesn't extend the
 * full `IPlugin` shape). These tests therefore verify two things:
 *
 *   1. The IPlugin synthetic metadata the adapter ADDS (id, name,
 *      version, category, capabilities, settingsSchema, onLoad,
 *      onUnload, runtimeId) is shaped correctly.
 *   2. Every IJobRuntimeProvider method forwards its arguments and
 *      return value verbatim to the underlying `TriggerService`.
 *
 * Per-dispatch logic and the SDK-status-enum mapping are owned by
 * `TriggerService` and tested in `../../__tests__/trigger.service.spec.ts`.
 * The EW-685 T4 binding factory that wires this provider into the
 * agent `*_DISPATCHER` symbols is a follow-up PR and out of scope here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { triggerServiceMock, dispatchersSentinel } = vi.hoisted(() => {
    // Sentinel object used to verify identity-pass-through of the
    // `dispatchers` getter without depending on any real TriggerService
    // shape — what matters is that `provider.dispatchers` returns
    // exactly what `triggerService.dispatchers` returns.
    const dispatchersSentinel = { __sentinel: 'dispatchers' } as const;
    return {
        dispatchersSentinel,
        triggerServiceMock: {
            // The adapter delegates these calls to the service. Each is
            // a vi.fn so we can assert the call shape AND control the
            // return value per-test.
            isEnabled: vi.fn<() => boolean>(),
            cancel: vi.fn<(runId: string) => Promise<boolean>>(),
            getRunStatus: vi.fn<(runId: string) => Promise<string>>(),
            registerSchedules:
                vi.fn<(schedules: readonly { id: string; cron: string }[]) => Promise<void>>(),
            startWorkerHost: vi.fn<(opts: unknown) => Promise<{ stop: () => Promise<void> }>>(),
            // Property — read via the dispatchers getter.
            dispatchers: dispatchersSentinel,
        },
    };
});

import { TriggerJobRuntimeProvider } from '../trigger-job-runtime.provider';
import { TriggerService } from '../trigger.service';

describe('TriggerJobRuntimeProvider', () => {
    let provider: TriggerJobRuntimeProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset the dispatchers ref each test in case a test reassigned it.
        triggerServiceMock.dispatchers = dispatchersSentinel;
        // Default to "Trigger.dev is configured & reachable" so each
        // test starts from the happy path and overrides as needed.
        triggerServiceMock.isEnabled.mockReturnValue(true);
        provider = new TriggerJobRuntimeProvider(triggerServiceMock as unknown as TriggerService);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('IPlugin synthetic metadata', () => {
        it('declares runtimeId === "trigger"', () => {
            // Selector match for `EVER_WORKS_JOB_RUNTIME=trigger`.
            expect(provider.runtimeId).toBe('trigger');
        });

        it('declares the IPlugin metadata fields the EW-685 T4 binding factory expects', () => {
            // Plumbing the parent IPlugin shape lets the binding factory
            // hold this provider in the same DI container as future
            // "real" plugin-pipeline providers without special-casing.
            // See class JSDoc on synthetic plugin status.
            expect(provider.id).toBe('trigger');
            expect(provider.name).toBe('Trigger.dev');
            expect(provider.version).toBe('1.0.0');
            expect(provider.category).toBe('job-runtime');
            expect(provider.capabilities).toEqual([
                'job-runtime-enqueue',
                'job-runtime-cancel',
                'job-runtime-status',
                'job-runtime-schedule',
            ]);
            expect(provider.settingsSchema).toEqual({ type: 'object', properties: {} });
        });
    });

    describe('dispatcher passthrough', () => {
        it('dispatchers returns the same reference as triggerService.dispatchers', () => {
            // This is load-bearing — the EW-685 T4 binding factory will
            // bind every *_DISPATCHER symbol to `provider.dispatchers`
            // and rely on every concrete dispatch method existing on the
            // same object that exists today (TriggerService).
            expect(provider.dispatchers).toBe(dispatchersSentinel);
        });

        it('dispatchers re-reads triggerService.dispatchers on each access (live view)', () => {
            // Verifies the getter is a live view rather than a snapshot
            // captured at construction. The binding factory may resolve
            // dispatchers lazily, so the adapter must reflect the service.
            const other = { __sentinel: 'other' } as const;
            triggerServiceMock.dispatchers = other;
            expect(provider.dispatchers).toBe(other);
        });
    });

    describe('lifecycle hooks (synthetic plugin)', () => {
        it('onLoad resolves without side effects', async () => {
            await expect(provider.onLoad({} as never)).resolves.toBeUndefined();
        });

        it('onUnload resolves without side effects', async () => {
            await expect(provider.onUnload()).resolves.toBeUndefined();
        });
    });

    describe('isEnabled delegation', () => {
        it('delegates verbatim to triggerService.isEnabled() — true case', () => {
            triggerServiceMock.isEnabled.mockReturnValueOnce(true);
            expect(provider.isEnabled()).toBe(true);
            expect(triggerServiceMock.isEnabled).toHaveBeenCalledTimes(1);
        });

        it('delegates verbatim to triggerService.isEnabled() — false case', () => {
            triggerServiceMock.isEnabled.mockReturnValueOnce(false);
            expect(provider.isEnabled()).toBe(false);
            expect(triggerServiceMock.isEnabled).toHaveBeenCalledTimes(1);
        });
    });

    describe('registerSchedules delegation', () => {
        it('forwards an empty list to triggerService.registerSchedules', async () => {
            triggerServiceMock.registerSchedules.mockResolvedValue(undefined);

            await expect(provider.registerSchedules([])).resolves.toBeUndefined();

            expect(triggerServiceMock.registerSchedules).toHaveBeenCalledTimes(1);
            expect(triggerServiceMock.registerSchedules).toHaveBeenCalledWith([]);
        });

        it('forwards a non-empty list to triggerService.registerSchedules verbatim', async () => {
            triggerServiceMock.registerSchedules.mockResolvedValue(undefined);
            const schedules = [
                { id: 'work-schedule-dispatcher', cron: '*/5 * * * *' },
                { id: 'kb-reconcile', cron: '0 * * * *' },
            ];

            await expect(provider.registerSchedules(schedules)).resolves.toBeUndefined();

            expect(triggerServiceMock.registerSchedules).toHaveBeenCalledTimes(1);
            expect(triggerServiceMock.registerSchedules).toHaveBeenCalledWith(schedules);
        });
    });

    describe('cancel delegation', () => {
        it('forwards runId to triggerService.cancel and returns its result (true)', async () => {
            triggerServiceMock.cancel.mockResolvedValue(true);

            const out = await provider.cancel('run_abc');

            expect(out).toBe(true);
            expect(triggerServiceMock.cancel).toHaveBeenCalledTimes(1);
            expect(triggerServiceMock.cancel).toHaveBeenCalledWith('run_abc');
        });

        it('forwards runId to triggerService.cancel and returns its result (false)', async () => {
            // The adapter must NOT second-guess the service's gate — if
            // the service returns false (disabled, unknown id, SDK
            // threw), the adapter returns false too.
            triggerServiceMock.cancel.mockResolvedValue(false);

            const out = await provider.cancel('run_missing');

            expect(out).toBe(false);
            expect(triggerServiceMock.cancel).toHaveBeenCalledWith('run_missing');
        });
    });

    describe('getRunStatus delegation', () => {
        it.each([
            ['queued'],
            ['running'],
            ['completed'],
            ['failed'],
            ['cancelled'],
            ['unknown'],
        ] as const)(
            'forwards runId and returns the service\'s "%s" status verbatim',
            async (status) => {
                triggerServiceMock.getRunStatus.mockResolvedValue(status);

                const out = await provider.getRunStatus('run_status_test');

                expect(out).toBe(status);
                expect(triggerServiceMock.getRunStatus).toHaveBeenCalledWith('run_status_test');
            },
        );
    });

    describe('startWorkerHost delegation', () => {
        it('forwards opts to triggerService.startWorkerHost and returns its handle', async () => {
            // Trigger.dev is push-model, so TriggerService.startWorkerHost
            // returns a no-op handle. The adapter must pass it through
            // unchanged so a generic "start the worker host if the
            // provider supports it" caller works without per-provider
            // branching.
            const handle = { stop: vi.fn().mockResolvedValue(undefined) };
            triggerServiceMock.startWorkerHost.mockResolvedValue(handle);
            const opts = { concurrency: 4 };

            const out = await provider.startWorkerHost(opts);

            expect(out).toBe(handle);
            expect(triggerServiceMock.startWorkerHost).toHaveBeenCalledTimes(1);
            expect(triggerServiceMock.startWorkerHost).toHaveBeenCalledWith(opts);
        });
    });
});
