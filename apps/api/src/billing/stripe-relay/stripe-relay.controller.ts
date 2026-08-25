import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Post,
    Req,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import {
    StripeRelayNotConfiguredError,
    StripeRelayService,
    StripeRelaySignatureError,
} from './stripe-relay.service';

/**
 * The ONE Stripe endpoint that serves every Ever Works directory (relay phase 3).
 *
 * Stripe caps an account at 16 live webhook endpoints, so per-site endpoints
 * cannot scale — three directories currently have no slot and run fail-closed.
 * This receiver verifies Stripe's signature once, resolves the owning directory
 * from `metadata.work_id`, and forwards the event to that site.
 *
 * Posture matches `BillingWebhookController` exactly:
 *  - **@Public**, because Stripe calls it — authentication is the SIGNATURE.
 *  - **Raw body** from the bodyParser `verify` hook in `main.ts`; a
 *    re-serialized body would not match the digest.
 *  - **FAIL CLOSED**: no relay signing secret configured ⇒ 401 for every
 *    delivery, including Stripe's own test pings.
 *  - **Constant-time comparison** inside the official SDK — not hand-rolled.
 *
 * Response codes are chosen for what they make Stripe DO:
 *  - `200` — delivered, or verified-but-unroutable (a retry would deliver the
 *    same unroutable event forever).
 *  - `503` — the directory is down / timed out / rejected our signature, so
 *    Stripe should RETRY (it does for up to 3 days, covering a site outage or
 *    a secret re-sync). Silently dropping a paid event is the worse failure.
 *
 * Ships DARK: `STRIPE_RELAY_ENABLED` is off by default and the route 404s until
 * it is switched on, so merging this cannot change production behaviour.
 */
@ApiTags('Billing')
@Controller('api/billing')
export class StripeRelayController {
    private readonly logger = new Logger(StripeRelayController.name);

    constructor(private readonly relayService: StripeRelayService) {}

    @Public()
    @Post('stripe-relay')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Shared Stripe webhook relay — verifies once, routes to the owning directory by metadata.work_id.',
    })
    @ApiResponse({ status: 200, description: 'Forwarded, or verified but unroutable' })
    @ApiResponse({ status: 400, description: 'Missing raw payload' })
    @ApiResponse({ status: 401, description: 'Unconfigured receiver or bad signature' })
    @ApiResponse({ status: 404, description: 'Relay disabled in this environment' })
    @ApiResponse({ status: 503, description: 'Directory unreachable — Stripe should retry' })
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receive(
        @Req() req: { rawBody?: string },
        @Headers('stripe-signature') signature: string | undefined,
    ) {
        if (!this.relayService.isEnabled()) {
            // 404 rather than 403: a disabled relay should be indistinguishable
            // from a route that does not exist.
            throw new NotFoundException();
        }
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        let outcome;
        try {
            outcome = await this.relayService.handle(req.rawBody, signature);
        } catch (error) {
            if (
                error instanceof StripeRelayNotConfiguredError ||
                error instanceof StripeRelaySignatureError
            ) {
                // One undifferentiated 401 (house internal-endpoint posture) so
                // the response cannot be used to probe configuration.
                throw new UnauthorizedException('Invalid webhook delivery');
            }
            throw error;
        }

        if (outcome.status === 'retry') {
            // Make Stripe retry. The reason is safe to surface: it names our own
            // classification, never upstream content.
            throw new ServiceUnavailableException(`Directory unavailable (${outcome.reason})`);
        }

        // Log the event id and the routing decision only — never the payload.
        this.logger.log(
            outcome.status === 'forwarded'
                ? `relay ${outcome.eventId} -> ${outcome.workId} (${outcome.siteStatus})`
                : `relay ${outcome.eventId} unroutable (${outcome.reason})`,
        );
        return outcome.status === 'forwarded'
            ? { received: true, routed: true }
            : { received: true, routed: false, reason: outcome.reason };
    }
}
