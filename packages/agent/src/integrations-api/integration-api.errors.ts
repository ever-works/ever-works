/**
 * Domain errors of the integration API v1 building blocks (EW-P1-4). The API
 * layer maps each to its contract error envelope (B.1):
 *
 * | error                             | status | code                     |
 * | --------------------------------- | ------ | ------------------------ |
 * | {@link VersionMismatchError}      | 412    | `version_mismatch`       |
 * | {@link DuplicateExternalRefError} | 409    | `duplicate_external_ref` |
 * | {@link IdempotencyConflictError}  | 409    | `conflict`               |
 * | {@link InvalidCursorError}        | 400    | `validation_failed`      |
 * | {@link ResourceNotFoundError}     | 404    | `not_found`              |
 */

/** `If-Match` named a version the aggregate no longer has. */
export class VersionMismatchError extends Error {
    constructor(
        readonly expected: number,
        readonly current: number,
    ) {
        super(`If-Match expected version ${expected}, the record is at version ${current}`);
        this.name = 'VersionMismatchError';
    }
}

/** The external record (or the Ever Works record) is already linked to another one. */
export class DuplicateExternalRefError extends Error {
    constructor(
        readonly side: 'external' | 'entity',
        readonly existingEntityId: string,
        readonly existingExternalId: string,
    ) {
        super(
            side === 'external'
                ? `External record ${existingExternalId} is already linked to ${existingEntityId}`
                : `Record ${existingEntityId} is already linked to external record ${existingExternalId}`,
        );
        this.name = 'DuplicateExternalRefError';
    }
}

/** The same `Idempotency-Key` with a different request, or while the first one still runs. */
export class IdempotencyConflictError extends Error {
    constructor(readonly reason: 'request_mismatch' | 'in_progress') {
        super(
            reason === 'request_mismatch'
                ? 'This Idempotency-Key was already used with a different request'
                : 'A request with this Idempotency-Key is still in progress',
        );
        this.name = 'IdempotencyConflictError';
    }
}

/** A list cursor that is not one this API issued. */
export class InvalidCursorError extends Error {
    constructor() {
        super('cursor is not a cursor this API issued; pass nextCursor back unchanged');
        this.name = 'InvalidCursorError';
    }
}

/** No such record in the caller's organization (or not one it may see). */
export class ResourceNotFoundError extends Error {
    constructor(
        readonly kind: string,
        readonly id: string,
    ) {
        super(`No ${kind} ${id} in this organization`);
        this.name = 'ResourceNotFoundError';
    }
}
