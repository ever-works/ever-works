import {
    COMPUTER_DEAD_AFTER_MS,
    COMPUTER_QUALITIES,
    computerStallStateForAge,
    FLEET_ATTENDED_CAPABILITY,
    FLEET_BROWSER_CAPABILITY,
    FLEET_SCREEN_CAPABILITY,
    lowerComputerQuality,
    type ComputerChannel,
    type ComputerQuality,
    type ComputerStallState,
    type ComputerUnwatchableReason,
    type FleetNodeView,
} from '@ever-works/contracts';

/**
 * Agent computers — the session rules, as pure functions.
 *
 * Every decision a live view makes that is cheap to get subtly wrong in a
 * service (which machine may be watched and why not, which quality is in
 * force, when a quiet stream is stalled, how many views may be open) lives
 * here with no NestJS or TypeORM import, so each one is a one-line test and
 * the capture side of a node can import the same numbers instead of
 * re-declaring them.
 */

/** The node fields watchability depends on — a `FleetNodeView` satisfies it. */
export type ComputerWatchableNode = Pick<
    FleetNodeView,
    'kind' | 'status' | 'capabilities' | 'persisted' | 'workerState'
>;

export interface ComputerWatchability {
    /** True when at least one channel can be served. */
    watchable: boolean;
    /** The ONE reason to show when nothing can be served; null when watchable. */
    reason: ComputerUnwatchableReason | null;
    /** The channels this machine can serve today (empty exactly when not watchable). */
    servableChannels: ComputerChannel[];
    /** Why each channel it cannot serve is unavailable (per-channel reasons only). */
    channelReasons: Partial<Record<ComputerChannel, ComputerUnwatchableReason>>;
}

/** The capability tag behind the terminal channel (every node's base tag). */
export const COMPUTER_TERMINAL_CAPABILITY = 'terminal';

/**
 * May this machine be watched right now, on which channels, and if not at
 * all, the ONE reason to show.
 *
 * Precedence is fixed — cluster → disabled → paused → draining → offline →
 * not-attended → per channel — so a machine that is both offline and
 * missing a browser names the thing its owner must fix first.
 *
 * Whole-machine reasons refuse every channel:
 *  - `cluster`      — a node of the owner's own cluster; the platform never
 *                     leases work onto one, so nothing could publish.
 *  - `draining`     — enrolled and online, but its worker reports it is
 *                     winding down (`paused`) or refusing work (`quarantined`).
 *  - `not-attended` — live viewing was never switched on for that machine.
 *
 * Per-channel reasons refuse ONE channel, and a machine is unwatchable only
 * when no channel remains:
 *  - `no-browser`  — screen only: no browser and no capture backend.
 *  - `no-display`  — screen only: a browser exists, but no capture backend
 *                    on the machine can take a picture of it.
 *  - `no-terminal` — terminal only: the machine does not advertise a shell.
 *
 * So a headless server started with live viewing on is watchable on its
 * terminal, with the screen's reason reported beside it.
 */
export function resolveWatchability(node: ComputerWatchableNode): ComputerWatchability {
    const refuse = (reason: ComputerUnwatchableReason): ComputerWatchability => ({
        watchable: false,
        reason,
        servableChannels: [],
        channelReasons: {},
    });
    if (node.kind === 'k8s' || node.persisted === false) return refuse('cluster');
    if (node.status === 'disabled') return refuse('disabled');
    if (node.status === 'paused') return refuse('paused');
    if (node.workerState === 'paused' || node.workerState === 'quarantined') {
        return refuse('draining');
    }
    if (node.status !== 'online') return refuse('offline');
    const tags = new Set(node.capabilities ?? []);
    if (!tags.has(FLEET_ATTENDED_CAPABILITY)) return refuse('not-attended');

    const servableChannels: ComputerChannel[] = [];
    const channelReasons: Partial<Record<ComputerChannel, ComputerUnwatchableReason>> = {};
    if (tags.has(FLEET_SCREEN_CAPABILITY)) {
        servableChannels.push('screen');
    } else {
        channelReasons.screen = tags.has(FLEET_BROWSER_CAPABILITY) ? 'no-display' : 'no-browser';
    }
    if (tags.has(COMPUTER_TERMINAL_CAPABILITY)) {
        servableChannels.push('terminal');
    } else {
        channelReasons.terminal = 'no-terminal';
    }
    if (servableChannels.length === 0) {
        return {
            watchable: false,
            reason: channelReasons.screen ?? channelReasons.terminal ?? 'no-browser',
            servableChannels,
            channelReasons,
        };
    }
    return { watchable: true, reason: null, servableChannels, channelReasons };
}

