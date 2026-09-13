import {
    COMPUTER_QUALITIES,
    computerStallStateForAge,
    isComputerChannel,
    isComputerQuality,
    isComputerUnwatchableReason,
    type ComputerChannel,
    type ComputerCloseReason,
    type ComputerNodeOption,
    type ComputerQuality,
    type ComputerSessionHolderView,
    type ComputerStallState,
    type ComputerStatsFrame,
    type ComputerUnwatchableReason,
    type FleetKillSwitchState,
} from '@ever-works/contracts';
import { formatBytes, type RunnerRowState } from '@/components/dashboard/runner-status.shared';
import { ROUTES } from '@/lib/constants';

/**
 * Agent computers — every decision the computer page makes, as pure
 * functions, for the same reason `agent-fleet.shared.ts` exists: which
 * computer opens first, whether it can be watched and why not, which
 * channel and quality are in force, what a refusal from the platform means
 * on screen, when a quiet picture is stalled. Each is a one-line test; the
 * components are layout.
 *
 * Thresholds are never re-declared: the stall ladder comes from
 * `@ever-works/contracts`, the one definition the machine's capture pump
 * and the platform's session rules also read.
 */

export { computerStallStateForAge };
export type { ComputerStallState };

/** localStorage key prefix for the owner's chosen quality, per computer. */
export const COMPUTER_QUALITY_STORAGE_PREFIX = 'ew:computer:quality:';

/** "Waking up the view…" turns into "has not answered yet" at this age. */
export const COMPUTER_CONNECTING_SLOW_AFTER_MS = 20_000;

/** The machine's clock is marked stale when no stats arrived for this long. */
export const COMPUTER_CLOCK_STALE_AFTER_MS = 10_000;

/** The computer to open first: the one in the link, else the Agent's pinned one, else the first watchable. */
export function selectInitialNode(
    nodes: readonly ComputerNodeOption[],
    requestedNodeId: string | null | undefined,
): ComputerNodeOption | null {
    if (nodes.length === 0) return null;
    if (requestedNodeId) {
        const requested = nodes.find((node) => node.id === requestedNodeId);
        if (requested) return requested;
    }
    return (
        nodes.find((node) => node.boundToAgent) ?? nodes.find((node) => node.watchable) ?? nodes[0]
    );
}

/** The channel the link asked for, when the computer can serve it; else screen, then terminal. */
export function resolveChannel(
    node: Pick<ComputerNodeOption, 'servableChannels'>,
    requested: string | null | undefined,
): ComputerChannel | null {
    if (isComputerChannel(requested) && node.servableChannels.includes(requested)) return requested;
    if (node.servableChannels.includes('screen')) return 'screen';
    if (node.servableChannels.includes('terminal')) return 'terminal';
    return null;
}

/** What the page shows before (or instead of) opening a live view. */
export type ComputerPreOpenState =
    | { kind: 'nodes-unavailable' }
    | { kind: 'empty' }
    | { kind: 'stopped'; reason: string | null; since: string | null }
    | { kind: 'offline'; node: ComputerNodeOption }
    | {
          kind: 'unwatchable';
          node: ComputerNodeOption;
          reason: 'paused' | 'disabled' | 'draining' | 'cluster';
      }
    | { kind: 'not-attended'; node: ComputerNodeOption }
    | {
          kind: 'channel-unavailable';
          node: ComputerNodeOption;
          channel: ComputerChannel;
          reason: ComputerUnwatchableReason;
          /** The other channel, when this computer can serve it. */
          alternative: ComputerChannel | null;
      }
    | { kind: 'ready'; node: ComputerNodeOption; channel: ComputerChannel };

export function resolvePreOpenState(input: {
    nodes: readonly ComputerNodeOption[] | null;
    node: ComputerNodeOption | null;
    requestedChannel: string | null | undefined;
    stop: Pick<FleetKillSwitchState, 'stopped' | 'reason' | 'since'> | null;
}): ComputerPreOpenState {
    if (input.nodes === null) return { kind: 'nodes-unavailable' };
    if (input.nodes.length === 0 || !input.node) return { kind: 'empty' };
    if (input.stop?.stopped) {
        return {
            kind: 'stopped',
            reason: input.stop.reason ?? null,
            since: input.stop.since ?? null,
        };
    }
    const node = input.node;
    if (!node.watchable) {
        switch (node.unwatchableReason) {
            case 'offline':
                return { kind: 'offline', node };
            case 'not-attended':
                return { kind: 'not-attended', node };
            case 'paused':
            case 'disabled':
            case 'draining':
            case 'cluster':
                return { kind: 'unwatchable', node, reason: node.unwatchableReason };
            default: {
                const reason = node.unwatchableReason ?? node.channelReasons.screen ?? 'no-browser';
                return {
                    kind: 'channel-unavailable',
                    node,
                    channel: reason === 'no-terminal' ? 'terminal' : 'screen',
                    reason,
                    alternative: null,
                };
            }
        }
    }
    if (
        isComputerChannel(input.requestedChannel) &&
        !node.servableChannels.includes(input.requestedChannel)
    ) {
        const channel = input.requestedChannel;
        return {
            kind: 'channel-unavailable',
            node,
            channel,
            reason:
                node.channelReasons[channel] ??
                (channel === 'terminal' ? 'no-terminal' : 'no-browser'),
            alternative: resolveChannel(node, null),
        };
    }
    const channel = resolveChannel(node, input.requestedChannel);
    if (!channel) {
        return {
            kind: 'channel-unavailable',
            node,
            channel: 'screen',
            reason: node.channelReasons.screen ?? 'no-browser',
            alternative: null,
        };
    }
    return { kind: 'ready', node, channel };
}

