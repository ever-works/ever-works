import {
    FLEET_SESSION_HOOK_BAD_TOKEN_ALERT,
    fleetSessionBoardColumn,
    fleetSessionStatusSource,
    isFleetSessionAttentionUnread,
    isFleetSessionDecisionReason,
    type FleetSessionAttention,
    type FleetSessionAttentionReason,
    type FleetSessionBoardColumn,
    type FleetSessionStatusSource,
    type FleetSessionView,
} from '@ever-works/contracts';

/**
 * Session status, attention & board (FL-05, CONTRACTS §4.8, §5, spec FR-20 …
 * FR-23, FR-53) — the pure rules every status surface reads (the completed
 * `SessionCard`, the detail header's status-source note, the board and the
 * list), kept here so they are tested once and agree everywhere: the glyph
 * vocabulary, the tint, the state words, the card's body lines, the elapsed
 * rule, the status source, unread.
 *
 * No React, no network, no `next-intl` — message KEYS (under
 * `fleet.sessions.*`) and their params only.
 */

// ─── Glyph and tint (FR-21, FR-22) ─────────────────────────────────────────

/**
 * The glyph vocabulary (FR-22): working — spinner ring; needs you
 * (permission/question) — question bubble; blocked/failed — red dot; done —
 * green check; interrupted / cancelled — muted dot; no result — dashed ring;
 * idle — grey dot; a shell — none (its state is still named in words, FR-53).
 */
export type SessionGlyph =
    | 'spinner'
    | 'question'
    | 'redDot'
    | 'check'
    | 'mutedDot'
    | 'dashedRing'
    | 'greyDot'
    | 'none';

type StatusFields = Pick<FleetSessionView, 'state' | 'outcome' | 'provider'> & {
    attention?: FleetSessionAttention | null;
};

/** The open "needs you" reason, when the session waits on someone. */
export function needsYouReason(session: StatusFields): FleetSessionAttentionReason | null {
    if (session.state !== 'needs_you') return null;
    const reason = session.attention?.reason;
    return reason && reason !== 'finished' ? reason : 'question';
}

export function sessionGlyph(session: StatusFields): SessionGlyph {
    if (session.provider === 'shell' && session.state !== 'ended') return 'none';
    switch (session.state) {
        case 'starting':
        case 'working':
            return 'spinner';
        case 'needs_you': {
            const reason = needsYouReason(session);
            return reason === 'blocked' || reason === 'failed' ? 'redDot' : 'question';
        }
        case 'done':
            if (session.outcome === 'interrupted' || session.outcome === 'cancelled')
                return 'mutedDot';
            if (session.outcome === 'failure') return 'redDot';
            if (session.outcome === 'unconfirmed') return 'dashedRing';
            return 'check';
        case 'idle':
            return 'greyDot';
        default:
            switch (session.outcome) {
                case 'success':
                    return 'check';
                case 'failure':
                    return 'redDot';
                case 'unconfirmed':
                    return 'dashedRing';
                default:
                    return 'mutedDot';
            }
    }
}

/** Tint (FR-21): warm while it needs you, green for a successful finish, neutral otherwise. */
export type SessionTint = 'warm' | 'green' | 'neutral';

export function sessionTint(session: Pick<FleetSessionView, 'state' | 'outcome'>): SessionTint {
    if (session.state === 'needs_you') return 'warm';
    if (session.state === 'done' && session.outcome === 'success') return 'green';
    return 'neutral';
}

// ─── Words (FR-53: the state is always named in text) ──────────────────────

/**
 * The state's words as message keys under `fleet.sessions.states` — the state,
 * and its qualifier (the "needs you" reason or the outcome) when there is one.
 */
