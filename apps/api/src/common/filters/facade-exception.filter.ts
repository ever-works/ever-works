import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FacadeError } from '@ever-works/agent/facades';

/**
 * Maps the `@ever-works/agent` `FacadeError` hierarchy to HTTP status
 * codes at the API boundary.
 *
 * WHY THIS EXISTS
 * ---------------
 * Facade methods (git / deploy / oauth / content-extractor / …) throw
 * `FacadeError` subclasses, which are plain `Error`s — NOT NestJS
 * `HttpException`s. When such an error reaches a controller WITHOUT a
 * local try/catch (e.g. `POST /api/templates/fork` → `NoGitProviderError`
 * because no git provider is connected), Nest's built-in
 * `BaseExceptionFilter` turns it into a generic HTTP 500. That mislabels
 * caller-actionable precondition failures ("connect GitHub first",
 * "enable a provider") as server faults.
 *
 * This filter converts the SPECIFIC, semantically-meaningful leaf errors
 * to the correct 4xx. Everything else — the generic `*FacadeError`
 * wrappers (`AiFacadeError`, `SearchFacadeError`, the bare bases, …),
 * which represent genuine upstream/internal failures — stays a 500,
 * exactly as before this filter existed.
 *
 * DESIGN NOTES
 * ------------
 * - The hierarchy is intentionally INCONSISTENT: `NoGitProviderError`
 *   extends `GitFacadeError` (not `NoProviderError`), `NoDeployProviderError`
 *   extends `DeployFacadeError`, etc. So we cannot map by a single base
 *   `instanceof`. Each leaf assigns a stable `this.name` in its
 *   constructor, so we map by that name string — robust to minification
 *   (the name is an explicit assignment, not `constructor.name`) and
 *   immune to the inconsistent class tree.
 * - HTTP-ONLY by construction: a global exception filter runs only in
 *   the HTTP request pipeline. FacadeErrors thrown in BullMQ workers,
 *   Trigger.dev tasks, the internal-CLI, or generation pipelines are
 *   never touched — so this can't wrongly 4xx a background failure.
 * - ADDITIVE: controllers that already catch a `FacadeError` and convert
 *   it to an `HttpException` (search / screenshot / agent-memory) are
 *   unaffected — their `HttpException` is not a `FacadeError`, so
 *   `@Catch(FacadeError)` never sees it. This filter only nets the
 *   currently-UNCAUGHT cases.
 * - NO INFO LEAK: Nest's default filter hides a non-HttpException's
 *   message behind "Internal server error". We preserve that for the
 *   500 fall-through (only the intentional, safe 4xx messages — "No Git
 *   provider configured" — are surfaced to the client).
 */

/**
 * `error.name` → HTTP status for the caller-actionable facade leaves.
 * Anything not listed falls through to 500 (unchanged behaviour).
 */
const FACADE_ERROR_STATUS: Readonly<Record<string, HttpStatus>> = {
    // "no provider configured / enabled for this capability" — a
    // precondition the caller resolves by enabling a plugin.
    NoProviderError: HttpStatus.CONFLICT,
    NoGitProviderError: HttpStatus.CONFLICT,
    NoDeployProviderError: HttpStatus.CONFLICT,
    NoOAuthProviderError: HttpStatus.CONFLICT,
    NoContentExtractorProviderError: HttpStatus.CONFLICT,
    // "the named providerId does not exist among loaded plugins".
    ProviderNotFoundError: HttpStatus.NOT_FOUND,
    GitProviderNotFoundError: HttpStatus.NOT_FOUND,
    DeployProviderNotFoundError: HttpStatus.NOT_FOUND,
    OAuthProviderNotFoundError: HttpStatus.NOT_FOUND,
    ContentExtractorProviderNotFoundError: HttpStatus.NOT_FOUND,
    // "no connected account / credentials for this user+provider" —
    // resolved by connecting the account or adding a token.
    NoGitCredentialsError: HttpStatus.CONFLICT,
    NoDeployCredentialsError: HttpStatus.CONFLICT,
    // "the resolved plugin does not implement this operation".
    OAuthNotSupportedError: HttpStatus.BAD_REQUEST,
};

@Catch(FacadeError)
export class FacadeExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(FacadeExceptionFilter.name);

    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: FacadeError, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;
        const ctx = host.switchToHttp();
        const request = ctx.getRequest();

        const status = FACADE_ERROR_STATUS[exception.name] ?? HttpStatus.INTERNAL_SERVER_ERROR;
        const isClientError = status < HttpStatus.INTERNAL_SERVER_ERROR;

        if (!isClientError) {
            // Unmapped facade wrapper → genuine 500. Log it with the
            // operation/provider context the facade attached (these are a
            // signal that an upstream provider failed, or that a new leaf
            // class needs a mapping above).
            this.logger.error(
                `Unmapped facade error (${exception.name}) [op=${exception.operation}` +
                    `${exception.provider ? ` provider=${exception.provider}` : ''}] ` +
                    `on ${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}: ` +
                    `${exception.message}`,
                exception.stack,
            );
        }

        // Mirror Nest's HttpException JSON shape. Surface the facade's own
        // message ONLY for the mapped 4xx (those messages are intentional
        // and caller-facing); keep the generic body for the 500 so we
        // don't leak internal detail the default filter would have hidden.
        const body = isClientError
            ? { statusCode: status, message: exception.message, error: exception.name }
            : {
                  statusCode: status,
                  message: 'Internal server error',
                  error: 'Internal Server Error',
              };

        httpAdapter.reply(ctx.getResponse(), body, status);
    }
}
