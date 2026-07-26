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
    extractGitHubWorkspaceRef,
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
 * Per-user resolution is PER INSTALLATION: the delivery's
 * `installation.id` (or, for a user-configured repo/org webhook, the
 * repository owner) selects the platform user bound to it, so two
 * customers' repositories never cross-attribute. The identity is read
 * from the not-yet-verified body, which is safe because it only SELECTS
 * which install's webhook secret to verify against — a forged id picks a
 * secret that fails the HMAC.
 *
 * An unknown or ambiguous installation is REFUSED rather than guessed,
 * and the refusal is a clean no-op (warn log, 200, nothing ingested) —
 * never a 500. Only "no install configured at all" and "bad signature"
 * are 401s, preserving the fail-closed posture.
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

        const rawBody = req.rawBody;
        const body = (req.body ?? {}) as GitHubWebhookBody;

        // Resolve WHICH install owns this installation/repository before
        // verifying, so the right webhook secret is used. The workspace
        // ref comes from the unverified body and only selects a candidate
        // secret — a forged id picks a secret that fails the HMAC below.
        const resolution = await this.bridge.resolveBinding({
            workspace: extractGitHubWorkspaceRef(body),
            verifySignature: (webhookSecret) =>
                verifyGitHubSignature({ rawBody, signature, webhookSecret }).valid,
        });

        // Fail-closed: nothing configured → reject, including the initial
        // `ping` (GitHub signs that too).
        if (resolution.status === 'not-configured') {
            throw new UnauthorizedException('GitHub events receiver is not configured');
        }
        // Unknown/ambiguous installation → clean no-op. The bridge already
        // logged the refusal; 200 so GitHub does not retry a delivery we
        // will never be able to attribute.
        if (resolution.status === 'unresolved') {
            return { ok: true, ignored: resolution.reason };
        }

        const binding = resolution.binding;

        const verdict = verifyGitHubSignature({
            rawBody,
            signature,
            webhookSecret: binding.webhookSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException('Invalid GitHub webhook signature');
        }

        // Verified — persist the installation→user binding so subsequent
        // deliveries resolve exactly instead of through the fallback.
        await this.bridge.recordBinding(binding);

        // Webhook-creation handshake — acknowledge without dispatching.
        if (eventName === 'ping') {
            return { ok: true };
        }

        await this.bridge.handleEvent(binding, eventName, body);

        return { ok: true };
    }
}
