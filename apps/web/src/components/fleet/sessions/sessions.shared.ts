import {
    FLEET_SESSIONS_CAPABILITY,
    FLEET_SESSION_MAX_OWNER_PER_NODE,
    FLEET_SESSION_PROVIDER_CAPABILITY,
    isFleetLinkErrorCode,
    isFleetSessionLive,
    normalizeFleetSessionDaemonReport,
    type FleetLinkErrorCode,
    type FleetNodeView,
    type FleetSessionAttachRole,
    type FleetSessionKind,
    type FleetSessionPresence,
    type FleetSessionProvider,
    type FleetSessionStartableProvider,
    type FleetSessionState,
    type FleetSessionView,
} from '@ever-works/contracts';
import { readNodeConsents } from '../fleet-consents.shared';
import type { FleetStateTone } from '../fleet-hub.shared';

/**
 * Sessions on computers (FL-04 P1b) — the pure rules every session surface
 * reads (the Sessions tab, the start dialog, the detail page, `SessionCard`),
 * kept here so they are tested once and agree everywhere: the consent copy
 * per kind, which state card a computer shows, provider gating, the state
 * glyph, elapsed time, the ended line, the role sentence, the held-input
 * policy and the error envelope.
 *
 * No React, no network, no `next-intl` — message KEYS and their params only.
 */

// ─── Consents and the tab's state card ─────────────────────────────────────

/** The machine consent a session of this kind needs (CONTRACTS R-5). */
export function sessionConsentFor(kind: FleetSessionKind): 'manage' | 'work' {
    return kind === 'agent' ? 'work' : 'manage';
}

/** The exact command that grants it, shown copyable. */
export function sessionConsentCommand(kind: FleetSessionKind): string {
    return kind === 'agent' ? 'ever-works-node start --work' : 'ever-works-node start --manage';
}

/**
 * What the Sessions tab leads with for this computer (spec §5.1, U1 … U4), in
 * order: offline (with its last-seen time; the sessions it had are still
 * listed), the owner consent missing (the command), the session daemon down
 * (its own diagnosis), else nothing — the list.
 */
export type SessionsTabCard =
    | { kind: 'offline'; lastSeen: string | null }
    | { kind: 'consent-missing'; command: string }
    | { kind: 'daemon-down'; reason: string | null }
    | { kind: 'none' };

export function sessionsTabCard(
    node: Pick<FleetNodeView, 'status' | 'capabilities' | 'workerState' | 'lastHeartbeatAt'> & {
        consents?: unknown;
        sessionDaemon?: unknown;
    },
): SessionsTabCard {
    if (node.status === 'offline')
        return { kind: 'offline', lastSeen: node.lastHeartbeatAt ?? null };
    const consents = readNodeConsents(node);
    if (!consents.manage && !consents.work) {
        return { kind: 'consent-missing', command: sessionConsentCommand('owner') };
    }
    const daemon = normalizeFleetSessionDaemonReport(node.sessionDaemon);
    const tagged = (node.capabilities ?? []).includes(FLEET_SESSIONS_CAPABILITY);
    if (daemon && daemon.state !== 'running')
        return { kind: 'daemon-down', reason: daemon.reason ?? null };
    if (!daemon && !tagged) return { kind: 'daemon-down', reason: null };
    return { kind: 'none' };
}

/** May an owner session be started on this computer at all (the dialog's "You" row)? */
export function canStartOwnerSession(
    node: Pick<FleetNodeView, 'status' | 'capabilities' | 'workerState'> & { consents?: unknown },
): boolean {
    return (
        node.status !== 'offline' &&
        readNodeConsents(node).manage &&
        (node.capabilities ?? []).includes(FLEET_SESSIONS_CAPABILITY)
    );
}

/** May an Agent session be started on this computer (P2: `--work` and the `sessions` tag)? */
export function canStartAgentSession(
    node: Pick<FleetNodeView, 'status' | 'capabilities' | 'workerState'> & { consents?: unknown },
): boolean {
    return (
        node.status !== 'offline' &&
        readNodeConsents(node).work &&
        (node.capabilities ?? []).includes(FLEET_SESSIONS_CAPABILITY)
    );
}

// ─── Providers ─────────────────────────────────────────────────────────────

/** The providers the start dialog offers, in order. */
export const SESSION_DIALOG_PROVIDERS: readonly FleetSessionStartableProvider[] = [
    'claude-code',
    'codex',
    'shell',
];

