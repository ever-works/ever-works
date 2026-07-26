import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('../../ai-conversation/openai-compat.service', () => ({
    OpenAiCompatService: class {},
}));
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { SlackEventsController } from './slack-events.controller';
import { computeSlackSignature } from './slack-signature.util';

const SECRET = 'test-signing-secret';
const BINDING = {
    userId: 'user-1',
    signingSecret: SECRET,
    settings: { botToken: 'xoxb-test' },
    matchedBy: 'binding' as const,
};

describe('SlackEventsController (POST /api/ingest/slack/events)', () => {
    function createController() {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue({ status: 'resolved', binding: BINDING }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleEventCallback: jest.fn().mockResolvedValue({ ingested: null }),
        };
        const controller = new SlackEventsController(bridge as any);
        return { controller, bridge };
    }

    /** Build a signed request for `bodyObj` (fresh timestamp by default). */
    function signedRequest(bodyObj: unknown, tsSeconds = Math.floor(Date.now() / 1000)) {
        const rawBody = JSON.stringify(bodyObj);
        const timestamp = String(tsSeconds);
        const signature = computeSlackSignature(SECRET, timestamp, rawBody);
        return { req: { body: bodyObj, rawBody }, timestamp, signature };
    }

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, bridge } = createController();
        await expect(
            controller.receiveEvents({ body: {}, rawBody: undefined } as any, 'sig', '123'),
        ).rejects.toThrow(BadRequestException);
        expect(bridge.resolveBinding).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when no binding is configured — even for url_verification', async () => {
        const { controller, bridge } = createController();
        bridge.resolveBinding.mockResolvedValue({ status: 'not-configured' });
        const { req, timestamp, signature } = signedRequest({
            type: 'url_verification',
            challenge: 'abc',
        });
        await expect(controller.receiveEvents(req as any, signature, timestamp)).rejects.toThrow(
            UnauthorizedException,
        );
        await expect(controller.receiveEvents(req as any, signature, timestamp)).rejects.toThrow(
            'not configured',
        );
        expect(bridge.handleEventCallback).not.toHaveBeenCalled();
    });

    it('rejects a bad signature with 401 (and never dispatches)', async () => {
        const { controller, bridge } = createController();
        const { req, timestamp } = signedRequest({ type: 'event_callback', event: {} });
        await expect(
            controller.receiveEvents(req as any, 'v0=deadbeef', timestamp),
        ).rejects.toThrow(UnauthorizedException);
        expect(bridge.handleEventCallback).not.toHaveBeenCalled();
    });

    it('rejects a stale timestamp (>300s skew) even when the digest matches it', async () => {
        const { controller, bridge } = createController();
        const staleTs = Math.floor(Date.now() / 1000) - 301;
        const { req, timestamp, signature } = signedRequest(
            { type: 'event_callback', event: {} },
            staleTs,
        );
        await expect(controller.receiveEvents(req as any, signature, timestamp)).rejects.toThrow(
            UnauthorizedException,
        );
        expect(bridge.handleEventCallback).not.toHaveBeenCalled();
    });

    it('echoes the url_verification challenge on a validly signed handshake', async () => {
        const { controller, bridge } = createController();
        const { req, timestamp, signature } = signedRequest({
            type: 'url_verification',
            challenge: 'challenge-token-42',
        });
        const result = await controller.receiveEvents(req as any, signature, timestamp);
        expect(result).toEqual({ challenge: 'challenge-token-42' });
        expect(bridge.handleEventCallback).not.toHaveBeenCalled();
    });

    it('dispatches a verified event_callback (app_mention) to the chat bridge', async () => {
        const { controller, bridge } = createController();
        const body = {
            type: 'event_callback',
            event_id: 'Ev1',
            event: {
                type: 'app_mention',
                user: 'U7',
                text: '<@UBOT> status?',
                channel: 'C1',
                ts: '1700000000.000100',
            },
        };
        const { req, timestamp, signature } = signedRequest(body);
        const result = await controller.receiveEvents(req as any, signature, timestamp);
        expect(result).toEqual({ ok: true });
        expect(bridge.handleEventCallback).toHaveBeenCalledWith(BINDING, body);
    });

    it('acknowledges unknown (but validly signed) payload types without dispatching', async () => {
        const { controller, bridge } = createController();
        const { req, timestamp, signature } = signedRequest({ type: 'app_rate_limited' });
        const result = await controller.receiveEvents(req as any, signature, timestamp);
        expect(result).toEqual({ ok: true });
        expect(bridge.handleEventCallback).not.toHaveBeenCalled();
    });

    /**
     * Per-workspace routing: the delivery's `team_id` selects WHICH
     * install's signing secret verifies it, and an unresolvable workspace
     * is a clean no-op rather than a guess or a 500.
     */
    describe('per-workspace binding', () => {
        it('passes the delivery workspace + a signature probe to the resolver', async () => {
            const { controller, bridge } = createController();
            const { req, timestamp, signature } = signedRequest({
                type: 'event_callback',
                team_id: 'T-AAA',
                enterprise_id: 'E-ONE',
                event: { type: 'message', channel: 'C1', ts: '1.0' },
            });

            await controller.receiveEvents(req as any, signature, timestamp);

            const lookup = bridge.resolveBinding.mock.calls[0][0];
            expect(lookup.workspace).toEqual({ teamId: 'T-AAA', enterpriseId: 'E-ONE' });
            // The probe must accept the real secret and reject any other.
            expect(lookup.verifySignature(SECRET)).toBe(true);
            expect(lookup.verifySignature('someone-elses-secret')).toBe(false);
        });

        it('refuses an unresolvable workspace as a 200 no-op — never a 500, never a guess', async () => {
            const { controller, bridge } = createController();
            bridge.resolveBinding.mockResolvedValue({
                status: 'unresolved',
                reason: 'unknown-workspace',
            });
            const { req, timestamp, signature } = signedRequest({
                type: 'event_callback',
                team_id: 'T-STRANGER',
                event: { type: 'app_mention', channel: 'C1', ts: '1.0' },
            });

            const result = await controller.receiveEvents(req as any, signature, timestamp);

            expect(result).toEqual({ ok: true, ignored: 'unknown-workspace' });
            expect(bridge.handleEventCallback).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('records the binding only after the signature verified', async () => {
            const { controller, bridge } = createController();
            const body = {
                type: 'event_callback',
                team_id: 'T-AAA',
                event: { type: 'message', channel: 'C1', ts: '1.0' },
            };

            // Bad signature → 401 and nothing recorded.
            const bad = signedRequest(body);
            await expect(
                controller.receiveEvents(bad.req as any, 'v0=deadbeef', bad.timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.recordBinding).not.toHaveBeenCalled();

            // Good signature → recorded.
            const good = signedRequest(body);
            await controller.receiveEvents(good.req as any, good.signature, good.timestamp);
            expect(bridge.recordBinding).toHaveBeenCalledWith(BINDING);
        });
    });
});
