import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({ EventIngestService: class {} }));
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
const BINDING = { userId: 'user-1', webhookSecret: SECRET };

describe('GitHubEventsController (POST /api/ingest/github/events)', () => {
    function createController() {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue(BINDING),
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
        bridge.resolveBinding.mockResolvedValue(null);
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
});
