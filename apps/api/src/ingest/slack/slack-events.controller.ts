import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { SlackChatBridgeService, type SlackEventCallbackBody } from './slack-chat-bridge.service';
import { verifySlackSignature } from './slack-signature.util';

/**
 * Slack Events API receiver (Wave 6, feature f) — the platform-side
 * endpoint the Ever Works Slack app points its event subscription at.
 *
 * Public route (Slack calls it), secured by request signing instead of
 * platform auth: every delivery is verified with the app's signing
 * secret (HMAC v0 over `v0:{ts}:{rawBody}`, ±300s timestamp tolerance,
 * constant-time compare) and the endpoint FAILS CLOSED — when no
 * slack-connector install with a signing secret exists, everything is
 * 401 (house internal-endpoint posture, same as the GitHub App webhook).
 *
 * Body handling mirrors `GitHubAppWebhookController`: the raw payload
 * (captured by the bodyParser `verify` hook in main.ts) feeds signature
 * verification; the parsed body is consumed as-is, bypassing the global
 * whitelist ValidationPipe (Slack's event schema is theirs, not ours).
 *
 * Per-user resolution is the v1 binding — the user who configured the
 * plugin owns the events (multi-workspace mapping is a documented
 * follow-up on `SlackEventsBinding`).
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class SlackEventsController {
    constructor(private readonly slackChatBridge: SlackChatBridgeService) {}

    @Public()
    @Post('slack/events')
    @ApiOperation({
        summary:
            'Slack Events API receiver — signature-verified; challenge echo, mention/message ingest, @works chat bridge.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveEvents(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('x-slack-signature') signature: string | undefined,
        @Headers('x-slack-request-timestamp') timestamp: string | undefined,
    ) {
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        // Fail-closed: no configured binding → no secret → reject, including
        // url_verification (Slack signs the handshake too).
        const binding = await this.slackChatBridge.resolveBinding();
        if (!binding) {
            throw new UnauthorizedException('Slack events receiver is not configured');
        }

        const verdict = verifySlackSignature({
            rawBody: req.rawBody,
            timestamp,
            signature,
            signingSecret: binding.signingSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException('Invalid Slack request signature');
        }

        const body = (req.body ?? {}) as SlackEventCallbackBody & { challenge?: string };

        // Events API URL-verification handshake — echo the challenge.
        if (body.type === 'url_verification' && typeof body.challenge === 'string') {
            return { challenge: body.challenge };
        }

        if (body.type === 'event_callback') {
            await this.slackChatBridge.handleEventCallback(binding, body);
        }

        return { ok: true };
    }
}
