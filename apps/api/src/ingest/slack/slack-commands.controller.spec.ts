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

import {
    SLACK_COMMAND_ACK_BUDGET_MS,
    SLACK_COMMAND_ACK_TEXT,
    SLACK_COMMAND_NOT_CONNECTED_TEXT,
    SlackCommandsController,
    slackCommandUsageText,
} from './slack-commands.controller';
import { computeSlackSignature } from './slack-signature.util';

const SECRET = 'test-signing-secret';
const BINDING = {
    userId: 'user-1',
    signingSecret: SECRET,
    settings: { botToken: 'xoxb-test' },
    matchedBy: 'binding' as const,
};

/**
 * A slash command is delivered `application/x-www-form-urlencoded`, so
 * the RAW body the signature covers is the encoded form — not JSON.
 * Express parses it into `req.body` for us; the tests build both halves
 * exactly the way the wire does.
 */
function encodeForm(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
}

function commandFields(overrides: Record<string, string> = {}) {
    return {
        token: 'legacy-verification-token',
        team_id: 'T-AAA',
        team_domain: 'acme',
        channel_id: 'C1',
        channel_name: 'general',
        user_id: 'U7',
        user_name: 'ada',
        command: '/works',
        text: 'what shipped today?',
        response_url: 'https://hooks.slack.com/commands/T-AAA/123/abc',
        trigger_id: '13345224609.738474920.8088930838d88f008e0',
        api_app_id: 'A1',
        ...overrides,
    };
}

