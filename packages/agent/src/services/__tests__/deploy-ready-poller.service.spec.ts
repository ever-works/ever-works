import { DeployReadyPollerService } from '../deploy-ready-poller.service';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

/**
 * EW-617 G8 — DeployReadyPollerService unit tests. Verifies the happy
 * path (healthy 200 response → state flipped to READY + funnel event
 * emitted) and that emit is gated on the persisted correlationId.
 *
 * Also pins the two defects fixed alongside spec `038-k8s-deploy-probes`:
 *  - the probe path must be `/api/health` (there is no `/api/healthz`
 *    route in this repo — probing it 404s, so nothing ever goes READY);
 *  - the probe host must come from the ingress host template, so dev
 *    (`{slug}-dev.ever.works`) does not probe production hostnames.
 */
describe('DeployReadyPollerService.pollOnce', () => {
    const NOW = new Date('2026-05-15T10:05:00.000Z');
    const STARTED_AT = new Date('2026-05-15T10:00:00.000Z');

    const ENV_KEYS = ['EVER_WORKS_DOMAIN', 'EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        // The service reads these at call time; isolate each test from the
        // ambient environment so results don't depend on the dev machine/CI.
        for (const k of ENV_KEYS) {
            savedEnv[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

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
        // Regression: must be `/api/health`. `/api/healthz` does not exist
        // on the deployed template and 404s → work never reaches READY.
        expect(httpFetch).toHaveBeenCalledWith(
            'https://my-site.ever.works/api/health',
            expect.objectContaining({ method: 'GET' }),
        );
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

        const summary = await service.pollOnce({
            fetch: httpFetch,
            now: () => NOW,
            domain: 'ever.works',
        });

        expect(summary).toEqual({ scanned: 1, ready: 0, stillPending: 1, failed: 0 });
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    describe('host resolution', () => {
        const work = {
            id: 'w-4',
            slug: 'acme',
            deploymentStartedAt: STARTED_AT,
            lastDeployCorrelationId: 'corr-h',
        };

        const runWith = async (
            options: Parameters<DeployReadyPollerService['pollOnce']>[0] = {},
        ) => {
            const httpFetch = jest
                .fn()
                .mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
            const { service, funnel } = buildService([work], httpFetch);
            const summary = await service.pollOnce({
                fetch: httpFetch,
                now: () => NOW,
                ...options,
            });
            return { httpFetch, funnel, summary };
        };

        it('derives the probe host from EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE', async () => {
            // Dev's template. The legacy `{slug}.${domain}` form could never
            // produce this, so dev used to have no way to probe its own
            // sites without pointing at production.
            process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE = '{slug}-dev.ever.works';

            const { httpFetch, funnel } = await runWith();

            expect(httpFetch).toHaveBeenCalledWith(
                'https://acme-dev.ever.works/api/health',
                expect.objectContaining({ method: 'GET' }),
            );
            expect(funnel.emit.mock.calls[0][0].websiteUrl).toBe('https://acme-dev.ever.works');
        });

        it('prefers the host template over EVER_WORKS_DOMAIN', async () => {
            // Prod carries BOTH; the template is authoritative. Guards against
            // dev accidentally probing prod when both happen to be set.
            process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE = '{slug}-dev.ever.works';
            process.env.EVER_WORKS_DOMAIN = 'ever.works';

            const { httpFetch } = await runWith();

            expect(httpFetch).toHaveBeenCalledWith(
                'https://acme-dev.ever.works/api/health',
                expect.anything(),
            );
        });

        it('falls back to {slug}.<domain> when no template is configured', async () => {
            process.env.EVER_WORKS_DOMAIN = 'ever.works';

            const { httpFetch } = await runWith();

            expect(httpFetch).toHaveBeenCalledWith(
                'https://acme.ever.works/api/health',
                expect.anything(),
            );
        });

        it('throws when neither template nor domain is configured', async () => {
            const httpFetch = jest
                .fn()
                .mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
            const { service } = buildService([work], httpFetch);

            await expect(service.pollOnce({ fetch: httpFetch, now: () => NOW })).rejects.toThrow(
                /host not configured/,
            );
            expect(httpFetch).not.toHaveBeenCalled();
        });

        it('counts a work as failed when the template yields an invalid host', async () => {
            // SSRF guard: an operator-supplied template must not be able to
            // point the probe at an arbitrary host/path.
            process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE = 'evil.com/{slug}';

            const { httpFetch, summary } = await runWith();

            expect(summary).toEqual({ scanned: 1, ready: 0, stillPending: 0, failed: 1 });
            expect(httpFetch).not.toHaveBeenCalled();
        });
    });
});
