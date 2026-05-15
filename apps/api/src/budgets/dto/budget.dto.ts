import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Length,
    Max,
    Min,
} from 'class-validator';
import { WorkBudgetScope } from '@ever-works/agent/entities';

/**
 * EW-602 — Create a new monthly cap on a Work.
 *
 * scope=GLOBAL → pluginId must be null/omitted (one global budget per Work).
 * scope=PLUGIN → pluginId must be provided (one budget per plugin per Work).
 * Uniqueness is enforced by the (workId, scope, pluginId) DB constraint;
 * a duplicate POST will surface as a 409-ish error from TypeORM.
 */
export class CreateBudgetDto {
    @IsEnum(WorkBudgetScope, {
        message: `scope must be one of: ${Object.values(WorkBudgetScope).join(', ')}`,
    })
    scope: WorkBudgetScope;

    @IsOptional()
    @IsString()
    @Length(1, 128)
    pluginId?: string;

    /**
     * Monthly cap in cents. Must be a positive integer; 0 effectively
     * blocks all spend at the start of the period (probably not what
     * you want; users should delete the budget instead).
     */
    @IsInt()
    @Min(1)
    @Max(100_000_000)
    monthlyCapCents: number;

    /**
     * When true, the BudgetGuardService still emits 75/90/100 alerts
     * but does not throw BudgetExceededException at 100%. Useful for
     * teams that want soft warnings without hard stops.
     */
    @IsOptional()
    @IsBoolean()
    allowOverage?: boolean;

    /**
     * ISO-4217 currency code (lowercase). Defaults to 'usd' on the
     * entity. Plugin-declared pricing is also assumed USD; setting
     * a non-USD currency here will not auto-convert recorded spend.
     */
    @IsOptional()
    @IsString()
    @Length(2, 8)
    currency?: string;
}

/**
 * EW-602 — Patch a budget. scope and pluginId are immutable
 * (the unique constraint ties them to the row); only the cap,
 * overage toggle, and currency can be updated.
 */
export class UpdateBudgetDto {
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100_000_000)
    monthlyCapCents?: number;

    @IsOptional()
    @IsBoolean()
    allowOverage?: boolean;

    @IsOptional()
    @IsString()
    @Length(2, 8)
    currency?: string;
}
