import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Put,
    Query,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthSessionGuard, CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { config } from '@src/config/constants';
import {
    BillingProviderError,
    BillingProviderNotConfiguredError,
    BillingService,
    NoActiveSubscriptionError,
    UnknownCreditPackError,
} from '@ever-works/agent/subscriptions';
import { Invoice } from '@ever-works/agent/entities';
import {
    CreateCreditCheckoutDto,
    ListInvoicesQueryDto,
    UpdateAutoRechargeDto,
} from './dto/billing.dto';

/**
 * Owner-scoped money surfaces (billing PRD §5.2).
 *
 * Everything here requires an authenticated session; the one @Public
 * route in this module is the provider webhook, which lives in its own
 * controller and is authenticated by signature instead.
 *
 * Provider-not-configured degrades to a 503 with a stable message, which
 * is what lets the Billing page render its coming-soon card instead of a
 * button that always errors.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('api/billing')
@UseGuards(AuthSessionGuard)
export class BillingController {
    constructor(private readonly billingService: BillingService) {}

    @Get('overview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Billing overview',
        description:
            'One round-trip snapshot for the Billing page: provider configured flag, credit packs, ' +
            'balance, default payment-method summary (brand/last4/expiry only) and auto-recharge settings.',
    })
    @ApiResponse({ status: 200, description: 'Billing overview' })
    async getOverview(@CurrentUser() auth: AuthenticatedUser) {
        const overview = await this.billingService.getOverview(auth.userId);
        return { status: 'success', ...overview };
    }

    @Get('invoices')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List invoices',
        description:
            'Paginated invoice history for the authenticated user, mirrored from the payment provider ' +
            'by the signature-verified webhook. Owner-scoped — never returns another account’s rows.',
    })
    @ApiResponse({ status: 200, description: 'Paginated invoices' })
    async listInvoices(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListInvoicesQueryDto,
    ) {
        const { invoices, total, page, pageSize } = await this.billingService.listInvoices(
            auth.userId,
            query.page ?? 1,
            query.pageSize ?? 10,
        );
        return {
            status: 'success',
            invoices: invoices.map((invoice) => this.toInvoiceRow(invoice)),
            total,
            page,
            pageSize,
        };
    }

    @Get('auto-recharge')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get auto-recharge settings' })
    @ApiResponse({ status: 200, description: 'Auto-recharge settings' })
    async getAutoRecharge(@CurrentUser() auth: AuthenticatedUser) {
        const overview = await this.billingService.getOverview(auth.userId);
        return { status: 'success', ...overview.autoRecharge };
    }

    @Put('auto-recharge')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update auto-recharge settings',
        description:
            'Enable/disable threshold-triggered top-ups. The amount is a server-side pack id, never a price.',
    })
    @ApiResponse({ status: 200, description: 'Updated settings' })
    @ApiResponse({ status: 409, description: 'No payment method on file' })
    async updateAutoRecharge(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateAutoRechargeDto,
    ) {
        try {
            const profile = await this.billingService.updateAutoRecharge(auth.userId, {
                enabled: body.enabled,
                thresholdCredits: body.thresholdCredits ?? null,
                packId: body.packId ?? null,
            });
            return {
                status: 'success',
                enabled: profile.autoRechargeEnabled,
                thresholdCredits: profile.autoRechargeThresholdCredits ?? null,
                packId: profile.autoRechargePackId ?? null,
                failureCount: profile.autoRechargeFailureCount,
            };
        } catch (error) {
            throw mapBillingError(error);
        }
    }

    // ── Subscription lifecycle (audit B07/B08) ───────────────────────

    @Post('subscription/cancel')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Cancel the subscription at the end of the paid period',
        description:
            'Schedules an at-period-end cancellation through the billing-provider seam and persists ' +
            'the returned lifecycle state on the billing profile. The plan keeps working until the ' +
            'period ends and `POST subscription/resume` reverses it. Owner-scoped: the subscription ' +
            'is resolved from the session user, so no caller can cancel another account’s plan.',
    })
    @ApiResponse({ status: 200, description: 'Cancellation scheduled' })
    @ApiResponse({ status: 409, description: 'No manageable subscription for this account' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async cancelSubscription(@CurrentUser() auth: AuthenticatedUser) {
        try {
            const subscription = await this.billingService.cancelSubscription(auth.userId);
            return { status: 'success', subscription };
        } catch (error) {
            throw mapBillingError(error);
        }
    }

    @Post('subscription/resume')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Resume a subscription that was set to cancel at period end',
        description:
            'Clears a pending at-period-end cancellation through the billing-provider seam. Refused ' +
            'with 409 once the subscription has actually ended — there is nothing left to resume.',
    })
    @ApiResponse({ status: 200, description: 'Subscription resumed' })
    @ApiResponse({ status: 409, description: 'No manageable subscription for this account' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async resumeSubscription(@CurrentUser() auth: AuthenticatedUser) {
        try {
            const subscription = await this.billingService.resumeSubscription(auth.userId);
            return { status: 'success', subscription };
        } catch (error) {
            throw mapBillingError(error);
        }
    }

    @Post('portal')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Open the provider’s hosted billing portal',
        description:
            'The PAST_DUE recovery action: returns a redirect URL where the owner can update the card ' +
            'that failed. Capture stays on the provider’s tokenized surface. The return URL is built ' +
            'server-side from WEB_URL — a client-supplied one would be an open redirect.',
    })
    @ApiResponse({ status: 200, description: 'Portal session created' })
    @ApiResponse({ status: 409, description: 'No billing account for this user' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async createPortalSession(@CurrentUser() auth: AuthenticatedUser) {
        const base = config.webAppUrl().replace(/\/+$/, '');
        try {
            const session = await this.billingService.createBillingPortalSession(
                auth.userId,
                `${base}/settings/billing`,
            );
            return { status: 'success', url: session.url };
        } catch (error) {
            throw mapBillingError(error);
        }
    }

    /**
     * Explicit projection. `defaultPaymentMethodRef` and every provider
     * secret stay server-side; only display metadata crosses the wire.
     */
    private toInvoiceRow(invoice: Invoice) {
        return {
            id: invoice.id,
            number: invoice.number ?? null,
            status: invoice.status,
            periodStart: invoice.periodStart ?? null,
            periodEnd: invoice.periodEnd ?? null,
            subtotalCents: invoice.subtotalCents,
            totalCents: invoice.totalCents,
            amountPaidCents: invoice.amountPaidCents,
            currency: invoice.currency,
            hostedUrl: invoice.hostedUrl ?? null,
            pdfUrl: invoice.pdfUrl ?? null,
            issuedAt: invoice.issuedAt ?? invoice.createdAt,
        };
    }
}