/** The message key (under `fleet.sessions.providers`) of a provider's name. */
export function providerKey(
    provider: FleetSessionProvider,
): 'shell' | 'claudeCode' | 'codex' | 'other' {
    if (provider === 'claude-code') return 'claudeCode';
    if (provider === 'codex') return 'codex';
    if (provider === 'shell') return 'shell';
    return 'other';
}

/** Whether the computer advertises the CLI a provider needs (a shell needs nothing more). */
export function providerInstalled(
    node: Pick<FleetNodeView, 'capabilities'>,
    provider: FleetSessionStartableProvider,
): boolean {
    const tag = FLEET_SESSION_PROVIDER_CAPABILITY[provider];
    return tag === null || (node.capabilities ?? []).includes(tag);
}

/** The provider the dialog preselects: the first installed agent CLI, else the shell. */
export function defaultProvider(
    node: Pick<FleetNodeView, 'capabilities'>,
): FleetSessionStartableProvider {
    return (
        SESSION_DIALOG_PROVIDERS.find((provider) => providerInstalled(node, provider)) ?? 'shell'
    );
}

// ─── States, time ──────────────────────────────────────────────────────────

/** The state's message key (under `fleet.sessions.states`) and tone. */
export function sessionStateGlyph(state: FleetSessionState): {
    key: 'starting' | 'working' | 'needsYou' | 'done' | 'idle' | 'ended';
    tone: FleetStateTone;
} {
    switch (state) {
        case 'starting':
            return { key: 'starting', tone: 'info' };
        case 'working':
            return { key: 'working', tone: 'success' };
        case 'needs_you':
            return { key: 'needsYou', tone: 'warning' };
        case 'done':
            return { key: 'done', tone: 'success' };
        case 'idle':
            return { key: 'idle', tone: 'muted' };
        default:
            return { key: 'ended', tone: 'muted' };
    }
}

/** `42 s` · `12 min` · `3 h 05 min` · `2 d 4 h` — how long the session has run (or ran). */
export function sessionElapsed(
    session: Pick<FleetSessionView, 'startedAt' | 'createdAt' | 'endedAt'>,
    now: Date,
): string | null {
    const start = Date.parse(session.startedAt ?? session.createdAt);
    if (!Number.isFinite(start)) return null;
    const end = session.endedAt ? Date.parse(session.endedAt) : now.getTime();
    const seconds = Math.max(
        0,
        Math.floor(((Number.isFinite(end) ? end : now.getTime()) - start) / 1000),
    );
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Live sessions first (most recently active first), then ended ones (most recently ended first). */
export function groupSessions(sessions: readonly FleetSessionView[]): {
    live: FleetSessionView[];
    ended: FleetSessionView[];
} {
    const live: FleetSessionView[] = [];
    const ended: FleetSessionView[] = [];
    for (const session of sessions)
        (isFleetSessionLive(session.state) ? live : ended).push(session);
    const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
    live.sort((a, b) => at(b.lastActivityAt ?? b.createdAt) - at(a.lastActivityAt ?? a.createdAt));
    ended.sort((a, b) => at(b.endedAt ?? b.updatedAt) - at(a.endedAt ?? a.updatedAt));
    return { live, ended };
}

/** Whether a computer is at its owner-session limit (the dialog's limit card, U6). */
export function atOwnerLimit(sessions: readonly FleetSessionView[]): boolean {
    return (
        sessions.filter((session) => session.kind === 'owner' && isFleetSessionLive(session.state))
            .length >= FLEET_SESSION_MAX_OWNER_PER_NODE
    );
}

/**
 * The ended line under the screen (spec §5.4), as a key under
 * `fleet.sessions.detail` and its params (the page adds `time` and `node`).
 */
export function endedLine(
    session: Pick<FleetSessionView, 'state' | 'endedReason' | 'exitCode'>,
):
    | { key: 'endedExit'; code: number }
    | { key: 'endedLost' }
    | { key: 'endedUser' }
    | { key: 'endedAgent' }
    | { key: 'endedNodeRestart' }
    | { key: 'endedDrain' }
    | { key: 'endedKillSwitch' }
    | { key: 'endedTimeout' }
    | null {
    if (session.state !== 'ended') return null;
    switch (session.endedReason) {
        case 'exit':
            return typeof session.exitCode === 'number'
                ? { key: 'endedExit', code: session.exitCode }
                : { key: 'endedLost' };
        case 'user':
            return { key: 'endedUser' };
        case 'agent':
            return { key: 'endedAgent' };
        case 'node-restart':
            return { key: 'endedNodeRestart' };
        case 'drain':
            return { key: 'endedDrain' };
        case 'kill-switch':
            return { key: 'endedKillSwitch' };
        case 'timeout':
            return { key: 'endedTimeout' };
        default:
            return typeof session.exitCode === 'number'
                ? { key: 'endedExit', code: session.exitCode }
                : { key: 'endedLost' };
    }
}

// ─── Who is attached ───────────────────────────────────────────────────────

/**
 * The footer's role sentence (spec §5.4): "You are driving", "Watching ·
 * someone is driving", "Nobody is driving", from the presence and this
 * browser's own role. `others` counts the people other than this browser.
 */
export function roleSentence(
    presence: FleetSessionPresence | undefined,
    me: { userId: string; role: FleetSessionAttachRole | null },
): { key: 'driving' } | { key: 'watchingDriven'; others: number } | { key: 'nobodyDriving' } {
    if (me.role === 'driver') return { key: 'driving' };
    const otherDrivers = (presence?.attached ?? []).filter(
        (entry) => entry.role === 'driver' && entry.userId !== me.userId,
    ).length;
    return otherDrivers > 0
        ? { key: 'watchingDriven', others: otherDrivers }
        : { key: 'nobodyDriving' };
}

// ─── Held input ────────────────────────────────────────────────────────────

/** A driver whose stream drops keeps what it types, up to this much, and is OFFERED it — never auto-sent. */
export const SESSION_HELD_INPUT_MAX_BYTES = 16 * 1024;

/** After this long without a frame on a dropped stream the page says "Reconnecting to …". */
export const SESSION_RECONNECTING_AFTER_MS = 3_000;

/** Reconnect backoff: 1 s, 2 s, 4 s … capped at 15 s. */
export function sessionReconnectDelayMs(attempt: number): number {
    return Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.min(4, attempt)));
}