/** The channels a node can serve today — {@link resolveWatchability}'s answer, alone. */
export function resolveComputerChannels(node: ComputerWatchableNode): ComputerChannel[] {
    return resolveWatchability(node).servableChannels;
}

/**
 * The capability tags a `computer-session` job requires — the ONE place
 * that list is built. The fleet lease matcher requires EVERY listed tag, so
 * the list is derived from the channels requested, never fixed:
 *
 *   ['screen']             -> ['attended', 'screen']
 *   ['terminal']           -> ['attended', 'terminal']
 *   ['screen', 'terminal'] -> ['attended', 'screen', 'terminal']
 *
 * `attended` rides on every session: it is the machine owner's switch for
 * live viewing, and the only server-side gate that stops an ordinary work
 * lane (which every node has, and which advertises `terminal`) from
 * leasing a live view its owner never turned on. A terminal-only session
 * never requires `screen`, so a display-less machine can serve it.
 */
export function requiredCapabilitiesForChannels(channels: readonly ComputerChannel[]): string[] {
    const tags: string[] = [FLEET_ATTENDED_CAPABILITY];
    if (channels.includes('screen')) tags.push(FLEET_SCREEN_CAPABILITY);
    if (channels.includes('terminal')) tags.push(COMPUTER_TERMINAL_CAPABILITY);
    return tags;
}

/**
 * The channels a session opens with when the owner named none: the screen
 * when the machine can show one, else the terminal. Empty when it can serve
 * neither (the open is refused before this matters).
 */
export function defaultChannelsFor(servable: readonly ComputerChannel[]): ComputerChannel[] {
    if (servable.includes('screen')) return ['screen'];
    if (servable.includes('terminal')) return ['terminal'];
    return [];
}

/** The requested quality, else the stored one, else `sharp`. */
export function resolveQuality(requested: unknown, stored?: unknown): ComputerQuality {
    if (isQuality(requested)) return requested;
    if (isQuality(stored)) return stored;
    return 'sharp';
}

function isQuality(value: unknown): value is ComputerQuality {
    return typeof value === 'string' && (COMPUTER_QUALITIES as readonly string[]).includes(value);
}

/**
 * The link thresholds (degrade / recover, stall / auto-refresh / dead) are
 * declared ONCE in `@ever-works/contracts` so the machine's capture pump,
 * the owner's browser and these rules can never disagree about a number.
 * Re-exported here under their original names, so every importer of this
 * module keeps compiling unchanged.
 */
export {
    COMPUTER_AUTO_REFRESH_AFTER_MS,
    COMPUTER_DEAD_AFTER_MS,
    COMPUTER_DEGRADE_ACK_MS,
    COMPUTER_DEGRADE_BACKLOG_FRAMES,
    COMPUTER_DEGRADE_WINDOW_MS,
    COMPUTER_RECOVER_WINDOW_MS,
    COMPUTER_STALL_AFTER_MS,
    isOverLinkLimits,
    shouldDegrade,
    shouldRecover,
    type ComputerLinkSample,
    type ComputerStallState,
} from '@ever-works/contracts';

/** The tier a degrade lands on — one step down, never a skip. */
export function degradedQuality(current: ComputerQuality): ComputerQuality {
    return lowerComputerQuality(current);
}

/** How stale the stream is, at the 6 s / 20 s / 45 s boundaries (inclusive). */
export function stallState(lastFrameAt: Date | null | undefined, now: Date): ComputerStallState {
    if (!lastFrameAt) return 'ok';
    return computerStallStateForAge(now.getTime() - lastFrameAt.getTime());
}

