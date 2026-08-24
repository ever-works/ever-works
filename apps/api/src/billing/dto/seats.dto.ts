import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Seat purchase / release (billing spec §3.6 / FR-29).
 *
 * `seats` is the TOTAL the owner wants, not a delta — a delta is
 * ambiguous under concurrent clicks and would double-charge on a retry.
 * The server converts it to billable extras from the stored plan row
 * (`max(0, total − seatsIncluded)`), so no price and no quantity the
 * client sends can influence what is charged. The global ValidationPipe
 * runs with `whitelist` + `forbidNonWhitelisted`, so a body carrying a
 * price-shaped field is rejected rather than ignored.
 */
export class UpdateSeatsDto {
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(10_000)
    seats: number;
}