/** Append typed input to the held buffer, dropping what does not fit (the oldest is kept). */
export function holdInput(held: string, data: string): string {
    const next = held + data;
    return next.length > SESSION_HELD_INPUT_MAX_BYTES
        ? next.slice(0, SESSION_HELD_INPUT_MAX_BYTES)
        : next;
}

/** How many lines the held input is ("You typed {count} lines while offline"), at least 1 when anything was typed. */
export function heldLineCount(held: string): number {
    if (held.length === 0) return 0;
    const breaks = (held.match(/\r\n|\r|\n/g) ?? []).length;
    const trailing = /[\r\n]$/.test(held) ? 0 : 1;
    return Math.max(1, breaks + trailing);
}

// ─── Errors ────────────────────────────────────────────────────────────────

export interface SessionErrorRead {
    code: FleetLinkErrorCode | 'network';
    hint: string | null;
    details: Record<string, unknown>;
    status: number;
}

/**
 * Read the CONTRACTS §8 envelope (`{ error: { code, hint, details } }`) off a
 * failed BFF response body, or a generic reading when the body is not one.
 */
export function readSessionError(status: number, body: unknown): SessionErrorRead {
    const error =
        typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        if (isFleetLinkErrorCode(record.code)) {
            return {
                code: record.code,
                hint: typeof record.hint === 'string' ? record.hint : null,
                details:
                    typeof record.details === 'object' && record.details !== null
                        ? (record.details as Record<string, unknown>)
                        : {},
                status,
            };
        }
    }
    const code: FleetLinkErrorCode =
        status === 404
            ? 'not_found'
            : status === 403
              ? 'permission_denied'
              : status === 429
                ? 'limit_exceeded'
                : status === 400
                  ? 'invalid'
                  : 'internal';
    return { code, hint: null, details: {}, status };
}

/** The field a refusal names (`invalid` with `details.field`), so the dialog marks it and keeps the rest. */
export function errorField(error: SessionErrorRead | null): string | null {
    if (!error || error.code !== 'invalid') return null;
    return typeof error.details.field === 'string' ? error.details.field : null;
}

/** The session's link on this deployment, for "Copy link". */
export function sessionHref(origin: string, localePath: string): string {
    return `${origin.replace(/\/+$/, '')}${localePath.startsWith('/') ? localePath : `/${localePath}`}`;
}
