import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { GitHubEventsController } from './github-events.controller';
import { GitHubWebhookDispatcherService } from './github-webhook-dispatcher.service';
import { computeGitHubSignature } from './github-signature.util';

const SECRET = 'test-webhook-secret';
const BINDING = { userId: 'user-1', webhookSecret: SECRET, matchedBy: 'binding' as const };

/**
 * Regression pin for the CANONICAL route after the receiver
 * consolidation. Every assertion below existed before the merge and must
 * keep holding: the controller is now a thin shell over
 * `GitHubWebhookDispatcherService`, so the dispatcher is built for real
 * here (with fake consumers) rather than mocked — a shell that no longer
 * reaches the shared receiver would otherwise pass a mocked spec.
 */
describe('GitHubEventsController (POST /api/ingest/github/events)', () => {
    const originalAppSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    beforeEach(() => {
        // No platform GitHub App configured — the pre-consolidation
        // per-install path, byte for byte.
        delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    });

    afterEach(() => {
        if (originalAppSecret === undefined) {
            delete process.env.GITHUB_APP_WEBHOOK_SECRET;
        } else {
            process.env.GITHUB_APP_WEBHOOK_SECRET = originalAppSecret;
        }
    });

    function createController() {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue({ status: 'resolved', binding: BINDING }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleEvent: jest.fn().mockResolvedValue({ ingested: null }),
            installBindingFor: jest.fn().mockResolvedValue(null),
        };
        const appSync = { handleWebhook: jest.fn().mockResolvedValue(undefined) };
        const dispatcher = new GitHubWebhookDispatcherService(
            bridge as never,
            appSync as never,
            { findByInstallationId: jest.fn().mockResolvedValue(null) } as never,
            { findByGithubUserId: jest.fn().mockResolvedValue(null) } as never,
        );
        const controller = new GitHubEventsController(dispatcher);
        return { controller, bridge, appSync };
    }

    /** Build a signed request for `bodyObj`. */
    function signedRequest(bodyObj: unknown) {
        const rawBody = JSON.stringify(bodyObj);
        const signature = computeGitHubSignature(SECRET, rawBody);
        return { req: { body: bodyObj, rawBody }, signature };
    }

    it('throws BadRequestException when the event header is missing', async () => {
        const { controller, bridge } = createController();
        await expect(
            controller.receiveEvents({ body: {}, rawBody: '{}' } as never, 'sig', undefined),
        ).rejects.toThrow(BadRequestException);
        expect(bridge.resolveBinding).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, bridge } = createController();
        await expect(
            controller.receiveEvents(
                { body: {}, rawBody: undefined } as never,
                'sig',
                'pull_request',
            ),
        ).rejects.toThrow(BadRequestException);
        expect(bridge.resolveBinding).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when no binding is configured — even for ping', async () => {
        const { controller, bridge } = createController();
        bridge.resolveBinding.mockResolvedValue({ status: 'not-configured' });
        const { req, signature } = signedRequest({ zen: 'Keep it logically awesome.' });
        await expect(controller.receiveEvents(req as never, signature, 'ping')).rejects.toThrow(
            UnauthorizedException,
        );
        await expect(controller.receiveEvents(req as never, signature, 'ping')).rejects.toThrow(
            'not configured',
        );
        expect(bridge.handleEvent).not.toHaveBeenCalled();
    });

    it('rejects a bad signature with 401 (and never dispatches)', async () => {
        const { controller, bridge } = createController();
        const { req } = signedRequest({ action: 'opened' });
        await expect(
            controller.receiveEvents(req as never, 'sha256=deadbeef', 'pull_request'),
        ).rejects.toThrow(UnauthorizedException);
        expect(bridge.handleEvent).not.toHaveBeenCalled();
    });

    it('acknowledges a validly signed ping without dispatching', async () => {
        const { controller, bridge } = createController();
        const { req, signature } = signedRequest({ zen: 'Design for failure.' });
        const result = await controller.receiveEvents(req as never, signature, 'ping');
        expect(result).toEqual({ ok: true });
        expect(bridge.handleEvent).not.toHaveBeenCalled();
    });

    it('dispatches a verified pull_request delivery to the bridge', async () => {
        const { controller, bridge } = createController();
        const body = {
            action: 'opened',
            repository: { full_name: 'octo/site' },
            pull_request: { number: 7, title: 'Add page', head: { sha: 'abc' } },
        };
        const { req, signature } = signedRequest(body);
        const result = await controller.receiveEvents(req as never, signature, 'pull_request');
        expect(result).toEqual({ ok: true });
        expect(bridge.handleEvent).toHaveBeenCalledWith(BINDING, 'pull_request', body);
    });

    /**
     * Per-installation routing: the delivery's `installation.id` (or
     * repository owner) selects WHICH install's webhook secret verifies
     * it, and an unresolvable installation is a clean no-op rather than a
     * guess or a 500.
     */
    describe('per-installation binding', () => {
        it('passes the delivery installation + a signature probe to the resolver', async () => {
            const { controller, bridge } = createController();
            const { req, signature } = signedRequest({
                action: 'opened',
                installation: { id: 99 },
                repository: { full_name: 'octo/site' },
            });

            await controller.receiveEvents(req as never, signature, 'pull_request');

            const lookup = bridge.resolveBinding.mock.calls[0][0];
            expect(lookup.workspace).toEqual({
                keys: ['installation:99', 'owner:octo'],
                label: 'octo',
            });
            expect(lookup.verifySignature(SECRET)).toBe(true);
            expect(lookup.verifySignature('someone-elses-secret')).toBe(false);
        });

        it('refuses an unresolvable installation as a 200 no-op — never a 500, never a guess', async () => {
            const { controller, bridge } = createController();
            bridge.resolveBinding.mockResolvedValue({
                status: 'unresolved',
                reason: 'unknown-workspace',
            });
            const { req, signature } = signedRequest({
                action: 'opened',
                repository: { full_name: 'stranger/site' },
            });

            const result = await controller.receiveEvents(req as never, signature, 'pull_request');

            expect(result).toEqual({ ok: true, ignored: 'unknown-workspace' });
            expect(bridge.handleEvent).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('records the binding only after the signature verified', async () => {
            const { controller, bridge } = createController();
            const body = { action: 'opened', repository: { full_name: 'octo/site' } };

            const bad = signedRequest(body);
            await expect(
                controller.receiveEvents(bad.req as never, 'sha256=deadbeef', 'pull_request'),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.recordBinding).not.toHaveBeenCalled();

            const good = signedRequest(body);
            await controller.receiveEvents(good.req as never, good.signature, 'pull_request');
            expect(bridge.recordBinding).toHaveBeenCalledWith(BINDING);
        });
    });

    /**
     * The consolidation adds the App-sync consumer to THIS route. It must
     * not become a new way for the route to 500.
     */
    describe('shared fan-out, per-route failure contract', () => {
        it('also runs the GitHub App sync leg on a verified delivery', async () => {
            const { controller, appSync } = createController();
            const body = { action: 'opened', repository: { full_name: 'octo/site' } };
            const { req, signature } = signedRequest(body);

            await controller.receiveEvents(req as never, signature, 'pull_request');

            expect(appSync.handleWebhook).toHaveBeenCalledWith('pull_request', body);
        });

        it('never 500s this route for an App-sync failure (new consumer, logged not thrown)', async () => {
            const { controller, appSync, bridge } = createController();
            appSync.handleWebhook.mockRejectedValue(new Error('installation sync exploded'));
            const { req, signature } = signedRequest({
                action: 'opened',
                repository: { full_name: 'octo/site' },
            });

            await expect(
                controller.receiveEvents(req as never, signature, 'pull_request'),
            ).resolves.toEqual({ ok: true });
            expect(bridge.handleEvent).toHaveBeenCalled();
        });

        it('still surfaces an ingest/review failure, as it always did', async () => {
            const { controller, bridge } = createController();
            bridge.handleEvent.mockRejectedValue(new Error('ingest exploded'));
            const { req, signature } = signedRequest({
                action: 'opened',
                repository: { full_name: 'octo/site' },
            });

            await expect(
                controller.receiveEvents(req as never, signature, 'pull_request'),
            ).rejects.toThrow('ingest exploded');
        });
    });
});
