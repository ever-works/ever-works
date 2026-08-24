import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { SeatLimitExceededError } from '@ever-works/agent/subscriptions';

/**
 * Maps a full seat allowance to HTTP **402 Payment Required** at the API
 * boundary (billing spec §3.6 / FR-28). Sibling of
 * `InsufficientCreditsExceptionFilter` — same shape, same
 * map-by-stable-`.name` design, same no-leak posture.
 *
 * WHY THIS EXISTS
 * ---------------
 * `SeatsService.assertSeatAvailable()` rejects a seat-consuming write
 * (inviting a member, creating an agent) with `SeatLimitExceededError`, a
 * plain `Error` — NOT a NestJS `HttpException`. Without a filter that
 * reaches a controller uncaught and becomes a generic 500, which mislabels
 * the most caller-actionable condition the billing surface has ("buy a
 * seat, or free one") as a server fault.
 *
 * WHY 402 AND NOT 403
 * -------------------
 * 402 is already this codebase's "you have run out of paid capacity"
 * status: `BudgetExceededException` and `InsufficientCreditsError` both
 * use it, and `apps/web` already treats 402 as the quota signal. A seat
 * limit is the same class of condition — resolved by paying or by freeing
 * capacity, not by having different permissions. 403 would say "you are
 * not allowed to do this at all", which is wrong and unactionable.
 *
 * NO LEAK
 * -------
 * The thrown error carries `ownerUserId`, `used` and `allowance`. The
 * counts are echoed deliberately — they are the owner's own capacity
 * figures and they are what makes the message actionable — but the OWNER
 * ID never is: the acting user may be a member acting inside somebody
 * else's tenant, and the response must not disclose whose account is
 * being billed.
 */

/** Machine-readable `error` code, matching the un-suffixed convention of the sibling 402s. */
export const SEAT_LIMIT_ERROR_CODE = 'SeatLimitExceeded';

/** `error.name` → HTTP status. Anything unlisted falls through to 500. */
const SEAT_ERROR_STATUS: Readonly<Record<string, HttpStatus>> = {
    SeatLimitExceededError: HttpStatus.PAYMENT_REQUIRED,
};

@Catch(SeatLimitExceededError)
export class SeatLimitExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(SeatLimitExceptionFilter.name);

    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: SeatLimitExceededError, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;
        const ctx = host.switchToHttp();
        const request = ctx.getRequest();
        const response = ctx.getResponse();

        const status = SEAT_ERROR_STATUS[exception.name] ?? HttpStatus.INTERNAL_SERVER_ERROR;
        if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(
                `Unmapped seat error (${exception.name}) on ` +
                    `${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}`,
                exception.stack,
            );
            httpAdapter.reply(
                response,
                {
                    statusCode: status,
                    message: 'Internal server error',
                    timestamp: new Date().toISOString(),
                },
                status,
            );
            return;
        }

        httpAdapter.reply(
            response,
            {
                statusCode: status,
                error: SEAT_LIMIT_ERROR_CODE,
                // Counts, never the owner id — see the docblock.
                message:
                    `Seat limit reached (${exception.used} of ${exception.allowance} in use). ` +
                    'Add seats in /settings/billing, or archive an agent or remove a member.',
                used: exception.used,
                allowance: exception.allowance,
                timestamp: new Date().toISOString(),
            },
            status,
        );
    }
}
