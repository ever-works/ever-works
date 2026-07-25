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
    GitHubPrReviewBridgeService,
    type GitHubWebhookBody,
} from './github-pr-review-bridge.service';
import { verifyGitHubSignature } from './github-signature.util';

/**
 * GitHub events receiver (Wave 7, feature g) — the platform-side
 * endpoint a user-configured GitHub webhook points at for the PR
 * review loop (`pull_request` opened/synchronize, `@ever-works`
 * mentions on PR comments).
 *
 * Public route (GitHub calls it), secured by request signing instead
 * of platform auth: every delivery is verified with the configured
 * webhook secret (HMAC SHA-256 over the raw body, constant-time
 * compare) and the endpoint FAILS CLOSED — when no github-plugin
 * install with a `webhookSecret` exists, everything is 401 (house
 * internal-endpoint posture, same as the Slack receiver next door).
 *
 * Body handling mirrors `SlackEventsController`: the raw payload
 * (captured by the bodyParser `verify` hook in main.ts) feeds
 * signature verification; the parsed body is consumed as-is,
 * bypassing the global whitelist ValidationPipe (GitHub's event
 * schema is theirs, not ours).
 *
 * Distinct from the platform GitHub App webhook
 * (`/api/github-app/webhooks`, app-level secret, install/push sync):
 * this receiver is the per-user review-loop surface. Consolidating
 * the two behind one dispatch is a documented follow-up.
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class GitHubEventsController {
    constructor(private readonly bridge: GitHubPrReviewBridgeService) {}

    @Public()
    @Post('github/events')
    @ApiOperation({
        summary:
            'GitHub webhook receiver — signature-verified; PR opened/synchronize + @ever-works mention ingest, AI review trigger.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveEvents(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('x-hub-signature-256') signature: string | undefined,
        @Headers('x-github-event') eventName: string | undefined,
    ) {
        if (!eventName) {
            throw new BadRequestException('Missing GitHub event header');
        }
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        // Fail-closed: no configured binding → no secret → reject,
        // including the initial `ping` (GitHub signs that too).
        const binding = await this.bridge.resolveBinding();
        if (!binding) {
            throw new UnauthorizedException('GitHub events receiver is not configured');
        }

        const verdict = verifyGitHubSignature({
            rawBody: req.rawBody,
            signature,
            webhookSecret: binding.webhookSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException('Invalid GitHub webhook signature');
        }

        // Webhook-creation handshake — acknowledge without dispatching.
        if (eventName === 'ping') {
            return { ok: true };
        }

        await this.bridge.handleEvent(binding, eventName, (req.body ?? {}) as GitHubWebhookBody);

        return { ok: true };
    }
}
