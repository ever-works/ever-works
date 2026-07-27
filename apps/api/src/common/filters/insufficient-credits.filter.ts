import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InsufficientCreditsError } from '@ever-works/agent/subscriptions';

/**
 * Maps credit-balance exhaustion to HTTP **402 Payment Required** at the
 * API boundary. Sibling of `FacadeExceptionFilter` — same shape, same
 * map-by-stable-`.name` design, same no-leak posture.
 *
 * WHY THIS EXISTS
 * ---------------
 * `CreditLedgerService.record()` rejects a debit that would take the
 * balance below zero (overdraft off — `CREDITS_ALLOW_OVERDRAFT`, default
 * false) with `InsufficientCreditsError`, a plain `Error` — NOT a NestJS
 * `HttpException`. Nothing in `apps/api` referenced that class, so any
 * spend attempt that reached a controller UNCAUGHT became a generic HTTP
 * 500 via Nest's `BaseExceptionFilter`. That mislabels the single most
 * caller-actionable condition the billing surface has ("you are out of
 * credits — top up") as a server fault, and the billing/usage PRD §6 is
 * explicit that balance exhaustion must never surface as an unmapped 500.
 *
 * It also had a concrete cost on the worker RPC path: the Trigger.dev
 * worker's `TriggerInternalApiClient` retries 5xx three times with
 * exponential backoff. An exhausted balance is deterministic — retrying
 * it is pure waste. A 402 is terminal for that client.
 *
 * WHY 402 AND NOT 409
 * -------------------
 * The codebase already has a spend-exhaustion status, and it is 402:
 * `BudgetExceededException` (packages/agent/src/budgets) throws
 * `HttpStatus.PAYMENT_REQUIRED` with `error: 'BudgetExceeded'` when a
 * Work hits its monthly cap. Credit exhaustion is the same class of
 * condition, so it takes the same status and the same `error` code shape
 * (`'InsufficientCredits'`). 409 is spoken-for in the sibling filter with
 * a DIFFERENT meaning — "a precondition you resolve by CONFIGURING
 * something" (no provider enabled, no credentials connected) — and
 * overloading it would make the two indistinguishable to a client.
 * `apps/web` already treats 402 as the quota/credits signal (see the
 * generation-enqueue and usage-quota e2e specs).
 *
 * DESIGN NOTES
 * ------------
 * - Map by stable `.name`, not by class identity. `InsufficientCreditsError`
 *   assigns `this.name` explicitly in its constructor, so the mapping
 *   survives minification and any future sibling/subclass. An unlisted
 *   name falls through to a generic 500 — the conservative default,
 *   identical to `FacadeExceptionFilter`.
 * - HTTP-ONLY by construction: a global exception filter runs only in the
 *   HTTP request pipeline. The same error thrown inside the run-cost
 *   settlement hook, a BullMQ worker or a Trigger.dev task is handled by
 *   that caller's own policy (settlement records a partial debit and
 *   notifies — PRD §6) and never reaches here.
 * - ADDITIVE: nothing catches `InsufficientCreditsError` in a controller
 *   today, so this filter only nets previously-unmapped 500s. Any future
 *   controller-local `try/catch` that converts it to an `HttpException`
 *   wins, because an `HttpException` is not an `InsufficientCreditsError`.
 *
 * NO LEAK
 * -------
 * The thrown error carries `userId`, `requestedCredits`, `balanceCredits`
 * and a message that interpolates the last two. NONE of it is echoed. The
 * filter cannot prove the HTTP caller owns the balance — the
 * signature-authenticated `/internal/trigger/remote/call` RPC route
 * reaches this filter too — so the body is owner-agnostic and constant.
 * The owner reads exact figures from the owner-scoped
 * `GET /api/credits/balance`.
 */

/** Stable, caller-facing body text. Contains no identifiers and no state. */
export const INSUFFICIENT_CREDITS_MESSAGE =
    'Insufficient credits. Top up your balance in /settings/billing to continue.';

/**
 * Machine-readable `error` code. Matches the un-suffixed shape the other
 * 402 in this codebase uses (`BudgetExceeded`) so clients can branch on
 * one convention.
 */
export const INSUFFICIENT_CREDITS_ERROR_CODE = 'InsufficientCredits';

/**
 * `error.name` → HTTP status. Anything not listed falls through to 500
 * with the generic body (unchanged Nest behaviour).
 */
const CREDITS_ERROR_STATUS: Readonly<Record<string, HttpStatus>> = {
    InsufficientCreditsError: HttpStatus.PAYMENT_REQUIRED,
};

@Catch(InsufficientCreditsError)
export class InsufficientCreditsExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(InsufficientCreditsExceptionFilter.name);

    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: InsufficientCreditsError, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;
        const ctx = host.switchToHttp();
        const request = ctx.getRequest();

        const status = CREDITS_ERROR_STATUS[exception.name] ?? HttpStatus.INTERNAL_SERVER_ERROR;
        const isClientError = status < HttpStatus.INTERNAL_SERVER_ERROR;

        if (!isClientError) {
            // An unlisted subclass reached the boundary — a signal that a
            // new mapping is needed. Logged server-side only; the client
            // still gets the generic 500 body.
            this.logger.error(
                `Unmapped credits error (${exception.name}) on ` +
                    `${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}`,
                exception.stack,
            );
        }

        // Mirror Nest's HttpException JSON shape. The 402 body is a
        // constant — the error's own message interpolates the balance, and
        // its fields carry the owner's userId, so neither is surfaced.
        const body = isClientError
            ? {
                  statusCode: status,
                  message: INSUFFICIENT_CREDITS_MESSAGE,
                  error: INSUFFICIENT_CREDITS_ERROR_CODE,
              }
            : {
                  statusCode: status,
                  message: 'Internal server error',
                  error: 'Internal Server Error',
              };

        httpAdapter.reply(ctx.getResponse(), body, status);
    }
}
