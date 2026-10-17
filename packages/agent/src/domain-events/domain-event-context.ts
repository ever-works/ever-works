import { AsyncLocalStorage } from 'node:async_hooks';
import type { DomainEventActor } from '@ever-works/contracts';

/**
 * Who and what caused the changes made inside one request or job, for the
 * domain events it records (EW-P1-1).
 *
 * Set once per HTTP request by the API's `DomainEventContextInterceptor`
 * (actor from the authenticated principal, `originTag` from `X-Sync-Origin`,
 * `correlationId` from the request id), or by a background job around its own
 * work with {@link runWithDomainEventContext}. The recorder reads it when a
 * caller does not pass an actor or origin explicitly.
 *
 * A module-level `AsyncLocalStorage` rather than a request-scoped provider for
 * the same reason as the API's `ScopeContextService`: request-scoped DI would
 * make every service that records an event request-scoped too.
 */
export interface DomainEventContext {
    readonly actor?: DomainEventActor;
    /** `X-Sync-Origin` of the request, e.g. `gauzy:<connectionId>`. */
    readonly originTag?: string | null;
    /** The integration key the request authenticated with. */
    readonly integrationKeyId?: string | null;
    readonly correlationId?: string | null;
}

const storage = new AsyncLocalStorage<DomainEventContext>();

/** Run `fn` with `context` as the active domain event context. Nested calls replace it. */
export function runWithDomainEventContext<T>(context: DomainEventContext, fn: () => T): T {
    return storage.run(context, fn);
}

/** The active context, or `undefined` outside any {@link runWithDomainEventContext}. */
export function getDomainEventContext(): DomainEventContext | undefined {
    return storage.getStore();
}

/**
 * Normalise an `X-Sync-Origin` header value: trimmed, at most 100 printable
 * ASCII characters, else `null` (an invalid origin is dropped rather than
 * failing the write — it only steers loop prevention).
 */
export function normalizeSyncOrigin(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 100 || !/^[\x21-\x7e]+$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Integration API v1 `If-Match` (EW-P1-4, contract v1 B.1): a write that must
 * apply to a known version of its aggregate. The route checks the version
 * before calling the domain service (the fast `412`), and runs the call with
 * {@link runExpectingAggregateVersion}; the publisher then checks again at the
 * version bump, INSIDE the write's transaction and under the row lock the bump
 * takes. A concurrent writer that got there first makes the bump land on a
 * different version: the publisher throws this error and the whole write rolls
 * back, so two requests that read the same version can never both succeed.
 */
export class AggregateVersionConflictError extends Error {
    constructor(
        readonly aggregateType: string,
        readonly aggregateId: string,
        readonly expected: number,
        readonly actual: number,
    ) {
        super(
            `${aggregateType} ${aggregateId} is at version ${actual}, not the expected ${expected}.`,
        );
        this.name = 'AggregateVersionConflictError';
    }
}

interface AggregateVersionExpectation {
    readonly aggregateType: string;
    readonly id: string;
    readonly version: number;
    checked: boolean;
}

const versionExpectations = new AsyncLocalStorage<AggregateVersionExpectation>();

/**
 * Run `fn` expecting the FIRST version bump of `aggregateType`/`id` inside it
 * to move the aggregate from `version` to `version + 1`.
 */
export function runExpectingAggregateVersion<T>(
    expectation: { aggregateType: string; id: string; version: number },
    fn: () => Promise<T>,
): Promise<T> {
    return versionExpectations.run({ ...expectation, checked: false }, fn);
}

interface ClaimedAggregateVersion {
    readonly aggregateType: string;
    readonly id: string;
    readonly version: number;
    taken: boolean;
}

const claimedVersions = new AsyncLocalStorage<ClaimedAggregateVersion>();

/**
 * Run `fn` after its caller CLAIMED the next version of `aggregateType`/`id`:
 * a compare-and-set (`UPDATE … SET version = version + 1 WHERE id = ? AND
 * version = ?`) already moved the row to `version`. The FIRST version step
 * recorded for that aggregate inside `fn` (`changed`, `beforeDelete`) carries `version` instead of bumping
 * again, so an `If-Match` write that records its event after the write (its own
 * transaction) is still one version, taken atomically before the write.
 */
export function runWithClaimedAggregateVersion<T>(
    claim: { aggregateType: string; id: string; version: number },
    fn: () => Promise<T>,
): Promise<T> {
    return claimedVersions.run({ ...claim, taken: false }, fn);
}

/** The claimed version of this aggregate, once (`null` when there is none). */
export function takeClaimedAggregateVersion(aggregateType: string, id: string): number | null {
    const claim = claimedVersions.getStore();
    if (!claim || claim.taken || claim.aggregateType !== aggregateType || claim.id !== id) {
        return null;
    }
    claim.taken = true;
    return claim.version;
}

/**
 * Called by the publisher right after it bumps an aggregate's version: throws
 * {@link AggregateVersionConflictError} when the active expectation names this
 * aggregate and the bump did not start from the expected version. Only the
 * first bump of that aggregate is checked (a write may bump it again, e.g. a
 * task PATCH that also moves its teams).
 */
export function assertExpectedAggregateVersion(
    aggregateType: string,
    id: string,
    bumpedTo: number,
): void {
    const expectation = versionExpectations.getStore();
    if (
        !expectation ||
        expectation.checked ||
        expectation.aggregateType !== aggregateType ||
        expectation.id !== id
    ) {
        return;
    }
    expectation.checked = true;
    if (bumpedTo !== expectation.version + 1) {
        throw new AggregateVersionConflictError(
            aggregateType,
            id,
            expectation.version,
            bumpedTo - 1,
        );
    }
}

/**
 * Clear a loaded aggregate's `version` before a TypeORM `save()` (EW-P2 review).
 * `version` is a plain column that only {@link DomainEventRecorder.bumpAggregateVersion}
 * moves; `save()` writes back whatever the instance holds, so a copy loaded before a
 * concurrent bump would roll the column back and the next event would reuse a version.
 * TypeORM skips an `undefined` property on update (and uses the column default on insert).
 * Returns the same instance.
 */
export function withoutAggregateVersion<T extends { version?: number }>(entity: T): T {
    (entity as { version?: number }).version = undefined;
    return entity;
}