export interface ComputerSessionLimits {
    /** Open views per machine. Default 2, clamp 1–10. */
    perNode: number;
    /** Open views per Organization (per owner for a personal workspace). Default 5, clamp 1–50. */
    perOrganization: number;
    /** Longest a view may live. Default 4 h, clamp 15 min – 12 h. */
    maxDurationMs: number;
    /** A view with no viewer attached ends after this. Default 30 min. */
    noViewerMs: number;
    /** A watching view ends this long after its last viewer left. Default 15 s. */
    lastViewerGraceMs: number;
    /** A view no node claimed is abandoned after this. Default 40 s. */
    claimTimeoutMs: number;
}

export const COMPUTER_SESSION_LIMIT_DEFAULTS: Readonly<ComputerSessionLimits> = Object.freeze({
    perNode: 2,
    perOrganization: 5,
    maxDurationMs: 4 * 60 * 60_000,
    noViewerMs: 30 * 60_000,
    lastViewerGraceMs: 15_000,
    claimTimeoutMs: 40_000,
});

/** A whole base-10 integer and nothing else — `2oops`, `2.9`, `0x10` and `` are not. */
const WHOLE_INTEGER = /^[+-]?\d+$/;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!WHOLE_INTEGER.test(value)) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

/**
 * Operator-tunable limits, clamped. Unset or nonsense is the default; out
 * of range is clamped — no value turns a cap off.
 *
 *   `COMPUTER_SESSION_MAX_PER_NODE`           1–10
 *   `COMPUTER_SESSION_MAX_PER_ORGANIZATION`   1–50
 *   `COMPUTER_SESSION_MAX_DURATION_MINUTES`   15–720
 */
export function resolveComputerSessionLimits(
    env: Readonly<Record<string, string | undefined>>,
): ComputerSessionLimits {
    const defaults = COMPUTER_SESSION_LIMIT_DEFAULTS;
    return {
        ...defaults,
        perNode: clampInt(env.COMPUTER_SESSION_MAX_PER_NODE, defaults.perNode, 1, 10),
        perOrganization: clampInt(
            env.COMPUTER_SESSION_MAX_PER_ORGANIZATION,
            defaults.perOrganization,
            1,
            50,
        ),
        maxDurationMs:
            clampInt(
                env.COMPUTER_SESSION_MAX_DURATION_MINUTES,
                defaults.maxDurationMs / 60_000,
                15,
                720,
            ) * 60_000,
    };
}

/**
 * The operator-limit parser behind {@link resolveComputerSessionLimits}, for
 * the other live-view limits (control) so every one of them clamps the same
 * way: unset or nonsense is the default, out of range is clamped.
 */
export { clampInt as clampComputerLimit };

export type ComputerSessionExpiry = 'abandoned' | 'stalled' | 'session-ceiling' | null;

/**
 * Should an unfinished session be ended now, and with which close reason?
 * Checked inline on every open and read (and by the reaper as the floor),
 * so a view nobody claimed can never hold a slot against the caps.
 */
export function resolveSessionExpiry(
    session: {
        status: string;
        createdAt?: Date | null;
        startedAt?: Date | null;
        lastFrameAt?: Date | null;
    },
    now: Date,
    limits: Pick<ComputerSessionLimits, 'claimTimeoutMs' | 'maxDurationMs'>,
): ComputerSessionExpiry {
    const at = (value?: Date | null) => (value ? new Date(value).getTime() : NaN);
    if (session.status === 'requested') {
        const created = at(session.createdAt);
        return Number.isFinite(created) && now.getTime() - created >= limits.claimTimeoutMs
            ? 'abandoned'
            : null;
    }
    if (session.status !== 'live' && session.status !== 'stalled') return null;
    const started = at(session.startedAt ?? session.createdAt);
    if (Number.isFinite(started) && now.getTime() - started >= limits.maxDurationMs) {
        return 'session-ceiling';
    }
    const lastFrame = at(session.lastFrameAt ?? session.startedAt);
    if (Number.isFinite(lastFrame) && now.getTime() - lastFrame >= COMPUTER_DEAD_AFTER_MS) {
        return 'stalled';
    }
    return null;
}
