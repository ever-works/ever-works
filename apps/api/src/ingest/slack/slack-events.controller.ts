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
import {
    SlackChatBridgeService,
    extractSlackWorkspaceRef,
    type SlackEventCallbackBody,
} from './slack-chat-bridge.service';
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
 * Per-user resolution is PER WORKSPACE: the delivery's `team_id` (plus
 * `enterprise_id` on Grid) selects the platform user bound to that Slack
 * workspace, so two customers' workspaces never cross-attribute. The
 * workspace id is read from the not-yet-verified body, which is safe
 * because it only SELECTS which install's signing secret to verify
 * against — a forged `team_id` picks a secret that fails the HMAC.
 *
 * An unknown or ambiguous workspace is REFUSED rather than guessed, and
 * the refusal is a clean no-op (warn log, 200, nothing ingested) — never
 * a 500. Only "no install configured at all" and "bad signature" are
 * 401s, preserving the fail-closed posture.
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

        const rawBody = req.rawBody;
        const body = (req.body ?? {}) as SlackEventCallbackBody & { challenge?: string };

        // Resolve WHICH install owns this workspace before verifying, so
        // the right signing secret is used. The workspace ref comes from
        // the unverified body and only selects a candidate secret — a
        // forged team_id picks a secret that fails the HMAC below.
        const resolution = await this.slackChatBridge.resolveBinding({
            workspace: extractSlackWorkspaceRef(body),
            verifySignature: (signingSecret) =>
                verifySlackSignature({ rawBody, timestamp, signature, signingSecret }).valid,
        });

        // Fail-closed: nothing configured → reject, including
        // url_verification (Slack signs the handshake too).
        if (resolution.status === 'not-configured') {
            throw new UnauthorizedException('Slack events receiver is not configured');
        }
        // Unknown/ambiguous workspace → clean no-op. The bridge already
        // logged the refusal; 200 so Slack does not retry a delivery we
        // will never be able to attribute.
        if (resolution.status === 'unresolved') {
            return { ok: true, ignored: resolution.reason };
        }

        const binding = resolution.binding;

        const verdict = verifySlackSignature({
            rawBody,
            timestamp,
            signature,
            signingSecret: binding.signingSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException('Invalid Slack request signature');
        }

        // Verified — persist the workspace→user binding so subsequent
        // deliveries resolve exactly instead of through the fallback.
        await this.slackChatBridge.recordBinding(binding);

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