export function sessionStateWords(session: StatusFields): {
    key: 'starting' | 'working' | 'needsYou' | 'done' | 'idle' | 'ended';
    qualifier:
        | 'reasonPermission'
        | 'reasonQuestion'
        | 'reasonBlocked'
        | 'reasonFailed'
        | 'outcomeSuccess'
        | 'outcomeFailure'
        | 'outcomeCancelled'
        | 'outcomeInterrupted'
        | 'outcomeUnconfirmed'
        | null;
} {
    const outcomeKey = () => {
        switch (session.outcome) {
            case 'success':
                return 'outcomeSuccess' as const;
            case 'failure':
                return 'outcomeFailure' as const;
            case 'cancelled':
                return 'outcomeCancelled' as const;
            case 'interrupted':
                return 'outcomeInterrupted' as const;
            case 'unconfirmed':
                return 'outcomeUnconfirmed' as const;
            default:
                return null;
        }
    };
    switch (session.state) {
        case 'starting':
            return { key: 'starting', qualifier: null };
        case 'working':
            return { key: 'working', qualifier: null };
        case 'needs_you': {
            const reason = needsYouReason(session);
            const qualifier =
                reason === 'permission'
                    ? ('reasonPermission' as const)
                    : reason === 'blocked'
                      ? ('reasonBlocked' as const)
                      : reason === 'failed'
                        ? ('reasonFailed' as const)
                        : ('reasonQuestion' as const);
            return { key: 'needsYou', qualifier };
        }
        case 'done':
            return { key: 'done', qualifier: outcomeKey() };
        case 'idle':
            return { key: 'idle', qualifier: null };
        default:
            return { key: 'ended', qualifier: outcomeKey() };
    }
}

// ─── The card's body (FR-20, spec §5.1, §5.2) ──────────────────────────────

/**
 * What the card's body shows, in order of precedence: the attention prompt
 * in the amber box (a question or a permission waiting); the "exited with
 * code" / "restarted before this finished" line of a session that ended
 * badly; else the last user line and the last agent line (either may be
 * absent).
 */
export type SessionCardBody =
    | { kind: 'attention'; attention: FleetSessionAttention }
    | { kind: 'exited'; code: number }
    | { kind: 'unconfirmed' }
    | { kind: 'lines'; userLine: string | null; agentLine: string | null };

export function sessionCardBody(
    session: Pick<FleetSessionView, 'state' | 'outcome' | 'exitCode' | 'endedReason'> & {
        attention?: FleetSessionAttention | null;
        lastEvidence?: FleetSessionView['lastEvidence'];
    },
): SessionCardBody {
    const attention = session.attention ?? null;
    if (session.state === 'needs_you' && attention && attention.reason !== 'finished') {
        return { kind: 'attention', attention };
    }
    if (
        session.outcome === 'failure' &&
        typeof session.exitCode === 'number' &&
        session.exitCode !== 0
    ) {
        return { kind: 'exited', code: session.exitCode };
    }
    if (
        session.outcome === 'unconfirmed' &&
        (session.state === 'ended' || session.state === 'done')
    ) {
        return { kind: 'unconfirmed' };
    }
    const detail = session.lastEvidence?.detail;
    return {
        kind: 'lines',
        userLine: detail?.userLine ?? null,
        agentLine: detail?.agentLine ?? null,
    };
}

/** True when the attention is a Decision (a person answers it on the card or in My Decisions). */
export function isAnswerable(attention: FleetSessionAttention | null | undefined): boolean {
    return !!attention && isFleetSessionDecisionReason(attention.reason);
}

// ─── Elapsed (FR-20: since finish when done, else since it moved) ──────────

