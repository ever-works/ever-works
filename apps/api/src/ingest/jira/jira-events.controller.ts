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
    JiraIssueBridgeService,
    extractJiraSiteRef,
    type JiraWebhookBody,
} from './jira-issue-bridge.service';
import { verifyJiraSignature } from './jira-signature.util';

/**
 * The ONE 401 body this receiver ever returns — an unconfigured
 * deployment and a bad signature are indistinguishable from outside, so
 * probing cannot map which integrations are live.
 */
export const INVALID_JIRA_SIGNATURE = 'Invalid Jira webhook signature';

/**
 * Jira Cloud webhook receiver (self-build program note §6, R2) — the
 * platform-side endpoint a Jira Cloud webhook (created WITH a secret)
 * points at.
 *
 * Public route (Jira calls it), secured by request signing instead of
 * platform auth: every delivery is verified with the owning install's
 * webhook secret (`X-Hub-Signature = sha256=HMAC_SHA256(secret, rawBody)`,
 * constant-time compare) and the endpoint FAILS CLOSED — when no
 * jira-connector install with a webhook secret exists, everything is
 * 401, and a webhook created without a secret (no signature header at
 * all) is rejected too. No source ever falls back to "unsigned but
 * trusted".
 *
 * Body handling mirrors `SlackEventsController` / the GitHub receiver:
 * the raw payload (captured by the bodyParser `verify` hook in main.ts,
 * 1 MB cap) feeds signature verification; the parsed body is consumed
 * as-is, bypassing the global whitelist ValidationPipe (Jira's schema is
 * theirs, not ours).
 *
 * Per-user resolution is PER SITE: the delivery's API self-links name
 * the Jira site, which selects the platform user whose install is
 * configured for it — so two customers' sites never cross-attribute.
 * The site is read from the not-yet-verified body, which is safe
 * because it only SELECTS which install's secret to verify against; a
 * forged host picks a secret that fails the HMAC. Which Organization /
 * Work an event lands in comes from the binding and the owner's own
 * Work claims — never from the payload.
 *
 * An unknown or ambiguous site is REFUSED rather than guessed, and the
 * refusal is a clean no-op (warn log, 200, nothing ingested) — never a
 * 500. Only "no install configured at all" and "bad / missing
 * signature" are 401s. An ingest failure is rethrown: Jira redelivers
 * and the spine's dedupe makes the retry free.
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class JiraEventsController {
    constructor(private readonly bridge: JiraIssueBridgeService) {}

    @Public()
    @Post('jira/events')
    @ApiOperation({
        summary:
            'Jira Cloud webhook receiver — X-Hub-Signature verified; issue created / updated / transitioned / deleted ingest (jira.issue).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveEvents(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('x-hub-signature') signature: string | undefined,
    ) {
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        const rawBody = req.rawBody;
        const body = (req.body ?? {}) as JiraWebhookBody;

        const resolution = await this.bridge.resolveBinding({
            workspace: extractJiraSiteRef(body),
            verifySignature: (webhookSecret) =>
                verifyJiraSignature({ rawBody, signature, webhookSecret }).valid,
        });

        // Fail-closed: nothing configured → reject.
        //
        // The message is deliberately the SAME one a bad signature gets:
        // "not configured" here means no user on this deployment has an
        // enabled jira-connector install with a webhook secret, and
        // telling an unauthenticated prober that is a configuration
        // oracle. Operators read the reason out of the logs.
        if (resolution.status === 'not-configured') {
            throw new UnauthorizedException(INVALID_JIRA_SIGNATURE);
        }
        // Unknown/ambiguous site → clean no-op. The bridge already logged
        // the refusal; 200 so Jira does not retry a delivery we will never
        // be able to attribute.
        if (resolution.status === 'unresolved') {
            return { ok: true, ignored: resolution.reason };
        }

        const binding = resolution.binding;

        const verdict = verifyJiraSignature({
            rawBody,
            signature,
            webhookSecret: binding.webhookSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException(INVALID_JIRA_SIGNATURE);
        }

        // Verified — persist the site→user binding so subsequent
        // deliveries resolve exactly instead of through the fallback.
        await this.bridge.recordBinding(binding);

        await this.bridge.handleEvent(binding, body);

        return { ok: true };
    }
}
