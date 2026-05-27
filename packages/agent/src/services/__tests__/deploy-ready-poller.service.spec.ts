import { DeployReadyPollerService } from '../deploy-ready-poller.service';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

/**
 * EW-617 G8 — DeployReadyPollerService unit tests. Verifies the happy
 * path (healthy 200 response → state flipped to READY + funnel event
 * emitted) and that emit is gated on the persisted correlationId.
 */
describe('DeployReadyPollerService.pollOnce', () => {
    const NOW = new Date('2026-05-15T10:05:00.000Z');
    const STARTED_AT = new Date('2026-05-15T10:00:00.000Z');

    const buildService = (
        works: Array<Partial<Record<string, unknown>>>,
        fetchImpl: typeof fetch,
    ) => {
        const workRepository = {
            findByDeploymentStates: jest.fn().mockResolvedValue(works),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const funnel = { emit: jest.fn() };
        const service = new DeployReadyPollerService(workRepository as never, funnel as never);
        return { service, workRepository, funnel, fetchImpl };
    };

    it('marks a healthy work as READY and emits deploy_ready funnel event', async () => {
        const work = {
            id: 'w-1',
            slug: 'my-site',
            deploymentStartedAt: STARTED_AT,
            lastDeployCorrelationId: 'corr-abc123-uuid',
        };
        const httpFetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
        const { service, workRepository, funnel } = buildService([work], httpFetch);

        const summary = await service.pollOnce({
            fetch: httpFetch,
            now: () => NOW,
            domain: 'ever.works',
        });

        expect(summary).toEqual({ scanned: 1, ready: 1, stillPending: 0, failed: 0 });
        expect(workRepository.update).toHaveBeenCalledWith('w-1', { deploymentState: 'READY' });
        expect(funnel.emit).toHaveBeenCalledTimes(1);
        const payload = funnel.emit.mock.calls[0][0];
        expect(payload.event).toBe(ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_READY);
        expect(payload.funnelStep).toBe(7);
        expect(payload.correlationId).toBe('corr-abc123-uuid');
        expect(payload.workId).toBe('w-1');
        expect(payload.websiteUrl).toBe('https://my-site.ever.works');
        expect(payload.elapsedMs).toBe(NOW.getTime() - STARTED_AT.getTime());
    });

    it('flips state to READY but skips emit when lastDeployCorrelationId is absent', async () => {
        const work = {
            id: 'w-2',
            slug: 'other-site',
            deploymentStartedAt: STARTED_AT,
            lastDeployCorrelationId: null,
        };
        const httpFetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
        const { service, workRepository, funnel } = buildService([work], httpFetch);

        await service.pollOnce({ fetch: httpFetch, now: () => NOW, domain: 'ever.works' });

        expect(workRepository.update).toHaveBeenCalledWith('w-2', { deploymentState: 'READY' });
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    it('leaves the row alone and counts stillPending when the health probe returns non-200', async () => {
        const work = {
            id: 'w-3',
            slug: 'slow-site',
            deploymentStartedAt: STARTED_AT,
            lastDeployCorrelationId: 'corr-x',
        };
        const httpFetch = jest.fn().mockResolvedValue({ status: 503 }) as unknown as typeof fetch;
        const { service, workRepository, funnel } = buildService([work], httpFetch);

        const summary = await service.pollOnce({ fetch: httpFetch, now: () => NOW, domain: 'ever.works' });

        expect(summary).toEqual({ scanned: 1, ready: 0, stillPending: 1, failed: 0 });
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(funnel.emit).not.toHaveBeenCalled();
    });
});