export type ComputerNodeReasonKey =
    | 'reasonOffline'
    | 'reasonPaused'
    | 'reasonDisabled'
    | 'reasonDraining'
    | 'reasonNoDisplay'
    | 'reasonNoBrowser'
    | 'reasonNoTerminal'
    | 'reasonNotAttended'
    | 'reasonCluster';

/** The `dashboard.computer.nodePicker` leaf naming a closed-set reason. */
export function nodeReasonKey(reason: ComputerUnwatchableReason): ComputerNodeReasonKey {
    switch (reason) {
        case 'offline':
            return 'reasonOffline';
        case 'paused':
            return 'reasonPaused';
        case 'disabled':
            return 'reasonDisabled';
        case 'draining':
            return 'reasonDraining';
        case 'no-display':
            return 'reasonNoDisplay';
        case 'no-browser':
            return 'reasonNoBrowser';
        case 'no-terminal':
            return 'reasonNoTerminal';
        case 'not-attended':
            return 'reasonNotAttended';
        case 'cluster':
            return 'reasonCluster';
    }
}

/** The picker row's right-hand note: what it can serve, or why it cannot be watched. */
export function nodeRowNote(
    node: Pick<
        ComputerNodeOption,
        'watchable' | 'unwatchableReason' | 'servableChannels' | 'channelReasons'
    >,
): {
    key:
        | ComputerNodeReasonKey
        | 'capabilitiesScreenTerminal'
        | 'capabilitiesScreen'
        | 'capabilitiesTerminal';
    tone: 'ok' | 'muted';
    missingKey: ComputerNodeReasonKey | null;
} {
    if (!node.watchable) {
        return {
            key: nodeReasonKey(node.unwatchableReason ?? 'offline'),
            tone: 'muted',
            missingKey: null,
        };
    }
    const screen = node.servableChannels.includes('screen');
    const terminal = node.servableChannels.includes('terminal');
    if (screen && terminal)
        return { key: 'capabilitiesScreenTerminal', tone: 'ok', missingKey: null };
    // Watchable on one channel: say which, and why the other is unavailable (FR-70).
    const missing = screen ? node.channelReasons.terminal : node.channelReasons.screen;
    return {
        key: screen ? 'capabilitiesScreen' : 'capabilitiesTerminal',
        tone: 'ok',
        missingKey: missing ? nodeReasonKey(missing) : null,
    };
}

/**
 * The status dot, in the runner pill's vocabulary so this surface and the
 * sidebar can never disagree about what a colour means.
 */
export function nodeDotState(node: Pick<ComputerNodeOption, 'status'>): RunnerRowState {
    return node.status;
}

