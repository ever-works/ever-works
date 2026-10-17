import { ConflictException } from '@nestjs/common';
import { TaskStatus } from '../entities/task.entity';

/**
 * EW-P1-6 — sync transitions (integration contract v1, `POST
 * /tasks/:id/transition {to, mode:'sync'}`).
 *
 * An integration mirrors a status another system already decided (a Gauzy
 * task moved straight from "Open" to "Done"). Ever Works' state machine only
 * moves one legal edge at a time, so a sync transition walks the SHORTEST
 * legal path through the lattice, hop by hop, every hop through the ordinary
 * gated `transition()`. This file holds the pure parts: the path search and
 * the 409 the walk answers when a gate refuses.
 */

/**
 * Breadth-first shortest legal path from `from` to `to` through `allowed`.
 *
 * Returns the statuses AFTER `from`, ending with `to` (`[]` when they are
 * equal), or `null` when `to` is unreachable. Ties between equally short
 * paths resolve by the order of each status's `allowed` list, so the walk is
 * deterministic: the same move always takes the same path.
 */
export function shortestTransitionPath(
    from: TaskStatus,
    to: TaskStatus,
    allowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>>,
): TaskStatus[] | null {
    if (from === to) return [];
    const previous = new Map<TaskStatus, TaskStatus>();
    const seen = new Set<TaskStatus>([from]);
    const queue: TaskStatus[] = [from];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of allowed[current] ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            previous.set(next, current);
            if (next === to) {
                const path: TaskStatus[] = [to];
                let cursor = current;
                while (cursor !== from) {
                    path.unshift(cursor);
                    cursor = previous.get(cursor)!;
                }
                return path;
            }
            queue.push(next);
        }
    }
    return null;
}

/** One open blocker as the `transition_blocked` details list it. */
export interface TransitionBlocker {
    taskId: string;
    slug: string | null;
    title: string | null;
    status: string | null;
}

/** One approver whose decision does not (yet) let the Task reach `done`. */
export interface TransitionPendingApprover {
    type: 'user' | 'agent';
    id: string;
    state: 'pending' | 'rejected';
}

export interface TransitionBlockedDetails {
    from: TaskStatus;
    to: TaskStatus;
    blockers: TransitionBlocker[];
    pendingApprovers: TransitionPendingApprover[];
    /** The legal path attempted (statuses after `from`), up to and including the hop that was refused. */
    path: TaskStatus[];
}

/**
 * `409 transition_blocked` in the integration error envelope (contract v1
 * B.1): `{ "error": { "code": "transition_blocked", "message", "details": {
 * from, to, blockers[], pendingApprovers[], path[] } } }`.
 *
 * A `ConflictException`, so every existing `instanceof ConflictException`
 * check and the HTTP status (409) stay what a gate refusal always was.
 */
export class TaskTransitionBlockedException extends ConflictException {
    readonly details: TransitionBlockedDetails;

    constructor(message: string, details: TransitionBlockedDetails) {
        super({ error: { code: 'transition_blocked', message, details } });
        this.details = details;
    }
}

export interface TransitionConflictDetails {
    from: TaskStatus;
    to: TaskStatus;
    /** The legal path attempted (statuses after `from`), up to and including the hop that lost. */
    path: TaskStatus[];
    /** The status someone else moved the Task to while the walk was running. */
    currentStatus: TaskStatus;
}

/**
 * `409 conflict` in the integration error envelope: a sync walk LOST a race —
 * another writer moved the Task between two hops, so the hop's compare-and-set
 * found a different status. Not `transition_blocked`: no gate refused, and a
 * consumer that reverts its own status on `transition_blocked` must not do so
 * here; it re-reads the Task and retries from `currentStatus`.
 */
export class TaskTransitionConflictException extends ConflictException {
    readonly details: TransitionConflictDetails;

    constructor(message: string, details: TransitionConflictDetails) {
        super({ error: { code: 'conflict', message, details } });
        this.details = details;
    }
}
