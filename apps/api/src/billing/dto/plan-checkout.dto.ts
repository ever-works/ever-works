import {
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { SubscriptionPlanCode } from '@ever-works/agent/entities';

/**
 * Paid-plan checkout request (audit B24).
 *
 * The body names a PLAN CODE and, optionally, the organization the
 * subscription is being bought for. It can never name a price: the
 * global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so a
 * body carrying `priceCents`/`amount`/`monthlyPrice` is rejected with a
 * 400 rather than silently stripped, and the service reads the recurring
 * amount from the `subscription_plans` row regardless.
 *
 * `organizationId` is NOT an authorization — the controller resolves it
 * through `OrganizationMembershipService`, which 404s any org outside the
 * caller's tenant. Supplying someone else's org id buys nothing.
 */
export class CreatePlanCheckoutDto {
    @IsEnum(SubscriptionPlanCode)
    planCode: SubscriptionPlanCode;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    organizationId?: string;

    /**
     * Which billing period to buy. Defaults to `monthly`, which is what every caller sent before
     * this field existed.
     *
     * 🛑 This names a PERIOD, not a price. The amount for the resulting SKU is still read from the
     * server catalog, so asking for `lifetime` on a plan that has no lifetime price is a 400 rather
     * than a cheaper subscription. Only the self-hosted Pro Edition sells a `lifetime` licence, and
     * it is bought as a one-off payment — never inferred from a marketing toggle position.
     */
    @IsOptional()
    @IsIn(['monthly', 'annual', 'lifetime'])
    interval?: 'monthly' | 'annual' | 'lifetime';

    /**
     * TOTAL seats (employees OR agents) the buyer wants, inclusive of the plan's included
     * allowance — not the number of extra ones.
     *
     * The service clamps this against the plan row and bills only the excess, so this number can
     * only ever cost the buyer MORE, never less: under-reporting just buys fewer seats. The upper
     * bound is a sanity limit on a public, throttled endpoint, not a product limit; a genuinely
     * larger deployment buys Enterprise Option 1, which is unbounded and meters nothing.
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100_000)
    seats?: number;
}

/**
 * Return-route query (audit B24). `sessionId` is provider-opaque and
 * arrives from a redirect, so it is length- and charset-constrained
 * before it is ever handed to the provider SDK. It is NOT a credential:
 * the service authorizes on the user id stored in the session metadata.
 */
export class PlanCheckoutReturnQueryDto {
    @IsString()
    @MaxLength(255)
    @Matches(/^[A-Za-z0-9_-]+$/, { message: 'sessionId has an unexpected format' })
    sessionId: string;
}
