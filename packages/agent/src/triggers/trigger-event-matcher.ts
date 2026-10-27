import type {
    InboundTriggerEventAudience,
    InboundTriggerEventMatcher,
} from '../entities/inbound-trigger.entity';

/**
 * Event-trigger matching — pure functions, no I/O.
 *
 * A matcher is a whitelisted-key object ({@link EVENT_MATCHER_KEYS});
 * anything else on the stored JSON is ignored, never consulted. `source`
 * and `kind` accept a lone `*` (match anything) or a trailing-`*`
 * prefix pattern (`github.*`); `workId` is always an exact match.
 *
 * An OMITTED key matches anything; a matcher with NO recognized keys
 * matches NOTHING — an event trigger must say what it listens for, and
 * a defensively-empty matcher must not subscribe a user to their entire
 * event firehose.
 */

export const EVENT_MATCHER_KEYS = ['source', 'kind', 'workId'] as const;

export type EventMatcherKey = (typeof EVENT_MATCHER_KEYS)[number];

/** The event fields a matcher is evaluated against. */
export interface MatchableEvent {
    source: string;
    kind: string;
    workId?: string | null;
    /** FL-15 P3: the audience filter reads the event's actor and payload logins. */
    actorName?: string | null;
    payload?: Record<string, unknown> | null;
}

/** What only the platform knows about the Trigger's owner (FL-15 P3): their linked GitHub login. */
export interface MatchContext {
    githubLogin?: string | null;
}

/** The "about me" kinds (spec FR-18), in the order the UI lists them. */
export const EVENT_AUDIENCE_KINDS = ['review-requested', 'assigned', 'authored'] as const;

export type EventAudienceKind = (typeof EVENT_AUDIENCE_KINDS)[number];

/** A stored audience, cleaned: known kinds only, deduped; null when none survive. */
export function normalizeEventAudience(raw: unknown): InboundTriggerEventAudience | null {
    if (!raw || typeof raw !== 'object') return null;
    const me = (raw as { me?: unknown }).me;
    if (!Array.isArray(me)) return null;
    const kinds: EventAudienceKind[] = [];
    for (const value of me) {
        if (
            (EVENT_AUDIENCE_KINDS as readonly string[]).includes(value as string) &&
            !kinds.includes(value)
        ) {
            kinds.push(value as EventAudienceKind);
        }
    }
    return kinds.length > 0 ? { me: kinds } : null;
}

function sameLogin(left: unknown, right: string): boolean {
    return (
        typeof left === 'string' && left.trim().length > 0 && left.trim().toLowerCase() === right
    );
}

/**
 * Does this event concern the owner (spec FR-18)? Any listed kind matching
 * is enough (OR). GitHub logins compare case-insensitively; with no linked
 * login nothing matches (fail closed). Reads only what the intake wrote:
 *
 *  - `review-requested` — a `review_requested` action naming the owner as
 *    `requestedReviewer`;
 *  - `assigned` — an `assigned` action naming the owner as `assignee` (pull
 *    requests and issues);
 *  - `authored` — a pull request the owner opened (`opened`,
 *    `ready_for_review`, `reopened`), by `author`, else the event's actor.
 */
export function matchesAudience(
    audience: InboundTriggerEventAudience,
    event: MatchableEvent,
    context: MatchContext = {},
): boolean {
    const login =
        typeof context.githubLogin === 'string' ? context.githubLogin.trim().toLowerCase() : '';
    if (!login) return false;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const action = typeof payload.action === 'string' ? payload.action : '';
    for (const kind of audience.me) {
        if (
            kind === 'review-requested' &&
            action === 'review_requested' &&
            sameLogin(payload.requestedReviewer, login)
        ) {
            return true;
        }
        if (kind === 'assigned' && action === 'assigned' && sameLogin(payload.assignee, login)) {
            return true;
        }
        if (
            kind === 'authored' &&
            event.kind === 'github.pr' &&
            (action === 'opened' || action === 'ready_for_review' || action === 'reopened') &&
            sameLogin(typeof payload.author === 'string' ? payload.author : event.actorName, login)
        ) {
            return true;
        }
    }
    return false;
}

/** Lone `*` matches anything; trailing `*` is a prefix pattern; else exact. */
export function matchesPattern(pattern: string, value: string | null | undefined): boolean {
    if (pattern === '*') return true;
    if (value === null || value === undefined) return false;
    if (pattern.endsWith('*')) {
        return value.startsWith(pattern.slice(0, -1));
    }
    return value === pattern;
}

/** Strip a stored matcher down to its recognized, non-empty string keys. */
export function normalizeEventMatcher(
    matcher: InboundTriggerEventMatcher | null | undefined,
): InboundTriggerEventMatcher | null {
    if (!matcher || typeof matcher !== 'object') return null;
    const normalized: InboundTriggerEventMatcher = {};
    for (const key of EVENT_MATCHER_KEYS) {
        const value = (matcher as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            normalized[key] = value.trim();
        }
    }
    // A matcher still needs one of the keys above; the audience only narrows it (FL-15 P3).
    if (Object.keys(normalized).length === 0) return null;
    const audience = normalizeEventAudience((matcher as Record<string, unknown>).audience);
    if (audience) normalized.audience = audience;
    return normalized;
}

/** True when every present matcher key accepts the event (AND semantics). */
export function matchesEvent(
    matcher: InboundTriggerEventMatcher | null | undefined,
    event: MatchableEvent,
    context: MatchContext = {},
): boolean {
    const normalized = normalizeEventMatcher(matcher);
    if (!normalized) return false;
    if (normalized.source !== undefined && !matchesPattern(normalized.source, event.source)) {
        return false;
    }
    if (normalized.kind !== undefined && !matchesPattern(normalized.kind, event.kind)) {
        return false;
    }
    if (normalized.workId !== undefined && (event.workId ?? null) !== normalized.workId) {
        return false;
    }
    if (normalized.audience && !matchesAudience(normalized.audience, event, context)) {
        return false;
    }
    return true;
}
