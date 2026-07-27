import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Post,
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
    CheckoutSessionNotFoundError,
    PlanNotPurchasableError,
    PlanSubscriptionService,
    UnknownSubscriptionPlanError,
} from '@ever-works/agent/subscriptions';
import { OrganizationMembershipService } from '@src/organizations/organization-membership.service';
import { CreatePlanCheckoutDto, PlanCheckoutReturnQueryDto } from './dto/plan-checkout.dto';

/**
 * Paid-plan purchase (audit B24) — the surface that was missing for a
 * paid tier to be buyable at all.
 *
 * Two routes, one auth posture (session-guarded, owner-scoped):
 *
 *   - `POST /api/billing/checkout/plan` — creates the hosted checkout
 *     session and returns the provider redirect URL.
 *   - `GET  /api/billing/checkout/plan/return` — finalizes the browser's
 *     return so the buyer sees the new tier without waiting on the
 *     asynchronous webhook. The webhook remains the authority; both
 *     paths funnel into the same idempotent activation.
 *
 * ## Scoping rules
 *
 * 1. The buyer is ALWAYS `@CurrentUser().userId`. There is no body field
 *    that can name another user, and nothing here reads one.
 * 2. `organizationId`, when supplied, is authorized through
 *    `OrganizationMembershipService` — which resolves org→tenant and
 *    caller→tenant and answers 404 for anything outside the caller's
 *    tenant. A cross-org checkout is therefore impossible: it never
 *    reaches the payment provider.
 * 3. The return URLs are built server-side from `WEB_URL`; a
 *    client-supplied redirect would turn checkout into an open redirect.
 * 4. The return route treats the session id as UNTRUSTED input. Ownership
 *    is decided by the user id the provider stored in our session
 *    metadata, and a session belonging to someone else is answered the
 *    same as one that does not exist.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('api/billing')
@UseGuards(AuthSessionGuard)
export class PlanCheckoutController {
    constructor(
        private readonly planSubscriptionService: PlanSubscriptionService,
        private readonly organizationMembership: OrganizationMembershipService,
    ) {}

    @Post('checkout/plan')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start a paid-plan checkout',
        description:
            'Creates a recurring hosted checkout session for one active subscription plan and returns the ' +
            'redirect URL. The body accepts a planCode (and optionally an organizationId the caller belongs ' +
            'to) — a client-supplied price is rejected with 400. Free plans are not purchasable here; use the ' +
            'self-service plan endpoint.',
    })
    @ApiResponse({ status: 200, description: 'Checkout session created' })
    @ApiResponse({
        status: 400,
        description: 'Unknown plan, free plan, or a non-whitelisted field',
    })
    @ApiResponse({ status: 404, description: 'Organization is not the caller’s' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    // Checkout creates an object at the provider on every call — keep the
    // per-user rate well below anything that could be used to spam them.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async createPlanCheckout(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreatePlanCheckoutDto,
    ) {
        // Cross-org guard FIRST: a caller must not be able to make the
        // platform talk to the payment provider about an org they cannot
        // see. `ensureMember` answers 404 (not 403) so org ids in other
        // tenants stay opaque.
        let organizationId: string | null = null;
        let tenantId: string | null = null;
        if (body.organizationId) {
            const organization = await this.organizationMembership.ensureMember(
                body.organizationId,
                auth.userId,
            );
            organizationId = organization.id;
            tenantId = organization.tenantId ?? null;
        }

        const base = config.webAppUrl().replace(/\/+$/, '');
        try {
            const session = await this.planSubscriptionService.startPlanCheckout({
                userId: auth.userId,
                planCode: body.planCode,
                // The provider appends its own session identifier — see
                // the `successUrl` contract on `PlanCheckoutRequest`.
                successUrl: `${base}/settings/billing?plan=success`,
                cancelUrl: `${base}/settings/billing?plan=cancelled`,
                organizationId,
                tenantId,
            });
            return { status: 'success', ...session };
        } catch (error) {
            throw mapPlanBillingError(error);
        }
    }

    @Get('checkout/plan/return')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Finalize a returning paid-plan checkout',
        description:
            'Reads the hosted checkout session back from the provider and activates the plan when it has ' +
            'settled, so the buyer does not have to wait for the webhook. Idempotent, and scoped to the ' +
            'authenticated user: a session belonging to another account answers 404.',
    })
    @ApiResponse({ status: 200, description: 'Return processed' })
    @ApiResponse({ status: 404, description: 'No such checkout session for this account' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async completePlanCheckout(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: PlanCheckoutReturnQueryDto,
    ) {
        try {
            // Returned as-is, NOT wrapped in the `{ status: 'success' }`
            // envelope the sibling routes use. `PlanCheckoutReturn.status`
            // is a meaningful tri-state (`active` | `pending` | `ignored`)
            // and is NOT redundant with `activated`: `ignored` is how a
            // CREDIT TOP-UP session that returned through this plan route
            // reports back — not an error, it just activates no plan.
            // Spreading the result under an envelope key of the same name
            // silently clobbered that value, which is what this prevents.
            return await this.planSubscriptionService.syncCheckoutReturn(
                auth.userId,
                query.sessionId,
            );
        } catch (error) {
            throw mapPlanBillingError(error);
        }
    }
}

/**
 * Stable-name error mapping — the money path must never surface an
 * unmapped 500 (billing PRD §6).
 */
export function mapPlanBillingError(error: unknown): unknown {
    if (error instanceof BillingProviderNotConfiguredError) {
        return new ServiceUnavailableException(error.message);
    }
    if (error instanceof UnknownSubscriptionPlanError || error instanceof PlanNotPurchasableError) {
        return new BadRequestException(error.message);
    }
    if (error instanceof CheckoutSessionNotFoundError) {
        // Existence-leak contract: "not yours" is indistinguishable from
        // "does not exist".
        return new NotFoundException(error.message);
    }
    if (error instanceof BillingProviderError) {
        return new ConflictException(error.message);
    }
    return error;
}
