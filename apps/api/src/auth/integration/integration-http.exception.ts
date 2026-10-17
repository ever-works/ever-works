import { HttpException } from '@nestjs/common';
import type { IntegrationErrorCode } from '@ever-works/contracts';

/**
 * EW-P1-2 — an error in the integration error envelope (contract v1, B.1):
 *
 * ```json
 * { "error": { "code": "scope_missing", "message": "…", "details": {} } }
 * ```
 *
 * Thrown by the integration guards for integration principals only, so every
 * other caller keeps the response shape it has today. `code` is the stable,
 * machine-readable key a client branches on; `message` is for people.
 */
export class IntegrationHttpException extends HttpException {
    readonly code: IntegrationErrorCode;

    constructor(
        status: number,
        code: IntegrationErrorCode,
        message: string,
        details?: Record<string, unknown>,
    ) {
        const error: {
            code: IntegrationErrorCode;
            message: string;
            details?: Record<string, unknown>;
        } = {
            code,
            message,
        };
        if (details) error.details = details;
        super({ error }, status);
        this.code = code;
    }
}
