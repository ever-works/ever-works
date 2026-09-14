import type { FleetAuditAction } from '@ever-works/contracts';

/**
 * Agent computers — what each of the eight computer audit actions may say.
 *
 * Every computer act is written through the fleet's ONE audit writer
 * (`FleetAuditService`), which already drops credential-named keys and
 * scans surviving strings. This module adds the rule that writer cannot
 * know: a live view handles pictures, typed text and page selectors, and
 * none of those may ever reach an audit row — not even redacted. So each
 * action carries a fixed list of the facts it records, and anything else a
 * caller passes is dropped before the row is built.
 *
 * Field names say what they mean (`profileRef`, never `profileKeyHash`):
 * the writer redacts by KEY, so a key that merely contains `hash`, `token`
 * or `credential` would silently lose its value.
 */
export type ComputerAuditAction = Extract<FleetAuditAction, `computer.${string}`>;

export const COMPUTER_AUDIT_DETAIL_KEYS: Readonly<Record<ComputerAuditAction, readonly string[]>> =
    Object.freeze({
        'computer.session-open': ['sessionId', 'agentId', 'channels', 'quality', 'runId'],
        'computer.session-close': [
            'sessionId',
            'agentId',
            'closeReason',
            'durationMs',
            'frameCount',
            'recorded',
        ],
        'computer.control-grant': ['sessionId', 'agentId'],
        'computer.control-release': ['sessionId', 'releaseReason', 'heldMs'],
        'computer.control-refused': ['sessionId', 'policy', 'holderPresent'],
        'computer.teach-start': ['demonstrationId', 'intent'],
        'computer.teach-finish': [
            'demonstrationId',
            'stepCount',
            'redactedStepCount',
            'stopReason',
        ],
        'computer.profile-reset': ['agentId', 'profileRef', 'signedInSiteCountBefore'],
    });

/** Longest string any computer audit field may carry (a teach intent is capped at 120). */
export const COMPUTER_AUDIT_MAX_STRING_LENGTH = 120;

/** Most entries a list-valued field (e.g. `channels`) may carry. */
const COMPUTER_AUDIT_MAX_LIST_LENGTH = 8;

/**
 * Keep only the facts `action` records, and only in shapes that cannot
 * smuggle a payload: short strings, finite numbers, booleans, null, and
 * short lists of short strings. Everything else is dropped, not coerced.
 */
export function computerAuditDetails(
    action: ComputerAuditAction,
    details: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of COMPUTER_AUDIT_DETAIL_KEYS[action] ?? []) {
        if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
        const value = details[key];
        if (
            value === null ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
        ) {
            out[key] = value;
        } else if (typeof value === 'string') {
            if (value.length <= COMPUTER_AUDIT_MAX_STRING_LENGTH) out[key] = value;
        } else if (
            Array.isArray(value) &&
            value.length <= COMPUTER_AUDIT_MAX_LIST_LENGTH &&
            value.every(
                (entry) =>
                    typeof entry === 'string' && entry.length <= COMPUTER_AUDIT_MAX_STRING_LENGTH,
            )
        ) {
            out[key] = [...value];
        }
    }
    return out;
}
