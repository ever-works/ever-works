import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { MODEL_POLICY_SCHEDULE_SOURCES, parseModelPolicyScheduleKey } from '@ever-works/contracts';

/**
 * Model accounts (AW-16) — query parameters of
 * `GET /api/model-policies/resolved`.
 *
 * Per-parameter pipes rather than a query DTO on purpose: the global
 * `ValidationPipe` forbids unknown properties, and a DTO would turn any extra
 * query parameter a client adds into a 400. An absent or empty value still
 * means "not given", exactly as before.
 */

function isAbsent(value: unknown): boolean {
    return value === undefined || value === null || value === '';
}

function invalid(message: string): BadRequestException {
    return new BadRequestException({ code: 'invalid_policy', message });
}

/** True for `${source}:${ownerId}` with a known schedule source and a UUID owner. */
export function isModelPolicyScheduleId(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parsed = parseModelPolicyScheduleKey(value);
    return (
        !!parsed &&
        (MODEL_POLICY_SCHEDULE_SOURCES as readonly string[]).includes(parsed.source) &&
        isUUID(parsed.ownerId)
    );
}

/** `agentId`: absent, or an Agent id (UUID) — otherwise 400. */
@Injectable()
export class OptionalAgentIdQueryPipe implements PipeTransform<unknown, string | undefined> {
    transform(value: unknown): string | undefined {
        if (isAbsent(value)) return undefined;
        if (typeof value === 'string' && isUUID(value)) return value;
        throw invalid('agentId must be an Agent id.');
    }
}

/**
 * `scheduleId`: absent, or `${source}:${ownerId}` — a known schedule source
 * and a UUID owner, the same pair the schedule routes accept — otherwise 400.
 */
@Injectable()
export class OptionalScheduleIdQueryPipe implements PipeTransform<unknown, string | undefined> {
    transform(value: unknown): string | undefined {
        if (isAbsent(value)) return undefined;
        if (isModelPolicyScheduleId(value)) return value;
        throw invalid('Unknown schedule.');
    }
}
