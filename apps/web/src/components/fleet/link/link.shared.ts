import {
    FLEET_CONSENT_FLAGS,
    FLEET_NODE_LINK_STATES,
    effectiveConsents,
    isFleetLinkErrorCode,
    normalizeFleetConsents,
    type FleetConsents,
    type FleetLinkErrorCode,
    type FleetNodeLinkState,
    type FleetNodeLinkView,
    type FleetNodeView,
} from '@ever-works/contracts';
import { formatBytes } from '@/components/dashboard/runner-status.shared';

/**
 * Fleet node link (FL-02, spec §5.1 – §5.3, FR-28, FR-41, FR-42) — the pure
 * part of what the computer page says about a node's link and its consents:
 * the state word, which consents are in force, which are missing and the
 * exact `ever-works-node start` command that turns one on, and the bytes the
 * link carried. No React, no i18n: the components map these to message keys.
 *
 * The link state is the platform's OWN socket state (`node.link`, written by
 * the API from its link registry), never inferred from a heartbeat (FR-42).
 * A view without `link` — a build without the link, a cluster row, or a
 * computer shared with you (the API attaches it for the owner only) — shows
 * no link line at all rather than a guess.
 */

/** The consents the card and the header name (`usageScan` arrives with FL-20's own row). */
export const LINK_CONSENT_KEYS = ['work', 'attend', 'manage'] as const;

export type LinkConsentKey = (typeof LINK_CONSENT_KEYS)[number];

/** The binary every command starts with. */
export const NODE_START_COMMAND = 'ever-works-node start';

/**
 * Message leaf under `fleet.link.states` for one link state. `not-open` has
 * two sentences: a computer with no consent that opens a link "only reports
 * health" (spec S2); one that has a consent but no link yet (an older node,
 * or one still starting) is simply "not open".
 */
export type LinkStateMessageKey =
    | 'connected'
    | 'reconnecting'
    | 'notOpen'
    | 'notOpenNoConsent'
    | 'refused'
    | 'unsupportedKind';

/** The link state the API reported for this computer, or null when it reported none. */
export function linkStateOf(
    node: Pick<FleetNodeView, 'link'> | null | undefined,
): FleetNodeLinkState | null {
    const state = node?.link?.state;
    return typeof state === 'string' &&
        (FLEET_NODE_LINK_STATES as readonly string[]).includes(state)
        ? state
        : null;
}

/** The consents this computer is treated as holding (FL-02's one inference, contracts `effectiveConsents`). */
export function consentsOf(
    node: Pick<FleetNodeView, 'capabilities' | 'workerState'> & { consents?: unknown },
): FleetConsents {
    return effectiveConsents({
        consents: node.consents,
        capabilities: node.capabilities ?? [],
        workerState: node.workerState ?? null,
    });
}

/** True when the node reported its consents itself (a daemon with FL-02), false when they are inferred. */
export function consentsReported(node: { consents?: unknown }): boolean {
    return normalizeFleetConsents(node.consents) !== null;
}

/** The three consents in force, in their canonical order. */
export function consentsInForce(consents: FleetConsents): LinkConsentKey[] {
    return LINK_CONSENT_KEYS.filter((key) => consents[key] === true);
}

/** The three consents NOT in force, in their canonical order. */
export function missingConsents(consents: FleetConsents): LinkConsentKey[] {
    return LINK_CONSENT_KEYS.filter((key) => consents[key] !== true);
}

/** True when any consent that opens a link is on (README D2). */
export function opensLink(consents: FleetConsents): boolean {
    return consentsInForce(consents).length > 0;
}

/**
 * The exact command that keeps every consent the node holds and turns `add`
 * on as well — so following it never silently drops a consent the owner gave
 * (spec §5.2: `ever-works-node start --work --attend --manage`). Flags come in
 * the canonical order; `--usage-scan` is kept when the node holds it.
 */
export function consentStartCommand(
    consents: FleetConsents,
    add: LinkConsentKey | readonly LinkConsentKey[] = [],
): string {
    const adding = new Set<string>(typeof add === 'string' ? [add] : add);
    const flags: string[] = [];
    for (const key of LINK_CONSENT_KEYS) {
        if (consents[key] === true || adding.has(key)) flags.push(FLEET_CONSENT_FLAGS[key]);
    }
    if (consents.usageScan === true) flags.push(FLEET_CONSENT_FLAGS.usageScan);
    return flags.length > 0 ? `${NODE_START_COMMAND} ${flags.join(' ')}` : NODE_START_COMMAND;
}

/** The `start` flag behind one consent (`--attend`). */
export function consentFlag(key: LinkConsentKey): string {
    return FLEET_CONSENT_FLAGS[key];
}

/** Which sentence the link line says for this state and these consents. */
export function linkStateMessageKey(
    state: FleetNodeLinkState,
    consents: FleetConsents,
): LinkStateMessageKey {
    switch (state) {
        case 'connected':
            return 'connected';
        case 'reconnecting':
            return 'reconnecting';
        case 'refused':
            return 'refused';
        case 'unsupported-kind':
            return 'unsupportedKind';
        case 'not-open':
        default:
            return opensLink(consents) ? 'notOpen' : 'notOpenNoConsent';
    }
}

/** The dot beside the word: filled only while the platform holds the link. */
export function linkDotFilled(state: FleetNodeLinkState): boolean {
    return state === 'connected';
}

/**
 * The bytes this link carried since it connected, both ways, as "12.4 MB"
 * (FR-41), or null when the link is not connected or the counters are absent.
 */
export function linkBytesLabel(link: FleetNodeLinkView | null | undefined): string | null {
    if (!link || link.state !== 'connected') return null;
    const total = finiteBytes(link.bytesIn) + finiteBytes(link.bytesOut);
    return formatBytes(total);
}

function finiteBytes(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Whether the header should name a missing consent's command (FR-28): only
 * for a link the deployment accepts on a kind of computer that can give the
 * consent, and only when one is missing.
 */
export function shouldNameMissingConsent(
    state: FleetNodeLinkState,
    consents: FleetConsents,
): boolean {
    if (state === 'refused' || state === 'unsupported-kind') return false;
    return missingConsents(consents).length > 0;
}

/** Message leaf under `fleet.errors` for each link refusal code (spec §5.3; leaves are camelCase). */
export const LINK_ERROR_MESSAGE_KEYS: Readonly<Record<FleetLinkErrorCode, string>> = {
    not_found: 'notFound',
    invalid: 'invalid',
    unreachable: 'unreachable',
    consent_missing: 'consentMissing',
    permission_denied: 'permissionDenied',
    confirmation_required: 'confirmationRequired',
    root_required: 'rootRequired',
    kill_switch: 'killSwitch',
    limit_exceeded: 'limitExceeded',
    unsupported_on_node: 'unsupportedOnNode',
    busy: 'busy',
    operation_failed: 'operationFailed',
    internal: 'internal',
    resume_failed: 'resumeFailed',
};

/** The `fleet.errors` leaf for a refusal code off the wire; an unknown code reads as `internal`. */
export function linkErrorMessageKey(code: unknown): string {
    return isFleetLinkErrorCode(code)
        ? LINK_ERROR_MESSAGE_KEYS[code]
        : LINK_ERROR_MESSAGE_KEYS.internal;
}