describe('SlackCommandsController (POST /api/ingest/slack/commands)', () => {
    function createController() {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue({ status: 'resolved', binding: BINDING }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleSlashCommand: jest.fn().mockResolvedValue({ ingested: null }),
        };
        const controller = new SlackCommandsController(bridge as any);
        return { controller, bridge };
    }

    /** Build a signed slash-command request (fresh timestamp by default). */
    function signedRequest(
        fields: Record<string, string> = commandFields(),
        tsSeconds = Math.floor(Date.now() / 1000),
    ) {
        const rawBody = encodeForm(fields);
        const timestamp = String(tsSeconds);
        const signature = computeSlackSignature(SECRET, timestamp, rawBody);
        return { req: { body: { ...fields }, rawBody }, timestamp, signature, fields };
    }

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, bridge } = createController();
        await expect(
            controller.receiveCommand({ body: {}, rawBody: undefined } as any, 'sig', '123'),
        ).rejects.toThrow(BadRequestException);
        expect(bridge.resolveBinding).not.toHaveBeenCalled();
    });

    describe('signature verification', () => {
        it('ACCEPTS a validly signed command and dispatches it to the chat bridge', async () => {
            const { controller, bridge } = createController();
            const { req, timestamp, signature, fields } = signedRequest();

            const result = await controller.receiveCommand(req as any, signature, timestamp);

            expect(result).toEqual({
                response_type: 'ephemeral',
                text: SLACK_COMMAND_ACK_TEXT,
            });
            expect(bridge.handleSlashCommand).toHaveBeenCalledWith(
                BINDING,
                expect.objectContaining({
                    command: '/works',
                    text: fields.text,
                    channel_id: 'C1',
                    trigger_id: fields.trigger_id,
                }),
            );
        });

        it('REJECTS a bad signature with 401 (and never dispatches)', async () => {
            const { controller, bridge } = createController();
            const { req, timestamp } = signedRequest();

            await expect(
                controller.receiveCommand(req as any, 'v0=deadbeef', timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });

        it('REJECTS a signature computed over a DIFFERENT body (tampered form fields)', async () => {
            const { controller, bridge } = createController();
            // Signature is valid for the original text; the delivered body
            // asks something else. The HMAC covers the raw body, so this
            // must not verify.
            const original = signedRequest();
            const tampered = {
                body: { ...commandFields({ text: 'delete everything' }) },
                rawBody: encodeForm(commandFields({ text: 'delete everything' })),
            };

            await expect(
                controller.receiveCommand(tampered as any, original.signature, original.timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });

        it('REJECTS missing signature headers entirely', async () => {
            const { controller, bridge } = createController();
            const { req } = signedRequest();

            await expect(
                controller.receiveCommand(req as any, undefined, undefined),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });

        it('REJECTS a stale timestamp (>300s skew) even when the digest matches it', async () => {
            const { controller, bridge } = createController();
            const staleTs = Math.floor(Date.now() / 1000) - 301;
            const { req, timestamp, signature } = signedRequest(commandFields(), staleTs);

            await expect(
                controller.receiveCommand(req as any, signature, timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });

        it('fails closed with 401 when no Slack install is configured at all', async () => {
            const { controller, bridge } = createController();
            bridge.resolveBinding.mockResolvedValue({ status: 'not-configured' });
            const { req, timestamp, signature } = signedRequest();

            await expect(
                controller.receiveCommand(req as any, signature, timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });
    });

    /**
     * Slack shows the invoking user `operation_timeout` if the HTTP
     * response has not arrived within 3s, so the receiver must ack while
     * the (unbounded) model call is still running.
     */
    describe('ack budget', () => {
        it('acks immediately while the chat work is still pending', async () => {
            const { controller, bridge } = createController();
            let started = false;
            // A completion that never resolves — exactly the case that
            // would blow the budget if the receiver awaited it.
            bridge.handleSlashCommand.mockImplementation(
                () =>
                    new Promise(() => {
                        started = true;
                    }),
            );
            const { req, timestamp, signature } = signedRequest();

            const startedAt = Date.now();
            const result = await controller.receiveCommand(req as any, signature, timestamp);
            const elapsed = Date.now() - startedAt;

            expect(result.text).toBe(SLACK_COMMAND_ACK_TEXT);
            expect(elapsed).toBeLessThan(SLACK_COMMAND_ACK_BUDGET_MS);
            // Guard against the budget silently being met by doing nothing:
            // the work really was started, it just was not awaited.
            expect(bridge.handleSlashCommand).toHaveBeenCalledTimes(1);
            expect(started).toBe(true);
        });

        it('does not wait on a slow chat leg (ack lands far ahead of the answer)', async () => {
            const { controller, bridge } = createController();
            // Comfortably under Slack's 3s budget but far longer than any
            // scheduling noise on a loaded CI box, so the assertion below
            // can only pass if the ack really did not await the answer.
            const SLOW_MS = 1500;
            let timer: NodeJS.Timeout | undefined;
            bridge.handleSlashCommand.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve({ ingested: null }), SLOW_MS);
                    }),
            );
            const { req, timestamp, signature } = signedRequest();

            const startedAt = Date.now();
            await controller.receiveCommand(req as any, signature, timestamp);

            expect(Date.now() - startedAt).toBeLessThan(SLOW_MS);
            if (timer) clearTimeout(timer);
        });

        it('a detached failure never reaches the ack (Slack still gets its 200)', async () => {
            const { controller, bridge } = createController();
            bridge.handleSlashCommand.mockRejectedValue(new Error('no AI provider configured'));
            const { req, timestamp, signature } = signedRequest();

            await expect(
                controller.receiveCommand(req as any, signature, timestamp),
            ).resolves.toEqual({ response_type: 'ephemeral', text: SLACK_COMMAND_ACK_TEXT });
            // Let the rejected promise settle — an unhandled rejection here
            // would crash the process in production.
            await new Promise((resolve) => setImmediate(resolve));
        });

        it('a SYNCHRONOUS throw from the bridge is contained too', async () => {
            const { controller, bridge } = createController();
            bridge.handleSlashCommand.mockImplementation(() => {
                throw new Error('boom');
            });
            const { req, timestamp, signature } = signedRequest();

            await expect(
                controller.receiveCommand(req as any, signature, timestamp),
            ).resolves.toEqual({ response_type: 'ephemeral', text: SLACK_COMMAND_ACK_TEXT });
            await new Promise((resolve) => setImmediate(resolve));
        });
    });

    describe('per-workspace binding', () => {
        it('passes the delivery workspace + a signature probe to the SHARED resolver', async () => {
            const { controller, bridge } = createController();
            const { req, timestamp, signature } = signedRequest(
                commandFields({ team_id: 'T-AAA', enterprise_id: 'E-ONE' }),
            );

            await controller.receiveCommand(req as any, signature, timestamp);

            const lookup = bridge.resolveBinding.mock.calls[0][0];
            expect(lookup.workspace).toEqual({ teamId: 'T-AAA', enterpriseId: 'E-ONE' });
            expect(lookup.verifySignature(SECRET)).toBe(true);
            expect(lookup.verifySignature('someone-elses-secret')).toBe(false);
        });

        it('tells the user when the workspace is not connected — no guess, no 500', async () => {
            const { controller, bridge } = createController();
            bridge.resolveBinding.mockResolvedValue({
                status: 'unresolved',
                reason: 'unknown-workspace',
            });
            const { req, timestamp, signature } = signedRequest(
                commandFields({ team_id: 'T-STRANGER' }),
            );

            const result = await controller.receiveCommand(req as any, signature, timestamp);

            expect(result).toEqual({
                response_type: 'ephemeral',
                text: SLACK_COMMAND_NOT_CONNECTED_TEXT,
            });
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('records the binding only after the signature verified', async () => {
            const { controller, bridge } = createController();

            const bad = signedRequest();
            await expect(
                controller.receiveCommand(bad.req as any, 'v0=deadbeef', bad.timestamp),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.recordBinding).not.toHaveBeenCalled();

            const good = signedRequest();
            await controller.receiveCommand(good.req as any, good.signature, good.timestamp);
            expect(bridge.recordBinding).toHaveBeenCalledWith(BINDING);
        });
    });

    describe('usage hint', () => {
        it('answers a bare command with usage instead of an empty prompt', async () => {
            const { controller, bridge } = createController();
            const { req, timestamp, signature } = signedRequest(commandFields({ text: '   ' }));

            const result = await controller.receiveCommand(req as any, signature, timestamp);

            expect(result.response_type).toBe('ephemeral');
            expect(result.text).toContain('/works');
            expect(bridge.handleSlashCommand).not.toHaveBeenCalled();
        });

        it('never echoes an attacker-controlled command name back into the hint', () => {
            expect(slackCommandUsageText('/works')).toContain('/works');
            expect(slackCommandUsageText('/ever-ai')).toContain('/ever-ai');
            // Anything that is not a real Slack command name degrades to the
            // default rather than being rendered verbatim.
            expect(slackCommandUsageText('<script>alert(1)</script>')).not.toContain('script');
            expect(slackCommandUsageText('/a b')).toContain('/works');
            expect(slackCommandUsageText(undefined)).toContain('/works');
        });
    });
});
