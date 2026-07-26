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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import {
    BillingProviderError,
    BillingProviderNotConfiguredError,
    BillingService,
} from '@ever-works/agent/subscriptions';

/**
 * Payment-provider webhook receiver (billing PRD §5.2).
 *
 * Posture mirrors the Slack / GitHub receivers exactly:
 *
 *  - **@Public**, because the provider calls it — authentication is the
 *    request SIGNATURE, not a platform session.
 *  - **Raw body** from the bodyParser `verify` hook in `main.ts` feeds
 *    verification; a re-serialized body would not match the digest.
 *  - **FAIL CLOSED**: no webhook signing secret configured ⇒ 401 for
 *    every delivery, including the provider's own test pings. An
 *    unconfigured receiver rejects rather than trusts.
 *  - **Constant-time comparison**: performed inside the provider's
 *    official SDK (`constructEvent` → `secureCompare`) together with the
 *    delivery-timestamp tolerance. We do not hand-roll the scheme.
 *  - **Never trust amounts from the caller**: the handler reads what was
 *    charged from the verified event only.
 *
 * Everything past verification returns 200 — including events we cannot
 * attribute and event types we do not handle. A 5xx would make the
 * provider retry a delivery we can never resolve.
 */
@ApiTags('Billing')
@Controller('api/billing')
export class BillingWebhookController {
    private readonly logger = new Logger(BillingWebhookController.name);

    constructor(private readonly billingService: BillingService) {}

    @Public()
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Payment-provider webhook — signature-verified, fail-closed; credits top-ups idempotently by provider event id.',
    })
    @ApiResponse({ status: 200, description: 'Delivery accepted' })
    @ApiResponse({ status: 400, description: 'Missing raw payload' })
    @ApiResponse({ status: 401, description: 'Unconfigured receiver or bad signature' })
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receive(
        @Req() req: { rawBody?: string },
        @Headers('stripe-signature') signature: string | undefined,
    ) {
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        try {
            const outcome = await this.billingService.handleWebhook(req.rawBody, signature);
            // Log the provider EVENT id and the action only — never the
            // payload, never a header, never a secret.
            this.logger.log(
                `Billing webhook ${outcome.eventId}: ${outcome.kind} → ${outcome.action}`,
            );
            return { ok: true, action: outcome.action };
        } catch (error) {
            if (
                error instanceof BillingProviderNotConfiguredError ||
                error instanceof BillingProviderError
            ) {
                // Both cases are "we will not act on this delivery":
                // unconfigured receiver and failed verification. One
                // undifferentiated 401 (house internal-endpoint posture)
                // so the response cannot be used to probe configuration.
                throw new UnauthorizedException('Invalid billing webhook delivery');
            }
            throw error;
        }
    }
}
