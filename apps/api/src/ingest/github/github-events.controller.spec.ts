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
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { GitHubEventsController } from './github-events.controller';
import { computeGitHubSignature } from './github-signature.util';

const SECRET = 'test-webhook-secret';
const BINDING = { userId: 'user-1', webhookSecret: SECRET, matchedBy: 'binding' as const };

describe('GitHubEventsController (POST /api/ingest/github/events)', () => {
    function createController() {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue({ status: 'resolved', binding: BINDING }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleEvent: jest.fn().mockResolvedValue({ ingested: null }),
        };
        const controller = new GitHubEventsController(bridge as any);
        return { controller, bridge };
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
            controller.receiveEvents({ body: {}, rawBody: '{}' } as any, 'sig', undefined),
        ).rejects.toThrow(BadRequestException);
        expect(bridge.resolveBinding).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, bridge } = createController();
        await expect(
            controller.receiveEvents(
                { body: {}, rawBody: undefined } as any,
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
        await expect(controller.receiveEvents(req as any, signature, 'ping')).rejects.toThrow(
            UnauthorizedException,
        );
        await expect(controller.receiveEvents(req as any, signature, 'ping')).rejects.toThrow(
            'not configured',
        );
        expect(bridge.handleEvent).not.toHaveBeenCalled();
    });

    it('rejects a bad signature with 401 (and never dispatches)', async () => {
        const { controller, bridge } = createController();
        const { req } = signedRequest({ action: 'opened' });
        await expect(
            controller.receiveEvents(req as any, 'sha256=deadbeef', 'pull_request'),
        ).rejects.toThrow(UnauthorizedException);
        expect(bridge.handleEvent).not.toHaveBeenCalled();
    });

    it('acknowledges a validly signed ping without dispatching', async () => {
        const { controller, bridge } = createController();
        const { req, signature } = signedRequest({ zen: 'Design for failure.' });
        const result = await controller.receiveEvents(req as any, signature, 'ping');
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
        const result = await controller.receiveEvents(req as any, signature, 'pull_request');
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

            await controller.receiveEvents(req as any, signature, 'pull_request');

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

            const result = await controller.receiveEvents(req as any, signature, 'pull_request');

            expect(result).toEqual({ ok: true, ignored: 'unknown-workspace' });
            expect(bridge.handleEvent).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('records the binding only after the signature verified', async () => {
            const { controller, bridge } = createController();
            const body = { action: 'opened', repository: { full_name: 'octo/site' } };

            const bad = signedRequest(body);
            await expect(
                controller.receiveEvents(bad.req as any, 'sha256=deadbeef', 'pull_request'),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.recordBinding).not.toHaveBeenCalled();

            const good = signedRequest(body);
            await controller.receiveEvents(good.req as any, good.signature, 'pull_request');
            expect(bridge.recordBinding).toHaveBeenCalledWith(BINDING);
        });
    });
});
