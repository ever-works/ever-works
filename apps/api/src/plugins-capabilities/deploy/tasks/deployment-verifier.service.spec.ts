jest.mock('@ever-works/agent/database', () => ({ WorkRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ Work: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/facades', () => ({ DeployFacadeService: class {} }));
jest.mock('@ever-works/agent/events', () => {
    class DeploymentCompletedEvent {
        static EVENT_NAME = 'deployment.completed';
        constructor(public readonly payload: unknown) {}
    }
    class DeploymentFailedEvent {
        static EVENT_NAME = 'deployment.failed';
        constructor(public readonly payload: unknown) {}
    }
    return { DeploymentCompletedEvent, DeploymentFailedEvent };
});

import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DeployFacadeService } from '@ever-works/agent/facades';
import type { WorkRepository } from '@ever-works/agent/database';
import type { PluginRegistryService } from '@ever-works/agent/plugins';
import {
    DeploymentCompletedEvent,
    DeploymentFailedEvent,
} from '@ever-works/agent/events';
import { DeploymentVerifierService } from './deployment-verifier.service';

type DeploymentReadyState =
    | 'BUILDING'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | 'CANCELED'
    | 'TIMEOUT';

const POLL_INTERVAL_MS = 10 * 1000;
const FETCH_LIMIT = 18;

/**
 * Test strategy: the polling logic uses `setInterval`, so we use Jest fake
 * timers and step the clock manually with `jest.advanceTimersByTimeAsync`
 * — that variant flushes microtasks (the awaited
 * `deployFacade.lookupExistingDeployment` and chained `repository.update`s)
 * between ticks, which legacy `advanceTimersByTime` does not.
 */
describe('DeploymentVerifierService', () => {
    const buildWork = (overrides: Partial<Record<string, unknown>> = {}) => ({
        id: 'work-1',
        deployProvider: 'vercel',
        getWebsiteRepo: () => 'acme-site',
        ...overrides,
    });

    let repository: jest.Mocked<Pick<WorkRepository, 'update'>>;
    let deployFacade: jest.Mocked<Pick<DeployFacadeService, 'lookupExistingDeployment'>>;
    let pluginRegistry: jest.Mocked<Pick<PluginRegistryService, 'get'>>;
    let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
    let service: DeploymentVerifierService;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        repository = { update: jest.fn().mockResolvedValue(undefined) } as any;
        deployFacade = { lookupExistingDeployment: jest.fn() } as any;
        pluginRegistry = { get: jest.fn() } as any;
        eventEmitter = { emit: jest.fn() } as any;
        service = new DeploymentVerifierService(
            repository as unknown as WorkRepository,
            deployFacade as unknown as DeployFacadeService,
            pluginRegistry as unknown as PluginRegistryService,
            eventEmitter as unknown as EventEmitter2,
        );
        // Silence the logger; only `errorSpy` and `debugSpy` are asserted.
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        debugSpy = jest
            .spyOn((service as any).logger, 'debug')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('startVerification — initial side effects', () => {
        beforeEach(() => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        it('writes INITIALIZING + deploymentStartedAt synchronously then registers a queue entry', async () => {
            await service.startVerification(buildWork() as any, 'user-1');

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentStartedAt: new Date('2026-01-01T00:00:00Z'),
                deploymentState: 'INITIALIZING',
            });
            expect((service as any).queue.has('work-1')).toBe(true);
        });

        it('cancels any pre-existing verification for the same workId before starting a new one', async () => {
            // First run — registers a queue entry; second run — must
            // cancel the first (which emits CANCELED via emitTerminalEvent
            // unless the in-flight poll already terminated).
            await service.startVerification(buildWork() as any, 'user-1');
            const firstCancel = (service as any).queue.get('work-1');
            expect(typeof firstCancel).toBe('function');

            await service.startVerification(buildWork() as any, 'user-1');

            // After the second startVerification, the queue should hold a NEW
            // closure (the first one was invoked + replaced).
            const secondCancel = (service as any).queue.get('work-1');
            expect(typeof secondCancel).toBe('function');
            expect(secondCancel).not.toBe(firstCancel);

            // The first run's cancel-closure ran cleanup('CANCELED') →
            // emitTerminalEvent fired DeploymentFailedEvent w/
            // terminalState='CANCELED'.
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                DeploymentFailedEvent.EVENT_NAME,
                expect.any(DeploymentFailedEvent),
            );
            const failedEvent = eventEmitter.emit.mock.calls[0]![1] as InstanceType<
                typeof DeploymentFailedEvent
            >;
            expect((failedEvent as any).payload.terminalState).toBe('CANCELED');
        });

        it('startVerification on a fresh workId does not invoke any prior cancel', async () => {
            await service.startVerification(buildWork({ id: 'work-A' }) as any, 'user-1');
            await service.startVerification(buildWork({ id: 'work-B' }) as any, 'user-1');

            // No cancel should have fired — both queue entries should
            // still be present.
            expect((service as any).queue.has('work-A')).toBe(true);
            expect((service as any).queue.has('work-B')).toBe(true);
            expect(eventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    describe('verifyDeployment — interval poll outcomes', () => {
        beforeEach(() => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        it('READY → updates website + emits DeploymentCompletedEvent + clears queue + sets terminated', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                website: 'https://acme-site.example.com',
                deploymentState: 'READY',
            });
            pluginRegistry.get.mockReturnValueOnce({
                plugin: { providerName: 'Vercel', name: 'vercel' },
            } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            // Repository was called for: (1) initial INITIALIZING, (2) website URL update, (3) terminal READY state.
            expect(repository.update).toHaveBeenCalledWith('work-1', {
                website: 'https://acme-site.example.com',
            });
            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'READY',
            });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                DeploymentCompletedEvent.EVENT_NAME,
                expect.any(DeploymentCompletedEvent),
            );
            const completedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentCompletedEvent.EVENT_NAME,
            )![1] as InstanceType<typeof DeploymentCompletedEvent>;
            expect((completedEvent as any).payload).toMatchObject({
                userId: 'user-1',
                providerId: 'vercel',
                providerName: 'Vercel',
                url: 'https://acme-site.example.com',
            });

            expect((service as any).queue.has('work-1')).toBe(false);
        });

        it('ERROR → emits DeploymentFailedEvent w/ terminalState ERROR + cleans queue', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'ERROR',
            });
            pluginRegistry.get.mockReturnValueOnce({
                plugin: { providerName: 'Vercel' },
            } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'ERROR',
            });
            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            )![1];
            expect((failedEvent as any).payload.terminalState).toBe('ERROR');
            expect((service as any).queue.has('work-1')).toBe(false);
        });

        it('CANCELED state from provider also terminates with terminalState=CANCELED', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'CANCELED',
            });
            pluginRegistry.get.mockReturnValueOnce({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            )![1];
            expect((failedEvent as any).payload.terminalState).toBe('CANCELED');
        });

        it('not-found path increments fetchTries; FETCH_LIMIT (18) reached → TIMEOUT', async () => {
            // Return not-found 19 times. The 19th call (fetchTries=19 > 18)
            // triggers the cleanup('TIMEOUT') branch.
            deployFacade.lookupExistingDeployment.mockResolvedValue({
                found: false,
            } as any);
            pluginRegistry.get.mockReturnValue({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');

            for (let i = 0; i < FETCH_LIMIT + 1; i++) {
                await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            }

            // Should have fired the TIMEOUT terminal update.
            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'TIMEOUT',
            });
            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            )![1];
            expect((failedEvent as any).payload.terminalState).toBe('TIMEOUT');
        });

        it('intermediate state (BUILDING / QUEUED) updates deploymentState in place but does NOT terminate', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'BUILDING',
            });

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'BUILDING',
            });
            expect(eventEmitter.emit).not.toHaveBeenCalled();
            expect((service as any).queue.has('work-1')).toBe(true);

            // Cleanup the lingering interval to keep the test runner from
            // leaving an orphaned Map entry.
            const cancel = (service as any).queue.get('work-1');
            cancel?.();
        });

        it('lookup throws → emits DeploymentFailedEvent w/ terminalState=ERROR + error.message', async () => {
            deployFacade.lookupExistingDeployment.mockRejectedValueOnce(
                new Error('vercel api 500'),
            );
            pluginRegistry.get.mockReturnValueOnce({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'ERROR',
            });
            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            )![1];
            expect((failedEvent as any).payload).toMatchObject({
                terminalState: 'ERROR',
                error: 'vercel api 500',
            });
        });

        it('lookup throws non-Error → coerces via String() in the error field', async () => {
            deployFacade.lookupExistingDeployment.mockRejectedValueOnce('weird-string-error');
            pluginRegistry.get.mockReturnValueOnce({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            )![1];
            expect((failedEvent as any).payload.error).toBe('weird-string-error');
        });

        it('skips overlapping ticks while the previous lookup is still in-flight', async () => {
            // Make the lookup hang so a second tick can fire while the first
            // is still resolving. Capture the resolver to release later.
            let resolveFirst: (v: any) => void = () => undefined;
            deployFacade.lookupExistingDeployment.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    }),
            );

            await service.startVerification(buildWork() as any, 'user-1');

            // First tick — lookup starts and stays in-flight.
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            // Second tick — should be skipped (inVerification flag set).
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            // Only one lookup call so far.
            expect(deployFacade.lookupExistingDeployment).toHaveBeenCalledTimes(1);

            // Release the in-flight lookup with a not-found result so it doesn't terminate.
            resolveFirst({ found: false });

            // Cleanup queue entry to avoid lingering interval.
            const cancel = (service as any).queue.get('work-1');
            cancel?.();
        });

        it('TIMEOUT triggers when wall-clock elapsed exceeds 13 minutes (TIMEOUT)', async () => {
            // Return found=true with intermediate state forever; the wall-clock
            // limit kicks in at >13 minutes (780_000 ms).
            deployFacade.lookupExistingDeployment.mockResolvedValue({
                found: true,
                deploymentState: 'BUILDING',
            } as any);
            pluginRegistry.get.mockReturnValue({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');

            // Advance exactly 14 minutes worth of ticks (84 ticks * 10s).
            for (let i = 0; i < 84; i++) {
                await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            }

            // Should have terminated with TIMEOUT.
            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            );
            expect(failedEvent).toBeDefined();
            expect((failedEvent![1] as any).payload.terminalState).toBe('TIMEOUT');
        });
    });

    describe('cleanup terminated guard (idempotency)', () => {
        beforeEach(() => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        it('a second cleanup invocation after a terminal state is a no-op (no duplicate event)', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
                website: 'https://x.example.com',
            });
            pluginRegistry.get.mockReturnValueOnce({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            const cancel = (service as any).queue.get('work-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            // After READY, the queue is cleaned up; the cancel closure
            // returned from startVerification should now be a no-op (the
            // `terminated` flag is set to true).
            expect(eventEmitter.emit).toHaveBeenCalledTimes(1);

            // Invoke the original cancel closure — it should be a no-op
            // because terminated=true.
            cancel();

            expect(eventEmitter.emit).toHaveBeenCalledTimes(1); // unchanged
            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining('Skipping duplicate cleanup'),
            );
        });
    });

    describe('emitTerminalEvent — provider name resolution', () => {
        beforeEach(() => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        it('uses plugin.providerName when present', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });
            pluginRegistry.get.mockReturnValueOnce({
                plugin: { providerName: 'Vercel', name: 'vercel-internal' },
            } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const completedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentCompletedEvent.EVENT_NAME,
            )![1];
            expect((completedEvent as any).payload.providerName).toBe('Vercel');
        });

        it('falls back to plugin.name when providerName is missing', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });
            pluginRegistry.get.mockReturnValueOnce({
                plugin: { name: 'vercel-internal' },
            } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const completedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentCompletedEvent.EVENT_NAME,
            )![1];
            expect((completedEvent as any).payload.providerName).toBe('vercel-internal');
        });

        it('falls back to providerId when both providerName and name are missing', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });
            pluginRegistry.get.mockReturnValueOnce({ plugin: {} } as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const completedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentCompletedEvent.EVENT_NAME,
            )![1];
            expect((completedEvent as any).payload.providerName).toBe('vercel');
        });

        it('falls back to providerId when pluginRegistry.get returns null/undefined', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });
            pluginRegistry.get.mockReturnValueOnce(null as any);

            await service.startVerification(buildWork() as any, 'user-1');
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            const completedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentCompletedEvent.EVENT_NAME,
            )![1];
            expect((completedEvent as any).payload.providerName).toBe('vercel');
        });

        it('does NOT emit when work has no deployProvider (silent return)', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });

            await service.startVerification(
                buildWork({ deployProvider: undefined }) as any,
                'user-1',
            );
            await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            // No event emitted — silent return path.
            expect(eventEmitter.emit).not.toHaveBeenCalled();
            // But the repository.update for the terminal state still ran
            // (cleanup happens before emitTerminalEvent's silent return).
            expect(repository.update).toHaveBeenCalledWith('work-1', {
                deploymentState: 'READY',
            });
        });

        it('terminalState is mapped to UNKNOWN for non-(ERROR|TIMEOUT|CANCELED) — defensive', async () => {
            // Reach the non-READY branch by feeding a bogus state. The cleanup
            // function will accept it (the `state` truthiness is what matters
            // for cleanup), but emitTerminalEvent's `terminalState` ternary
            // maps anything outside ERROR/TIMEOUT/CANCELED to 'UNKNOWN'.
            // The interval branch only reaches cleanup() with READY/ERROR/CANCELED
            // or via the wall-clock TIMEOUT — but the `cancelVerification`
            // path passes 'CANCELED' explicitly. To exercise UNKNOWN we
            // call the private cleanup directly with a synthetic state.
            await service.startVerification(buildWork() as any, 'user-1');

            // Reach into the queue to fish out the cancel closure. We can't
            // directly invoke `cleanup` because it's a closure inside
            // verifyDeployment, but emitTerminalEvent itself is on `service`,
            // so call it directly to exercise the fallthrough mapping.
            (service as any).emitTerminalEvent(
                buildWork(),
                'user-1',
                'BUILDING',
                undefined,
                'unexpected',
            );

            // Find the failed event we just emitted.
            const failedEvent = eventEmitter.emit.mock.calls.find(
                (c) => c[0] === DeploymentFailedEvent.EVENT_NAME,
            );
            expect(failedEvent).toBeDefined();
            expect((failedEvent![1] as any).payload.terminalState).toBe('UNKNOWN');

            // Cleanup the lingering interval.
            const cancel = (service as any).queue.get('work-1');
            cancel?.();
        });
    });

    describe('lookupExistingDeployment (standalone passthrough)', () => {
        it('updates repository on found=true with website + deploymentState', async () => {
            const work = buildWork({ deploymentState: 'OLD' });
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                website: 'https://x.example.com',
                deploymentState: 'BUILDING',
            });

            const result = await service.lookupExistingDeployment(work as any, 'user-1');

            expect(deployFacade.lookupExistingDeployment).toHaveBeenCalledWith('acme-site', {
                userId: 'user-1',
                workId: 'work-1',
            });
            expect(repository.update).toHaveBeenCalledWith('work-1', {
                website: 'https://x.example.com',
                deploymentState: 'BUILDING',
            });
            expect(result).toEqual({
                found: true,
                website: 'https://x.example.com',
                deploymentState: 'BUILDING',
            });
        });

        it('found=true with website but no deploymentState → falls back to existing work.deploymentState', async () => {
            const work = buildWork({ deploymentState: 'BUILDING' });
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                website: 'https://x.example.com',
            });

            await service.lookupExistingDeployment(work as any, 'user-1');

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                website: 'https://x.example.com',
                deploymentState: 'BUILDING',
            });
        });

        it('found=true with deploymentState only (no website) → website=undefined', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
                deploymentState: 'READY',
            });

            await service.lookupExistingDeployment(buildWork() as any, 'user-1');

            expect(repository.update).toHaveBeenCalledWith('work-1', {
                website: undefined,
                deploymentState: 'READY',
            });
        });

        it('found=true with NEITHER website NOR deploymentState → no repository.update', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({
                found: true,
            });

            await service.lookupExistingDeployment(buildWork() as any, 'user-1');

            expect(repository.update).not.toHaveBeenCalled();
        });

        it('found=false → no repository.update + returns the result verbatim', async () => {
            deployFacade.lookupExistingDeployment.mockResolvedValueOnce({ found: false });

            const result = await service.lookupExistingDeployment(buildWork() as any, 'user-1');

            expect(repository.update).not.toHaveBeenCalled();
            expect(result).toEqual({ found: false });
        });

        it('facade rejects → swallows error + logs + returns {found:false}', async () => {
            deployFacade.lookupExistingDeployment.mockRejectedValueOnce(new Error('oops'));

            const result = await service.lookupExistingDeployment(buildWork() as any, 'user-1');

            expect(result).toEqual({ found: false });
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to lookup existing deployment for work work-1'),
                expect.any(Error),
            );
        });
    });
});
