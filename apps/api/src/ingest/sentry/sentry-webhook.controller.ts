import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EventIngestService } from '@ever-works/agent/ingest';
import { Public } from '../../auth/decorators/public.decorator';
import { config } from '../../config/constants';
import { nonEmpty } from '../ingest-envelope.util';
import { SentryIncidentSource, type SentryWebhookBody } from './sentry-incident.source';
import { SentryInstallBindingService } from './sentry-install-binding.service';
import { verifySentrySignature } from './sentry-signature.util';

/** `Sentry-Hook-Resource` for installation lifecycle deliveries. */
const INSTALLATION_RESOURCE = 'installation';

/**
 * The ONE 401 body this receiver ever returns — an unconfigured
 * deployment and a bad signature are indistinguishable from outside, so
 * probing cannot map which integrations are live.
 */
export const INVALID_SENTRY_SIGNATURE = 'Invalid Sentry webhook signature';

/**
 * Sentry integration webhook receiver (self-build program note §6, R23)
 * — the platform-side endpoint the Sentry internal integration's webhook
 * URL points at.
 *
 * Public route (Sentry calls it), secured by request signing instead of
 * platform auth: every delivery is verified with the integration's
 * CLIENT SECRET (`Sentry-Hook-Signature = HEX(HMAC_SHA256(secret,
 * rawBody))`, constant-time compare) and the endpoint FAILS CLOSED —
 * with `SENTRY_WEBHOOK_CLIENT_SECRET` unset everything is 401, and a
 * missing or mismatched signature is 401 too. No source ever falls back
 * to "unsigned but trusted". (The generic trigger fire URL cannot serve
 * Sentry: it is HMAC-signed with a per-trigger platform secret over
 * `timestamp.body`, which Sentry can never reproduce.)
 *
 * Body handling mirrors the GitHub / Jira receivers: the raw payload
 * (captured by the bodyParser `verify` hook in main.ts, 1 MB cap) feeds
 * signature verification; the parsed body is consumed as-is, bypassing
 * the global whitelist ValidationPipe (Sentry's schema is theirs).
 *
 * Attribution is PER INSTALLATION and never from the payload: the
 * delivery's `installation.uuid` is looked up in the bindings the owner
 * wrote through the AUTHENTICATED claim endpoint (`SentryBindingsController`).
 * A uuid nobody has claimed is a clean 200 no-op — nothing is filed for
 * a stream nobody owns, and a forged uuid can at most select an
 * installation whose owner has opted in and whose deliveries still had
 * to carry Sentry's own signature. Which Work an incident lands in comes
 * from that owner's Work claims (`workHint`), never from the body.
 *
 * `installation` deliveries are lifecycle, not incidents: a signed
 * `deleted` removes the binding. `error`, `comment` and `metric_alert`
 * resources are acknowledged and dropped (see `SentryIncidentSource`).
 *
 * Never logs the body — event alerts carry stack frames and user
 * context. An ingest failure is rethrown: Sentry retries and the spine's
 * `(source, sourceEventId)` dedupe makes the retry free.
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class SentryWebhookController {
    private readonly logger = new Logger(SentryWebhookController.name);

    constructor(
        private readonly source: SentryIncidentSource,
        private readonly bindings: SentryInstallBindingService,
        private readonly eventIngestService: EventIngestService,
    ) {}

    @Public()
    @Post('sentry/events')
    @ApiOperation({
        summary:
            'Sentry integration webhook receiver — Sentry-Hook-Signature verified; issue / event alerts ingest as `incident` events for the claimed installation.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveEvents(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('sentry-hook-signature') signature: string | undefined,
        @Headers('sentry-hook-resource') resourceHeader: string | undefined,
    ) {
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }
        const resource = nonEmpty(resourceHeader)?.toLowerCase();
        if (!resource) {
            throw new BadRequestException('Missing Sentry-Hook-Resource header');
        }

        // Fail-closed: no client secret configured → reject everything.
        //
        // The 401 body is the SAME one a bad signature gets. Answering
        // 'not configured' when `SENTRY_WEBHOOK_CLIENT_SECRET` is unset
        // and 'invalid signature' when it is set hands an unauthenticated
        // prober a map of which integrations this deployment has live.
        // Operators read the reason out of the logs instead.
        const clientSecret = config.sentryIntake.webhookClientSecret();
        if (!clientSecret) {
            this.logger.warn(
                'Rejecting a Sentry delivery: SENTRY_WEBHOOK_CLIENT_SECRET is not configured',
            );
            throw new UnauthorizedException(INVALID_SENTRY_SIGNATURE);
        }

        const verdict = verifySentrySignature({ rawBody: req.rawBody, signature, clientSecret });
        if (!verdict.valid) {
            throw new UnauthorizedException(INVALID_SENTRY_SIGNATURE);
        }

        // ---- Verified from here on -----------------------------------
        const body = (req.body ?? {}) as SentryWebhookBody;
        const action = nonEmpty(body.action);
        const installationUuid = body.data?.installation?.uuid ?? body.installation?.uuid;

        // Owner resolution runs FIRST, for every resource including
        // `installation`. Sentry signs with one platform-level client
        // secret, so a verified delivery proves it came from Sentry and
        // never WHOSE it is — the only thing standing between a delivery
        // and a tenant's data is the claim table. Acting on an
        // `installation.deleted` before consulting it (as this receiver
        // used to) let one signed request drop a binding whose owner had
        // never been looked up, silently stopping that account's incident
        // intake and freeing the uuid for the next first-claim race.
        const owner = await this.bindings.resolveOwner(installationUuid);

        if (resource === INSTALLATION_RESOURCE) {
            // A lifecycle delivery for a uuid nobody has claimed has
            // nothing to act on; one for a claimed uuid removes exactly
            // that owner's own binding.
            if (action === 'deleted' && owner) {
                await this.bindings.onInstallationDeleted(owner.installationUuid);
            }
            // `created` carries no owner we could trust — the owner claims
            // the uuid through the authenticated endpoint instead.
            return { ok: true };
        }

        if (!owner) {
            // Only a PREFIX of the uuid: on this receiver the installation
            // uuid is the whole claim credential (`POST /bindings` binds
            // whoever presents it first), and API logs are shipped to the
            // PostHog log sink. Enough to correlate a delivery with an
            // installation, not enough to claim somebody's incident stream
            // off a log line. The owner reads the full uuid off their own
            // Sentry integration page.
            this.logger.warn(
                `Ignoring Sentry '${resource}' delivery: installation ${
                    typeof installationUuid === 'string'
                        ? `${installationUuid.slice(0, 8)}…`
                        : '(none)'
                } is not claimed by any account`,
            );
            return { ok: true, ignored: 'unknown-workspace' as const };
        }

        const envelope = this.source.normalize({ resource, action, body });
        if (!envelope) {
            // Acknowledged, not an incident (error / comment / metric_alert,
            // or an issue action outside the lifecycle we file).
            return { ok: true };
        }

        const ingested = await this.eventIngestService.ingest(owner.userId, [envelope]);
        if (ingested.inserted > 0) {
            this.logger.log(
                `Ingested Sentry incident ${envelope.subject?.externalId ?? envelope.sourceEventId} for user ${owner.userId}`,
            );
        }
        return { ok: true };
    }
}