/** `42 s` · `12 min` · `3 h` · `2 d` — a short span. */
export function shortSpan(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

/**
 * The footer's elapsed slot as a key under `fleet.sessions.card` and its
 * span: `waiting 3 min` (needs you), `done 12 min ago`, `working 4 min`,
 * `idle 2 h`, `ended 1 h ago`. Measured from when the state last moved.
 */
export function sessionElapsedSlot(
    session: Pick<FleetSessionView, 'state' | 'createdAt' | 'endedAt' | 'updatedAt'> & {
        stateChangedAt?: string | null;
        attention?: FleetSessionAttention | null;
    },
    now: Date,
): {
    key: 'waiting' | 'doneAgo' | 'workingFor' | 'idleFor' | 'endedAgo' | 'startingFor';
    span: string;
} | null {
    const since =
        session.state === 'ended'
            ? (session.endedAt ?? session.updatedAt)
            : session.state === 'needs_you'
              ? (session.attention?.raisedAt ?? session.stateChangedAt ?? session.updatedAt)
              : (session.stateChangedAt ?? session.updatedAt ?? session.createdAt);
    const at = Date.parse(since ?? '');
    if (!Number.isFinite(at)) return null;
    const span = shortSpan(now.getTime() - at);
    switch (session.state) {
        case 'needs_you':
            return { key: 'waiting', span };
        case 'done':
            return { key: 'doneAgo', span };
        case 'working':
            return { key: 'workingFor', span };
        case 'idle':
            return { key: 'idleFor', span };
        case 'starting':
            return { key: 'startingFor', span };
        default:
            return { key: 'endedAgo', span };
    }
}

// ─── Status source (FR-11, FR-23, spec §5.10) ──────────────────────────────

/**
 * The status-source note as a key under `fleet.sessions.statusSource`, or null
 * when the status comes from the CLI's own hooks (nothing to say on a card).
 * The detail header always says something (`detail: true`).
 */
export function statusSourceNote(
    session: Pick<FleetSessionView, 'provider'> & {
        hooks?: FleetSessionView['hooks'];
        lastEvidence?: FleetSessionView['lastEvidence'];
    },
    options: { detail?: boolean } = {},
): 'hooks' | 'partial' | 'codex' | 'screen' | 'shell' | 'fromScreen' | null {
    const source: FleetSessionStatusSource = fleetSessionStatusSource(
        session.provider,
        session.hooks ?? null,
    );
    if (source === 'shell') return options.detail ? 'shell' : null;
    if (!options.detail) {
        if (session.lastEvidence?.source === 'rules') return 'fromScreen';
        return source === 'hooks' ? null : 'fromScreen';
    }
    if (session.provider === 'codex') return 'codex';
    if (source === 'hooks') return 'hooks';
    if (source === 'partial') return 'partial';
    return 'screen';
}

/** True when a Codex owner session's own notify command does not run in it (U11). */
export function notifyReplaced(session: { hooks?: FleetSessionView['hooks'] }): boolean {
    return session.hooks?.notifyReplaced === true;
}

// ─── Unread (FR-21, §5.2) ──────────────────────────────────────────────────

/** A bold title, never a badge: raised and not acknowledged since. */
export function isSessionUnread(session: { attention?: FleetSessionAttention | null }): boolean {
    return isFleetSessionAttentionUnread(session.attention ?? null);
}

// ─── The board (FR-41, FR-42) ──────────────────────────────────────────────

export function boardColumnOf(
    session: Pick<FleetSessionView, 'state' | 'updatedAt'> & { stateChangedAt?: string | null },
    now: Date,
): FleetSessionBoardColumn | null {
    return fleetSessionBoardColumn(session, now.getTime());
}

// ─── Hook health (FR-6, spec §5.11) ────────────────────────────────────────

/**
 * The computer page's hook-health lines from the heartbeat `daemon.hooks`
 * counters: a bad-token flood (20 in the last minute) and spooled events.
 */
export function hookHealthLines(
    daemon: unknown,
): Array<{ key: 'badToken'; count: number } | { key: 'spooled'; count: number }> {
    if (typeof daemon !== 'object' || daemon === null) return [];
    const hooks = (daemon as { hooks?: unknown }).hooks;
    if (typeof hooks !== 'object' || hooks === null) return [];
    const record = hooks as Record<string, unknown>;
    const lines: Array<{ key: 'badToken'; count: number } | { key: 'spooled'; count: number }> = [];
    const bad = typeof record.badTokenLastMinute === 'number' ? record.badTokenLastMinute : 0;
    if (bad >= FLEET_SESSION_HOOK_BAD_TOKEN_ALERT) lines.push({ key: 'badToken', count: bad });
    const spooled = typeof record.spooled === 'number' ? record.spooled : 0;
    if (spooled > 0) lines.push({ key: 'spooled', count: spooled });
    return lines;
}