/**
 * Credit top-up checkout (billing PRD §3.2), mounted under `/api/credits`
 * beside the existing read-only ledger/balance endpoints.
 *
 * THE contract: the body carries a **pack id and nothing else**. The
 * global ValidationPipe (`whitelist` + `forbidNonWhitelisted`) turns any
 * client-supplied amount/price/credits field into a 400, and the service
 * reads price + credits from the server-side pack table regardless.
 */
@ApiTags('Credits')
@ApiBearerAuth('JWT-auth')
@Controller('api/credits')
@UseGuards(AuthSessionGuard)
export class CreditsCheckoutController {
    constructor(private readonly billingService: BillingService) {}

    @Get('packs')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List credit packs',
        description: 'The server-side credit-pack table. Prices are not client-configurable.',
    })
    @ApiResponse({ status: 200, description: 'Credit packs' })
    getPacks() {
        return {
            status: 'success',
            providerConfigured: this.billingService.isProviderConfigured(),
            packs: this.billingService.getPacks(),
        };
    }

    @Post('checkout')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start a credit top-up checkout',
        description:
            'Creates a hosted checkout session for one published credit pack and returns the redirect URL. ' +
            'Body accepts a packId only — a client-supplied amount is rejected with 400.',
    })
    @ApiResponse({ status: 200, description: 'Checkout session created' })
    @ApiResponse({ status: 400, description: 'Unknown pack, or a non-whitelisted body field' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    // Checkout creates an object at the provider on every call — keep the
    // per-user rate well below anything that could be used to spam them.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async createCheckout(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateCreditCheckoutDto,
    ) {
        // Return URLs are built server-side from WEB_URL. They are never
        // accepted from the client — an attacker-supplied `successUrl`
        // would turn checkout into an open redirect.
        const base = config.webAppUrl().replace(/\/+$/, '');
        try {
            const session = await this.billingService.startCreditCheckout({
                userId: auth.userId,
                packId: body.packId,
                successUrl: `${base}/settings/billing?topup=success`,
                cancelUrl: `${base}/settings/billing?topup=cancelled`,
            });
            return { status: 'success', ...session };
        } catch (error) {
            throw mapBillingError(error);
        }
    }
}

/**
 * Stable-name error mapping — the money path must never surface an
 * unmapped 500 (billing PRD §6).
 */
function mapBillingError(error: unknown): unknown {
    if (error instanceof BillingProviderNotConfiguredError) {
        return new ServiceUnavailableException(error.message);
    }
    if (error instanceof UnknownCreditPackError) {
        return new BadRequestException(error.message);
    }
    // Subscription lifecycle (audit B07/B08): "you have nothing to
    // cancel/resume" is a state conflict, not a server fault — and it is
    // the same answer a cross-owner attempt gets, so the response cannot
    // be used to probe whether another account has a subscription.
    if (error instanceof NoActiveSubscriptionError) {
        return new ConflictException(error.message);
    }
    if (error instanceof BillingProviderError) {
        return new ConflictException(error.message);
    }
    return error;
}
