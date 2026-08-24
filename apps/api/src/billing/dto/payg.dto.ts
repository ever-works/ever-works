import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Pay-as-you-go settings (billing spec §3.5 / FR-31).
 *
 *  - `enabled: true`            → turn on (creates the metered subscription; cap optional)
 *  - `enabled: false`           → turn off (cancels it immediately, invoices accrued usage)
 *  - `monthlyCapCredits` alone  → re-cap without touching the on/off state
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`,
 * so a body carrying a price, a rate, a tier or any other amount-shaped
 * field is REJECTED — the per-credit price is the catalog's, server-side,
 * never the client's. The cap's real bounds (catalog min / deployment max)
 * are enforced by `PaygService`; the decorators here only stop nonsense.
 */
export class UpdatePaygDto {
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    /** Monthly cap in credits. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100_000_000)
    monthlyCapCredits?: number;
}
