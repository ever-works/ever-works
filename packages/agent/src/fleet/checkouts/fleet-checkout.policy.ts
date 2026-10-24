import {
    FLEET_CHECKOUT_CREATING_STALE_MS,
    parseFleetGitLine,
    type FleetCheckoutCreatedBy,
    type FleetGitLine,
    type FleetCheckoutLastCommand,
    type FleetCheckoutState,
    type FleetNodeCheckoutOrigin,
    type FleetNodeCheckoutRecord,
} from '@ever-works/contracts';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';

/**
 * Checkouts on computers (FL-14) — the pure rules of the checkout row's state
 * (spec §1, FR-11, FR-13, U14), kept out of the service so the whole state
 * machine is a table in a spec.
 *
 *              node reports present            node reports gone / omits it
 *   (none)  →  ready                           missing
 *   ready   →  ready                           missing
 *   missing →  ready ("the folder is back")    missing
 *   creating → ready                           creating (until its operation ends, or the 10-minute sweep)
 *   archived → archived (facts refreshed)      archived (the bin keeps it)
 *
 * The node is the source of truth for the FOLDER; the platform for the BIN —
 * nothing the node reports takes a row out of the bin.
 */

/** What a node origin becomes as the row's creator, on a row the node made known. */
export function createdByFromOrigin(origin: FleetNodeCheckoutOrigin): FleetCheckoutCreatedBy {
    switch (origin) {
        case 'task':
            return 'task';
        case 'platform':
            return 'user';
        case 'discovery':
        default:
            return 'discovery';
    }
}

/** The state a row moves to when the node reports on its folder. */
export function nextCheckoutState(
    current: FleetCheckoutState | null,
    present: boolean,
): FleetCheckoutState {
    if (current === 'archived') return 'archived';
    if (current === 'creating') return present ? 'ready' : 'creating';
    return present ? 'ready' : 'missing';
}

/**
 * FL-06 (spec FR-7): the node never knows the pull request — its git line
 * always carries `pr: null`. The platform's resolved `pr` survives a node
 * refresh while the branch is the one it was resolved for; a branch change
 * drops it (the enrichment resolves the new branch within a minute).
 */
export function withKnownPullRequest(
    next: FleetGitLine,
    previous: FleetGitLine | Record<string, unknown> | null,
): FleetGitLine {
    if (next.pr) return next;
    const known = previous ? parseFleetGitLine(previous) : null;
    if (!known?.pr || known.branch !== next.branch) return next;
    return { ...next, pr: known.pr };
}

/** The columns a node record writes. `row` null = the first time the platform hears of it. */
export function checkoutPatchFromRecord(
    row: Pick<
        FleetCheckout,
        'state' | 'gitLine' | 'sizeBytes' | 'lastSeenAt' | 'branch' | 'baseRef' | 'remoteUrl'
    > | null,
    record: FleetNodeCheckoutRecord,
    now: Date,
): Partial<FleetCheckout> {
    const patch: Partial<FleetCheckout> = {
        state: nextCheckoutState(row?.state ?? null, record.present),
    };
    // A folder that is gone keeps its last-known facts: the row says what it
    // WAS, dimmed, rather than going blank (spec FR-15).
    if (record.present || !row) {
        patch.branch = record.branch;
        patch.baseRef = record.baseRef;
        patch.remoteUrl = record.remoteUrl;
        patch.remoteHadCredential = record.remoteHadCredential;
        patch.isolation = record.isolation;
    }
    if (record.gitLine) patch.gitLine = withKnownPullRequest(record.gitLine, row?.gitLine ?? null);
    else if (!row) patch.gitLine = null;
    if (record.sizeBytes !== null) patch.sizeBytes = record.sizeBytes;
    else if (!row) patch.sizeBytes = null;
    if (record.present) patch.lastSeenAt = now;
    else if (!row) patch.lastSeenAt = null;
    return patch;
}

/**
 * Rows a COMPLETE list did not mention: the node no longer holds them (a Task
 * worktree the reaper removed, a registry file someone deleted). They read
 * `missing` — never silently dropped — except rows in the bin, and rows still
 * being created (their own operation settles them).
 */
export function isOmittedRowMissing(
    row: Pick<FleetCheckout, 'state' | 'createdAt'>,
    now: number,
): boolean {
    if (row.state === 'archived' || row.state === 'missing') return false;
    if (row.state === 'creating') return now - toMs(row.createdAt) >= FLEET_CHECKOUT_CREATING_STALE_MS;
    return true;
}

/** True once a delete removed the folder — the bin's "folder removed" (spec FR-26): no Restore. */
export function isCheckoutFolderRemoved(
    row: Pick<FleetCheckout, 'state' | 'lastCommand'>,
): boolean {
    const last = row.lastCommand;
    return row.state === 'archived' && last?.command === 'delete' && last.exitCode === 0;
}

/** A `creating` row older than the stale window (spec §6: never a phantom `creating`). */
export function isCreatingStale(row: Pick<FleetCheckout, 'state' | 'createdAt'>, now: number): boolean {
    return row.state === 'creating' && now - toMs(row.createdAt) >= FLEET_CHECKOUT_CREATING_STALE_MS;
}

/** The `lastCommand` a stale `creating` row is closed with. */
export function staleCreatingCommand(row: Pick<FleetCheckout, 'lastCommand'>, now: Date): FleetCheckoutLastCommand {
    return {
        command: row.lastCommand?.command ?? 'clone',
        exitCode: -1,
        at: now.toISOString(),
        stderrHead: 'the computer never reported the result',
        operationId: null,
    };
}

/**
 * Per-checkout throttle for a person's Refresh (spec FR-9: no more than once
 * per 10 seconds per checkout). Pure over the last time and the window.
 */
export function refreshAllowedAt(lastAt: number | undefined, now: number, windowMs: number): number | null {
    if (lastAt === undefined || now - lastAt >= windowMs) return null;
    return lastAt + windowMs;
}

/** `sizeBytes` as a number (Postgres answers `bigint` as a string). */
export function checkoutSizeBytes(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toMs(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const at = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(at) ? at : 0;
}
