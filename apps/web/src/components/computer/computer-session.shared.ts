import {
    COMPUTER_BLOCKED_SHORTCUTS,
    COMPUTER_CONTROL_IDLE_WARNING_MS,
    COMPUTER_KEY_MODIFIER_ALT,
    COMPUTER_KEY_MODIFIER_CTRL,
    COMPUTER_KEY_MODIFIER_META,
    COMPUTER_KEY_MODIFIER_SHIFT,
    COMPUTER_MAX_DIMENSION,
    COMPUTER_QUALITIES,
    computerStallStateForAge,
    isComputerChannel,
    isComputerControlRefusal,
    isComputerQuality,
    isComputerShortcutBlocked,
    isComputerUnwatchableReason,
    type ComputerChannel,
    type ComputerCloseReason,
    type ComputerControlRefusal,
    type ComputerControlStateView,
    type ComputerKeyFrame,
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

/**
 * How long the stall ladder has been waiting on a live view, or null when no
 * ladder applies. Only a screen promises a steady stream of pictures: a
 * healthy shell sits silent at its prompt for as long as nobody types, and a
 * refresh cannot make it print, so a quiet terminal is never "stalled" or
 * "stopped". A terminal that really drops is caught by its socket closing.
 */
export function computerStallAgeMs(input: {
    channel: ComputerChannel | null;
    live: boolean;
    lastFrameAt: number | null;
    now: number;
}): number | null {
    if (input.channel !== 'screen' || !input.live || input.lastFrameAt === null) return null;
    return input.now - input.lastFrameAt;
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

// ── Taking control ───────────────────────────────────────────────────────

/** Two Escape presses closer together than this give control back. */
export const COMPUTER_ESCAPE_TWICE_WINDOW_MS = 600;

/** How often the page re-reads control while a view is live. */
export const COMPUTER_CONTROL_POLL_MS = 3000;

/** Whether the Take over button is offered, and if not, why. */
export type ComputerTakeOverAvailability =
    | 'available'
    /** This view already holds control (the button reads Give back control). */
    | 'controlling'
    /** The machine's control policy leaves this person out. */
    | 'denied'
    /** Another view holds control. */
    | 'held-elsewhere'
    /** Control drives the screen; the terminal channel stays read-only. */
    | 'terminal'
    /** Nothing to drive yet (no picture), or control is not available here. */
    | 'unavailable';

export function takeOverAvailability(input: {
    state: ComputerControlStateView | null;
    channel: ComputerChannel | null;
    live: boolean;
}): ComputerTakeOverAvailability {
    const { state } = input;
    if (state?.mode === 'controlling') return 'controlling';
    if (!state || !input.live) return 'unavailable';
    if (!state.canControl) return 'denied';
    if (input.channel !== 'screen') return 'terminal';
    if (state.holder && !state.holder.thisView) return 'held-elsewhere';
    return 'available';
}

/** `m:ss` for a countdown; never negative. */
export function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Milliseconds until an ISO instant on the platform's clock, read through the view's clock offset. */
export function msUntil(
    iso: string | null | undefined,
    nowMs: number,
    serverOffsetMs: number,
): number | null {
    if (!iso) return null;
    const at = new Date(iso).getTime();
    return Number.isFinite(at) ? at - (nowMs + serverOffsetMs) : null;
}

/** The platform clock minus this browser's, from a control state read at `receivedAtMs`. */
export function serverClockOffsetMs(
    state: Pick<ComputerControlStateView, 'serverTime'> | null,
    receivedAtMs: number,
): number {
    const server = state ? new Date(state.serverTime).getTime() : NaN;
    return Number.isFinite(server) ? server - receivedAtMs : 0;
}

/** While controlling: ms left before the idle give-back, when inside the warning window; else null. */
export function idleWarningMs(
    state: ComputerControlStateView | null,
    nowMs: number,
    serverOffsetMs: number,
): number | null {
    if (state?.mode !== 'controlling' || !state.holder) return null;
    const left = msUntil(state.holder.idleAt, nowMs, serverOffsetMs);
    return left !== null && left <= COMPUTER_CONTROL_IDLE_WARNING_MS ? Math.max(0, left) : null;
}

/** True when the view lost control on its own (idle, ceiling, a lost connection or the view ending). */
export function wasReleasedAutomatically(state: ComputerControlStateView | null): boolean {
    const reason = state?.lastRelease?.reason;
    return (
        reason === 'idle' ||
        reason === 'ceiling' ||
        reason === 'disconnected' ||
        reason === 'revoked' ||
        reason === 'session-ended'
    );
}

/** A refusal from a control route: its named reason and the control state it carried. */
export interface ComputerControlRefusalView {
    reason: ComputerControlRefusal | 'unavailable' | 'failed';
    state: ComputerControlStateView | null;
}

export function describeControlRefusal(status: number, body: unknown): ComputerControlRefusalView {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const state =
        record.state && typeof record.state === 'object'
            ? (record.state as ComputerControlStateView)
            : null;
    if (isComputerControlRefusal(record.reason)) return { reason: record.reason, state };
    if (status === 503) return { reason: 'unavailable', state };
    return { reason: 'failed', state };
}

/**
 * Where a pointer on the stage lands in the picture, in picture pixels. The
 * canvas is scaled to fit and centred (letterboxed), so the picture occupies
 * a centred box inside the element; a point in the margins is outside it
 * and maps to null.
 */
export function pointerToPicture(
    point: { clientX: number; clientY: number },
    box: { left: number; top: number; width: number; height: number },
    picture: { width: number; height: number },
): { x: number; y: number } | null {
    if (box.width <= 0 || box.height <= 0 || picture.width <= 0 || picture.height <= 0) return null;
    const scale = Math.min(box.width / picture.width, box.height / picture.height);
    const shownWidth = picture.width * scale;
    const shownHeight = picture.height * scale;
    const offsetX = box.left + (box.width - shownWidth) / 2;
    const offsetY = box.top + (box.height - shownHeight) / 2;
    const x = (point.clientX - offsetX) / scale;
    const y = (point.clientY - offsetY) / scale;
    if (x < 0 || y < 0 || x >= picture.width || y >= picture.height) return null;
    return {
        x: Math.min(COMPUTER_MAX_DIMENSION, Math.floor(x)),
        y: Math.min(COMPUTER_MAX_DIMENSION, Math.floor(y)),
    };
}

/** The `key` frame for a keyboard event, or null for one this page never forwards. */
export function keyEventToFrame(
    event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
    action: 'down' | 'up',
): ComputerKeyFrame | null {
    const key = typeof event.key === 'string' ? event.key : '';
    const code = typeof event.code === 'string' && event.code.length > 0 ? event.code : key;
    if (
        !key ||
        key.length > 32 ||
        code.length > 32 ||
        key === 'Unidentified' ||
        key === 'Process'
    ) {
        return null;
    }
    const modifiers =
        (event.altKey ? COMPUTER_KEY_MODIFIER_ALT : 0) |
        (event.ctrlKey ? COMPUTER_KEY_MODIFIER_CTRL : 0) |
        (event.metaKey ? COMPUTER_KEY_MODIFIER_META : 0) |
        (event.shiftKey ? COMPUTER_KEY_MODIFIER_SHIFT : 0);
    const frame: ComputerKeyFrame = { kind: 'key', action, key, code, modifiers };
    return isComputerShortcutBlocked(frame) ? null : frame;
}

/** The shortcuts a controlling browser never sends, as the sheet lists them (each once). */
export function blockedShortcutLabels(): string[] {
    return [...new Set(COMPUTER_BLOCKED_SHORTCUTS.map((shortcut) => shortcut.label))];
}

/** True for a body that is a control state (anything else — an error, an empty answer — is not adopted). */
export function isControlStateView(value: unknown): value is ComputerControlStateView {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.sessionId === 'string' &&
        typeof record.serverTime === 'string' &&
        typeof record.canControl === 'boolean' &&
        (record.mode === 'watching' || record.mode === 'controlling')
    );
}

export type ComputerControlRefusalKey =
    | 'policy'
    | 'held'
    | 'notLive'
    | 'sessionEnded'
    | 'notHolder'
    | 'notHeld'
    | 'alreadyRequested'
    | 'noRequest'
    | 'alreadyExtended'
    | 'unavailable'
    | 'failed';

/** The `dashboard.computer.control.refusals` leaf for a refusal reason. */
export function controlRefusalKey(
    reason: ComputerControlRefusalView['reason'],
): ComputerControlRefusalKey {
    switch (reason) {
        case 'policy':
        case 'held':
        case 'unavailable':
        case 'failed':
            return reason;
        case 'not-live':
            return 'notLive';
        case 'session-ended':
            return 'sessionEnded';
        case 'not-holder':
            return 'notHolder';
        case 'not-held':
            return 'notHeld';
        case 'already-requested':
            return 'alreadyRequested';
        case 'no-request':
            return 'noRequest';
        case 'already-extended':
            return 'alreadyExtended';
    }
}

/** `09:12` in the viewer's locale, for "since …" sentences; empty for an unknown instant. */
export function formatClockTime(iso: string | null | undefined): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return date.toISOString().slice(11, 16);
    }
}
