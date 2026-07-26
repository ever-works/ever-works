import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CREDIT_PACK_IDS } from '@ever-works/agent/subscriptions';

/**
 * Credit-top-up checkout request (billing PRD §3.2).
 *
 * The ONLY field is a pack id from the SERVER-side pack table. The global
 * ValidationPipe runs with `whitelist: true` + `forbidNonWhitelisted:
 * true`, so a body carrying `amountCents`, `priceCents`, `credits` or any
 * other price-shaped field is REJECTED with a 400 rather than silently
 * stripped — a client can never influence what it is charged.
 */
export class CreateCreditCheckoutDto {
    @IsString()
    @IsIn(CREDIT_PACK_IDS as string[], { message: 'packId must be a published credit pack' })
    packId: string;
}

/** Auto-recharge settings (billing PRD §3.4). Amounts are pack ids, not prices. */
export class UpdateAutoRechargeDto {
    @IsBoolean()
    enabled: boolean;

    /** Recharge when the credits balance drops below this. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    thresholdCredits?: number;

    @IsOptional()
    @IsString()
    @IsIn(CREDIT_PACK_IDS as string[], { message: 'packId must be a published credit pack' })
    packId?: string;
}

export class ListInvoicesQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    pageSize?: number;
}
