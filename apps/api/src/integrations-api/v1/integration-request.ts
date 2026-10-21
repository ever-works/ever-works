import { runExpectingAggregateVersion } from '@ever-works/agent/domain-events';
import type { AuthenticatedUser, IntegrationPrincipal } from '../../auth/types/auth.types';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { InvalidCursorError, parseIfMatch } from '@ever-works/agent/integrations-api';
import { ValidateIf } from 'class-validator';

/**
 * Request helpers of `/api/integrations/v1` (EW-P1-4). The guards
 * (`IntegrationOnlyGuard`, `IntegrationPrincipalGuard`) have already
 * authenticated the key, checked its scopes and resolved the pinned
 * organization into the request's ownership scope.
 */

/** The integration principal of the request (`401 invalid_key` when absent). */
export function principalOf(user: AuthenticatedUser | undefined): IntegrationPrincipal {
    const principal = user?.integration;
    if (!principal) {
        throw new IntegrationHttpException(401, 'invalid_key', 'Invalid integration key.');
    }
    return principal;
}

/** The pinned organization the request acts in (`403 org_not_pinned` when none). */
export function pinnedOrganizationOf(organizationId: string | null | undefined): string {
    if (!organizationId) {
        throw new IntegrationHttpException(
            403,
            'org_not_pinned',
            'Name one of the organizations this key is pinned to in X-Scope-Slug (or X-Organization-Id).',
        );
    }
    return organizationId;
}

/**
 * The `externalLinks` / `links` source of the key: `ever-gauzy` keys link as
 * `gauzy` (contract v1: the link `source` comes from the key's integrationKind).
 */
export function linkSourceOf(principal: IntegrationPrincipal): string {
    return principal.integrationKind === 'ever-gauzy'
        ? 'gauzy'
        : principal.integrationKind || 'generic';
}

/** `?updatedSince=<ISO>` → Date (`400 validation_failed` when not a date). */
export function parseUpdatedSince(value: string | undefined): Date | null {
    if (value === undefined || value === '') return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        throw validationFailed('updatedSince', 'must be an ISO 8601 date-time');
    return new Date(time);
}

/** `?limit=` → number | undefined (`400 validation_failed` when not an integer). */
export function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (!/^\d{1,6}$/.test(value)) throw validationFailed('limit', 'must be a positive integer');
    return Number(value);
}

/** Comma-separated or repeated query values, trimmed, empties dropped. */
export function listParam(value: string | string[] | undefined): string[] {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function validationFailed(path: string, message: string): IntegrationHttpException {
    return new IntegrationHttpException(400, 'validation_failed', `${path} ${message}`, {
        fields: [{ path, message }],
    });
}

/** Re-throws {@link InvalidCursorError} as `400 validation_failed` on `cursor`. */
export function rethrowCursor(error: unknown): never {
    if (error instanceof InvalidCursorError) throw validationFailed('cursor', error.message);
    throw error;
}

/**
 * An `externalRef` names the caller's own source (`ever-gauzy` -> `gauzy`): a
 * key may never claim, or look up, another integration's references.
 */
export function assertOwnLinkSource(ref: { source: string } | undefined, source: string): void {
    if (ref && ref.source !== source) {
        throw validationFailed('externalRef.source', `must be "${source}", the source of this key`);
    }
}

/**
 * Run a write under its `If-Match` version (`null`: no precondition). The
 * publisher re-checks it at the version bump inside the write's transaction,
 * so of two writers that read the same version only the first succeeds; the
 * other answers `412`.
 */
export function withExpectedVersion<T>(
    aggregateType: string,
    id: string,
    expected: number | null,
    fn: () => Promise<T>,
): Promise<T> {
    if (expected === null) return fn();
    return runExpectingAggregateVersion({ aggregateType, id, version: expected }, fn);
}

/**
 * `If-Match` → version | null (no precondition); `400 validation_failed` when the
 * header is not an ETag this API issued (`"<version>"`).
 */
export function expectedVersionOf(header: string | undefined): number | null {
    const parsed = parseIfMatch(header);
    if (parsed === undefined) {
        throw validationFailed('If-Match', 'must be the "<version>" ETag of the record');
    }
    return parsed;
}

/**
 * Integrations may set `team` or `organization` only (contract v1 B.1):
 * `private` answers `422 domain_rule` (the record would vanish from the
 * integration's own view), anything else `400 validation_failed`.
 */
export function assertWritableVisibility(visibility: string | undefined): void {
    if (visibility === undefined) return;
    if (visibility === 'private') {
        throw new IntegrationHttpException(
            422,
            'domain_rule',
            'An integration cannot make a record private.',
            { field: 'visibility' },
        );
    }
    if (visibility !== 'team' && visibility !== 'organization') {
        throw validationFailed('visibility', 'must be team or organization');
    }
}

/**
 * `422 domain_rule` for a write the record's state refuses (e.g. dismissing an
 * Idea that is being built). `details.status` names the current state.
 */
export function domainRule(
    message: string,
    details?: Record<string, unknown>,
): IntegrationHttpException {
    return new IntegrationHttpException(422, 'domain_rule', message, details);
}

/**
 * Review 2026-10-17 F39: an optional request field the contract does NOT make
 * nullable. Absent skips its validation as `@IsOptional()` does, but `null` is
 * validated like any value, so it answers `400 validation_failed` instead of
 * reaching a NOT NULL column or a `.trim()` (500).
 */
export function IsOptionalNonNull(): PropertyDecorator {
    return ValidateIf((_object: object, value: unknown) => value !== undefined);
}
