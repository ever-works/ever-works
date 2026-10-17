import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { IntegrationErrorCode } from '@ever-works/contracts';
import {
    AggregateVersionConflictError,
    DomainEventCursorExpiredError,
} from '@ever-works/agent/domain-events';
import {
    DuplicateExternalRefError,
    IdempotencyConflictError,
    InvalidCursorError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';

interface Envelope {
    readonly status: number;
    readonly code: IntegrationErrorCode;
    readonly message: string;
    readonly details?: Record<string, unknown>;
}

const CODE_BY_STATUS: Readonly<Record<number, IntegrationErrorCode>> = {
    400: 'validation_failed',
    401: 'invalid_key',
    404: 'not_found',
    409: 'conflict',
    410: 'cursor_expired',
    412: 'version_mismatch',
    422: 'domain_rule',
    429: 'rate_limited',
};

/**
 * Every error of `/api/integrations/v1` answers the contract envelope
 * (contract v1 B.1): `{ "error": { "code", "message", "details"? } }`.
 *
 * - `IntegrationHttpException` (guards, routes) passes through unchanged.
 * - The building blocks' domain errors map to their codes: cursor below the
 *   retention floor → `410 cursor_expired`; foreign list cursor →
 *   `400 validation_failed`; stale `If-Match` → `412 version_mismatch`;
 *   either side already linked → `409 duplicate_external_ref`; an
 *   `Idempotency-Key` reused for another request or still running →
 *   `409 conflict`.
 * - Other `HttpException`s keep their status and get the code of that status.
 *   A `ValidationPipe` 400 lists its messages as `details.fields`. A 403 from a
 *   domain service (a row outside what the key may touch) answers
 *   `404 not_found`: integrations never learn that a foreign id exists.
 * - Anything else is `500 internal_error`, logged, with no internals leaked.
 */
@Catch()
export class IntegrationExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(IntegrationExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<{
            status(code: number): { json(body: unknown): void };
            setHeader?(name: string, value: string): void;
        }>();
        const envelope = this.toEnvelope(exception);
        const error: Record<string, unknown> = { code: envelope.code, message: envelope.message };
        if (envelope.details) error.details = envelope.details;
        response.status(envelope.status).json({ error });
    }

    toEnvelope(exception: unknown): Envelope {
        if (exception instanceof IntegrationHttpException) {
            const body = exception.getResponse() as {
                error?: {
                    code: IntegrationErrorCode;
                    message: string;
                    details?: Record<string, unknown>;
                };
            };
            return {
                status: exception.getStatus(),
                code: body.error?.code ?? 'internal_error',
                message: body.error?.message ?? exception.message,
                details: body.error?.details,
            };
        }
        if (exception instanceof DomainEventCursorExpiredError) {
            return {
                status: HttpStatus.GONE,
                code: 'cursor_expired',
                message:
                    'The cursor is older than the retention window; resync from whoami.feedHead.',
                details: { after: exception.after, floor: exception.floor },
            };
        }
        if (exception instanceof InvalidCursorError) {
            return {
                status: HttpStatus.BAD_REQUEST,
                code: 'validation_failed',
                message: exception.message,
                details: { fields: [{ path: 'cursor', message: exception.message }] },
            };
        }
        if (exception instanceof ResourceNotFoundError) {
            return { status: HttpStatus.NOT_FOUND, code: 'not_found', message: exception.message };
        }
        if (exception instanceof AggregateVersionConflictError) {
            // The If-Match re-check inside the write's transaction lost a race.
            return {
                status: HttpStatus.PRECONDITION_FAILED,
                code: 'version_mismatch',
                message: exception.message,
                details: { expected: exception.expected, current: exception.actual },
            };
        }
        if (exception instanceof VersionMismatchError) {
            return {
                status: HttpStatus.PRECONDITION_FAILED,
                code: 'version_mismatch',
                message: exception.message,
                details: { expected: exception.expected, current: exception.current },
            };
        }
        if (exception instanceof DuplicateExternalRefError) {
            return {
                status: HttpStatus.CONFLICT,
                code: 'duplicate_external_ref',
                message: exception.message,
                details: {
                    side: exception.side,
                    entityId: exception.existingEntityId,
                    externalId: exception.existingExternalId,
                },
            };
        }
        if (exception instanceof IdempotencyConflictError) {
            return {
                status: HttpStatus.CONFLICT,
                code: 'conflict',
                message: exception.message,
                details: { reason: exception.reason },
            };
        }
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const body = exception.getResponse();
            // A domain exception already shaped as the envelope (EW-P1-6's
            // `409 transition_blocked` / `conflict` from a sync walk) keeps its
            // code and details.
            const shaped =
                typeof body === 'object' && body !== null && 'error' in body
                    ? (
                          body as {
                              error?: { code?: unknown; message?: unknown; details?: unknown };
                          }
                      ).error
                    : undefined;
            if (shaped && typeof shaped.code === 'string') {
                return {
                    status,
                    code: shaped.code as IntegrationErrorCode,
                    message:
                        typeof shaped.message === 'string' ? shaped.message : exception.message,
                    details:
                        typeof shaped.details === 'object' && shaped.details !== null
                            ? (shaped.details as Record<string, unknown>)
                            : undefined,
                };
            }
            const message =
                typeof body === 'object' && body !== null && 'message' in body
                    ? (body as { message: unknown }).message
                    : exception.message;
            if (status === HttpStatus.FORBIDDEN) {
                return { status: HttpStatus.NOT_FOUND, code: 'not_found', message: 'Not found.' };
            }
            if (status === HttpStatus.BAD_REQUEST && Array.isArray(message)) {
                return {
                    status,
                    code: 'validation_failed',
                    message: 'The request is not valid.',
                    details: {
                        fields: message.map((entry) => ({
                            path: String(entry).split(' ')[0] ?? '',
                            message: String(entry),
                        })),
                    },
                };
            }
            if (status >= 500) {
                this.logger.error(`Integration API ${status}: ${exception.message}`);
                return {
                    status,
                    code: 'internal_error',
                    message: 'Internal error; retry with back-off.',
                };
            }
            return {
                status,
                code: CODE_BY_STATUS[status] ?? (status === 403 ? 'scope_missing' : 'conflict'),
                message: typeof message === 'string' ? message : exception.message,
            };
        }
        this.logger.error(
            `Integration API unhandled error: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`,
        );
        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            code: 'internal_error',
            message: 'Internal error; retry with back-off.',
        };
    }
}
