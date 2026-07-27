import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Put,
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
    LastPaymentMethodError,
    PaymentMethodNotFoundError,
    PaymentMethodService,
} from '@ever-works/agent/subscriptions';
import { PaymentMethodParamDto, StartPaymentMethodSetupDto } from './dto/payment-method.dto';

/**
 * Payment-method management (billing PRD §3.3, audit B10 + B25).
 *
 * Before this controller existed the payment method was READ-ONLY: it
 * appeared only as a side effect of a credit purchase and could never be
 * added, replaced or removed. These four routes close that gap and are
 * purely additive — the existing overview / invoices / auto-recharge
 * routes are untouched.
 *
 * ## Card data never reaches this API
 *
 * `POST setup-session` returns a redirect to the PROVIDER'S OWN hosted
 * card element. The PAN and CVC are entered on a page the provider
 * serves and are tokenized there; this process only ever sees an opaque
 * reference plus brand / last4 / expiry. No route here accepts a card
 * field, and the DTOs (`forbidNonWhitelisted`) reject one outright.
 *
 * ## Owner + organization scoping
 *
 * Every route is behind `AuthSessionGuard` and resolves the billing
 * profile from `auth.userId` alone. No user, organization, tenant or
 * provider-customer id is ever accepted from the client, so a caller
 * cannot read or mutate another owner's — or another organization's —
 * billing. The `:id` path parameter is a derived HANDLE that is matched
 * only against the caller's own stored cards, so a handle copied from
 * somewhere else resolves to a 404 rather than to somebody's card.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('api/billing/payment-methods')
@UseGuards(AuthSessionGuard)
export class PaymentMethodController {
    constructor(private readonly paymentMethodService: PaymentMethodService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List stored payment methods',
        description:
            'Cards stored against the authenticated owner, read live from the payment provider. ' +
            'Display metadata only (brand / last four / expiry) plus an opaque handle — the ' +
            'provider payment-method reference never crosses the wire.',
    })
    @ApiResponse({ status: 200, description: 'Payment methods' })
    async list(@CurrentUser() auth: AuthenticatedUser) {
        try {
            const result = await this.paymentMethodService.list(auth.userId);
            return { status: 'success', ...result };
        } catch (error) {
            throw mapPaymentMethodError(error);
        }
    }

    @Post('setup-session')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start a hosted card capture (add / replace a card)',
        description:
            'Creates a provider-hosted setup session and returns its redirect URL. Card details are ' +
            'entered on the provider’s page and never touch this API. The body must be empty — the ' +
            'owner comes from the session and the return URLs are built server-side.',
    })
    @ApiResponse({ status: 200, description: 'Setup session created' })
    @ApiResponse({ status: 400, description: 'A non-whitelisted body field' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    // Each call creates an object at the provider — keep the per-user
    // rate well below anything that could be used to spam them.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async startSetup(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() _body: StartPaymentMethodSetupDto,
    ) {
        // Built from WEB_URL server-side, exactly like credit checkout: a
        // client-supplied return URL would make this an open redirect.
        const base = config.webAppUrl().replace(/\/+$/, '');
        try {
            const session = await this.paymentMethodService.startSetup(auth.userId, {
                successUrl: `${base}/settings/billing/payment-method?setup=success`,
                cancelUrl: `${base}/settings/billing/payment-method?setup=cancelled`,
            });
            return { status: 'success', ...session };
        } catch (error) {
            throw mapPaymentMethodError(error);
        }
    }

    @Put(':id/default')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Make a stored card the default',
        description:
            'Replaces the default payment method. The handle is resolved against the caller’s own ' +
            'stored cards only; an unknown or foreign handle answers 404.',
    })
    @ApiResponse({ status: 200, description: 'Default updated' })
    @ApiResponse({ status: 404, description: 'No such payment method for this owner' })
    async setDefault(
        @CurrentUser() auth: AuthenticatedUser,
        @Param() params: PaymentMethodParamDto,
    ) {
        try {
            const method = await this.paymentMethodService.setDefault(auth.userId, params.id);
            return { status: 'success', method };
        } catch (error) {
            throw mapPaymentMethodError(error);
        }
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Remove a stored card',
        description:
            'Detaches the card at the provider. Removing the LAST card while a paid subscription is ' +
            'active is refused with 409 — add a replacement first — so a paid plan can never be left ' +
            'with nothing to charge. When the last card goes on a free plan, auto-recharge is ' +
            'switched off with it.',
    })
    @ApiResponse({ status: 200, description: 'Removed; returns the remaining methods' })
    @ApiResponse({ status: 404, description: 'No such payment method for this owner' })
    @ApiResponse({ status: 409, description: 'Last payment method on an active paid subscription' })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param() params: PaymentMethodParamDto) {
        try {
            const result = await this.paymentMethodService.remove(auth.userId, params.id);
            return { status: 'success', ...result };
        } catch (error) {
            throw mapPaymentMethodError(error);
        }
    }
}

/**
 * Stable-name error mapping — the money path must never surface an
 * unmapped 500 (billing PRD §6).
 *
 * `PaymentMethodNotFoundError` covers BOTH "no such card" and "that card
 * is not yours" on purpose: distinguishing them would turn the route
 * into an oracle for other accounts' stored payment methods.
 */
export function mapPaymentMethodError(error: unknown): unknown {
    if (error instanceof PaymentMethodNotFoundError) {
        return new NotFoundException(error.message);
    }
    if (error instanceof LastPaymentMethodError) {
        return new ConflictException(error.message);
    }
    if (error instanceof BillingProviderNotConfiguredError) {
        return new ServiceUnavailableException(error.message);
    }
    if (error instanceof BillingProviderError) {
        return new ConflictException(error.message);
    }
    return error;
}
