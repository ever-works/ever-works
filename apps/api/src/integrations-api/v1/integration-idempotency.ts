import {
    IDEMPOTENCY_KEY_MAX_LENGTH,
    idempotencyRequestHash,
    type IntegrationIdempotencyService,
} from '@ever-works/agent/integrations-api';
import type { IntegrationPrincipal } from '../../auth/types/auth.types';
import { validationFailed } from './integration-request';

/** The request bits an idempotent create needs. */
export interface IdempotentRequest {
    readonly method?: string;
    readonly originalUrl?: string;
    readonly url?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string | string[] | undefined>;
}

/** The response bits it sets. */
export interface IdempotentResponse {
    status(code: number): unknown;
    setHeader(name: string, value: string): unknown;
}

/** Answers `Idempotent-Replayed: true` on a replayed response. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Run a create under its `Idempotency-Key` (contract v1 B.1): required on every
 * POST that creates something, at most 128 characters, scoped to the
 * integration key, replayed for 24 h. `work` answers the status (201 for a new
 * record, 200 for an `externalRef` that already exists) and the body.
 */
export async function runIdempotent(
    idempotency: IntegrationIdempotencyService,
    principal: IntegrationPrincipal,
    req: IdempotentRequest,
    res: IdempotentResponse,
    work: () => Promise<{ status: number; body: unknown }>,
): Promise<unknown> {
    const header = req.headers?.['idempotency-key'];
    const key = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!key) throw validationFailed('Idempotency-Key', 'header is required on creates');
    if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
        throw validationFailed(
            'Idempotency-Key',
            `must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        );
    }
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const result = await idempotency.run(
        {
            integrationKeyId: principal.keyId,
            idempotencyKey: key,
            requestHash: idempotencyRequestHash(req.method ?? 'POST', path, req.body),
        },
        work,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return result.body;
}