export function qualityStorageKey(nodeId: string): string {
    return `${COMPUTER_QUALITY_STORAGE_PREFIX}${nodeId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The owner's quality for this computer, else `sharp`. Never throws (private mode, blocked storage). */
export function readStoredQuality(
    storage: StorageLike | null | undefined,
    nodeId: string,
): ComputerQuality {
    try {
        const value = storage?.getItem(qualityStorageKey(nodeId));
        return isComputerQuality(value) ? value : 'sharp';
    } catch {
        return 'sharp';
    }
}

export function writeStoredQuality(
    storage: StorageLike | null | undefined,
    nodeId: string,
    quality: ComputerQuality,
): void {
    try {
        storage?.setItem(qualityStorageKey(nodeId), quality);
    } catch {
        // Persistence is a convenience; the view works without it.
    }
}

/** `Q` cycles Sharp → Smooth → Steady → Sharp. */
export function nextQuality(quality: ComputerQuality): ComputerQuality {
    const index = COMPUTER_QUALITIES.indexOf(quality);
    return COMPUTER_QUALITIES[(index + 1) % COMPUTER_QUALITIES.length];
}

/** True when the machine lowered the owner's chosen quality because the link is slow. */
export function isQualityLowered(
    stats: Pick<ComputerStatsFrame, 'quality' | 'effectiveQuality'> | null,
): boolean {
    return stats !== null && stats.quality !== stats.effectiveQuality;
}

/** Bandwidth readout; a dash-free zero before anything was sent. */
export function formatBandwidth(bytes: number | null | undefined): string {
    return formatBytes(bytes ?? 0) ?? '0 B';
}

/** `09:41:07` from the machine's own ISO clock (its offset already applied), or null. */
export function nodeClockDisplay(nodeLocalTime: string | null | undefined): string | null {
    if (typeof nodeLocalTime !== 'string') return null;
    const match = /T(\d{2}:\d{2}:\d{2})/.exec(nodeLocalTime);
    return match ? match[1] : null;
}

export function isNodeClockStale(lastStatsAtMs: number | null, nowMs: number): boolean {
    return lastStatsAtMs === null || nowMs - lastStatsAtMs > COMPUTER_CLOCK_STALE_AFTER_MS;
}

/** "Waking up the view…", then "has not answered yet". */
export function connectingPhase(elapsedMs: number): 'waking' | 'slow' {
    return elapsedMs >= COMPUTER_CONNECTING_SLOW_AFTER_MS ? 'slow' : 'waking';
}

export type ComputerCloseReasonKey =
    | 'closedByUser'
    | 'noViewer'
    | 'sessionCeiling'
    | 'stalled'
    | 'nodeRestarted'
    | 'nodeUnavailable'
    | 'stopped'
    | 'accessRevoked'
    | 'abandoned'
    | 'error';

/** The `dashboard.computer.ended.reasons` leaf for a close reason. */
export function closeReasonKey(
    reason: ComputerCloseReason | null | undefined,
): ComputerCloseReasonKey {
    switch (reason) {
        case 'closed-by-user':
            return 'closedByUser';
        case 'no-viewer':
            return 'noViewer';
        case 'session-ceiling':
            return 'sessionCeiling';
        case 'stalled':
            return 'stalled';
        case 'node-restarted':
            return 'nodeRestarted';
        case 'node-unavailable':
            return 'nodeUnavailable';
        case 'stopped':
            return 'stopped';
        case 'access-revoked':
            return 'accessRevoked';
        case 'abandoned':
            return 'abandoned';
        default:
            return 'error';
    }
}

/** What an open refusal from the platform means on screen. */
export type ComputerOpenRefusal =
    | { kind: 'stopped'; reason: string | null; since: string | null }
    | { kind: 'empty' }
    | { kind: 'unwatchable'; reason: ComputerUnwatchableReason }
    | { kind: 'channel-unavailable'; channel: ComputerChannel; reason: ComputerUnwatchableReason }
    | {
          kind: 'over-limit';
          scope: 'node' | 'organization';
          limit: number;
          sessions: ComputerSessionHolderView[];
      }
    | { kind: 'refused' }
    | { kind: 'unavailable' }
    | { kind: 'cannot-connect' };

export function describeOpenRefusal(status: number, body: unknown): ComputerOpenRefusal {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const reason = record.reason;
    if (status === 409 && reason === 'stopped') {
        const stop =
            record.stop && typeof record.stop === 'object'
                ? (record.stop as Record<string, unknown>)
                : {};
        return {
            kind: 'stopped',
            reason: typeof stop.reason === 'string' ? stop.reason : null,
            since: typeof stop.since === 'string' ? stop.since : null,
        };
    }
    if (status === 409 && reason === 'no-nodes') return { kind: 'empty' };
    if (status === 409 && isComputerUnwatchableReason(reason))
        return { kind: 'unwatchable', reason };
    if (status === 422 && isComputerUnwatchableReason(reason)) {
        return {
            kind: 'channel-unavailable',
            channel: isComputerChannel(record.channel) ? record.channel : 'screen',
            reason,
        };
    }
    if (
        status === 429 &&
        (reason === 'node-session-cap' || reason === 'organization-session-cap')
    ) {
        return {
            kind: 'over-limit',
            scope: reason === 'node-session-cap' ? 'node' : 'organization',
            limit: typeof record.limit === 'number' ? record.limit : 0,
            sessions: Array.isArray(record.sessions)
                ? (record.sessions as ComputerSessionHolderView[])
                : [],
        };
    }
    if (status === 401 || status === 403 || status === 404) return { kind: 'refused' };
    if (status === 503) return { kind: 'unavailable' };
    return { kind: 'cannot-connect' };
}

/** A shareable link to one computer and channel (FR-2). */
export function buildComputerViewHref(
    agentId: string,
    nodeId?: string | null,
    channel?: ComputerChannel | null,
): string {
    const params = new URLSearchParams();
    if (nodeId) params.set('node', nodeId);
    if (channel) params.set('channel', channel);
    const qs = params.toString();
    return `${ROUTES.DASHBOARD_AGENT_COMPUTER(agentId)}${qs ? `?${qs}` : ''}`;
}
