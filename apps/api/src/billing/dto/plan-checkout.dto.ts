import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
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
