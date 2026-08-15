import type { InboundTriggerEventMatcher } from '../entities/inbound-trigger.entity';

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
    return Object.keys(normalized).length > 0 ? normalized : null;
}

/** True when every present matcher key accepts the event (AND semantics). */
export function matchesEvent(
    matcher: InboundTriggerEventMatcher | null | undefined,
    event: MatchableEvent,
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
    return true;
}
