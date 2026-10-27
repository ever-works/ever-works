import {
    FLEET_CONSENT_FLAGS,
    FLEET_TOOL_CATEGORY_LABELS,
    FLEET_TOOL_COPY,
    fleetPermissionDeniedHint,
    type ActionCategory,
    type FleetActionFamily,
    type FleetConsentKey,
    type FleetToolCatalogueEntry,
    type FleetToolErrorBody,
    type FleetToolGateName,
    type FleetViewerRole,
    type TrustRung,
} from '@ever-works/contracts';

/**
 * FL-19 — the gate (spec FR-6 … FR-9, CONTRACTS §2.1, plan §11).
 *
 * An Agent may act in a fleet family only when THREE things agree: its tool
 * grants allow the tool (AW-15), its trust ladder allows the category (AW-24),
 * and the computer's owner has let the Agent's owner into the family — plus
 * the computer holds the family's consent. This file is that rule as ONE pure
 * function, so the truth table is testable and the Capabilities block, the
 * API and the docs cannot disagree about it.
 *
 * ## Where each step is enforced at run time
 *
 * The decision is not a second enforcement point — it is the published rule
 * every existing one follows:
 *
 *   1–6  kill switch → workspace pause → Agent pause → grants → ladder → caps:
 *        the AW-24 safety gate the run loop asks before EVERY tool call
 *        (`agent-run.service.ts` `evaluateSafety`), classified by the tool's
 *        own name through `ENTRY_POINT_CATEGORY` (which FL-19 fills from the
 *        catalogue), plus the AW-15 grant filter in tool assembly;
 *   7–8  audience → consent: the family service the tool calls, which runs the
 *        same chain a person's click runs with the Agent's OWNER as the caller
 *        (`FleetAccessService.assertFamily`, the link authoriser).
 *
 * This function answers the same question without side effects, for the
 * Capabilities block (`GET /api/fleet/tools/gate`) and for the tests.
 *
 * ## Order and the first refusal
 *
 * Gates run in `FLEET_TOOL_GATE_ORDER` (contracts); the FIRST refusal wins and is
 * named. A hold (the Ask or Draft rung, or a row that is always held) is not a
 * refusal: the remaining gates still run, so an act the computer's audience
 * would refuse is refused — never held as a Decision nobody in that audience
 * could approve (FR-9, spec S5).
 *
 * ## Reads
 *
 * A read-only tool skips the kill switch, the pauses, the ladder and the caps
 * (U3: read tools keep working while the switch is on; FR-2: `read.internal`
 * is not laddered). It still needs its grant, the family audience and the
 * consent (U2).
 */

/** What the gate needs about the computer, when the call targets one. */
export interface FleetToolGateComputer {
    name: string;
    /** The Agent's OWNER's role on it (FL-01 role derivation). */
    role: FleetViewerRole;
    /** The owner's control policy admits that role in `view`. */
    viewAllows: boolean;
    /** The owner's control policy admits that role in the row's permission family. */
    familyAllows: boolean;
    /** The consent the family needs (`FLEET_TOOL_FAMILY_CONSENT`), null for none. */
    consentRequired: FleetConsentKey | null;
    /** The consents the node last reported (null = never reported: treated as not held). */
    consents: Partial<Record<FleetConsentKey, boolean>> | null;
}

export interface FleetToolGateInput {
    tool: Pick<
        FleetToolCatalogueEntry,
        'name' | 'readOnly' | 'category' | 'permissionFamily' | 'alwaysHeld'
    >;
    agentName: string;
    killSwitch: boolean;
    workspacePaused: boolean;
    agentPaused: boolean;
    /** AW-15 — the grant decision for the tool name, and the scope that decided a denial. */
    grant: { allowed: boolean; deniedAtScope?: string | null };
    /** AW-24 — the rung the row's category resolves to; null when not laddered (reads). */
    rung: TrustRung | null;
    /** AW-24 caps — the limit that is exhausted, when one is. */
    capExceeded?: string | null;
    /** The computer the call targets; absent for a fleet-wide call (`fleet_status`). */
    computer?: FleetToolGateComputer | null;
}

export type FleetToolGateOutcome = 'allow' | 'held' | 'refused';

export interface FleetToolGateDecision {
    outcome: FleetToolGateOutcome;
    /** The refusing gate (refused), or `ladder` (held). Null when allowed. */
    gate: FleetToolGateName | null;
    /** The CONTRACTS §8 refusal (refused only). */
    error: FleetToolErrorBody | null;
    /** A Decision is created for the owner (held only — never for an audience or consent refusal). */
    createsDecision: boolean;
    /** An AW-24 refusal record is written (refusals by gates 1–6 only, FR-9). */
    recordsRefusal: boolean;
    /** The rung the hold came from (held only). */
    heldAt: 'ask' | 'draft' | 'always' | null;
}

const ALLOW: FleetToolGateDecision = Object.freeze({
    outcome: 'allow',
    gate: null,
    error: null,
    createsDecision: false,
    recordsRefusal: false,
    heldAt: null,
}) as FleetToolGateDecision;

function refuse(
    gate: FleetToolGateName,
    code: FleetToolErrorBody['code'],
    hint: string,
    details?: Record<string, unknown>,
): FleetToolGateDecision {
    const error: FleetToolErrorBody = { code, hint, details: { gate, ...(details ?? {}) } };
    return {
        outcome: 'refused',
        gate,
        error,
        createsDecision: false,
        // FR-9: the ladder and grants (and the stops above them) are AW-24's
        // to record; the computer's own refusal is not an AW-24 event.
        recordsRefusal: gate !== 'audience' && gate !== 'consent',
        heldAt: null,
    };
}

/** "'Change a computer'" — the category label the hints name. */
export function fleetCategoryLabel(category: ActionCategory | null | undefined): string {
    if (!category) return 'This kind of work';
    return FLEET_TOOL_CATEGORY_LABELS[category] ?? category;
}

/** The sentence a consent refusal carries: the exact start command. */
export function fleetConsentHint(key: FleetConsentKey, computer: string): string {
    return `start the node with ever-works-node start ${FLEET_CONSENT_FLAGS[key]} on ${computer}`;
}

/** Gates 7–8 for one computer: null when it allows, else the refusal. */
function computerRefusal(
    family: FleetActionFamily,
    computer: FleetToolGateComputer | null | undefined,
): FleetToolGateDecision | null {
    if (!computer) return null;
    // Outside `view`, the computer does not exist for the caller (CONTRACTS §2.1).
    if (!computer.viewAllows) return refuse('audience', 'not_found', 'no such computer');
    if (!computer.familyAllows) {
        const hint = fleetPermissionDeniedHint(computer.name, family, computer.role);
        return refuse('audience', 'permission_denied', hint, { family });
    }
    const key = computer.consentRequired;
    if (key && computer.consents?.[key] !== true) {
        return refuse('consent', 'consent_missing', fleetConsentHint(key, computer.name), {
            consent: key,
        });
    }
    return null;
}

/**
 * The gate's answer for one call. Pure: no I/O, no clock, no recording — the
 * caller writes the refusal record or the Decision the answer asks for.
 */
export function decideFleetToolCall(input: FleetToolGateInput): FleetToolGateDecision {
    const { tool } = input;
    const isRead = tool.readOnly === true;

    if (!isRead) {
        if (input.killSwitch)
            return refuse('kill_switch', 'kill_switch', FLEET_TOOL_COPY.killSwitch());
        if (input.workspacePaused) {
            return refuse(
                'workspace_pause',
                'permission_denied',
                'the workspace is paused — resume it under Settings → Safety',
            );
        }
        if (input.agentPaused) {
            return refuse(
                'agent_pause',
                'permission_denied',
                `${input.agentName} is paused — resume it on its page`,
            );
        }
    }

    if (!input.grant.allowed) {
        return refuse(
            'grants',
            'permission_denied',
            FLEET_TOOL_COPY.grantDenied(tool.name, input.grant.deniedAtScope ?? 'Agent'),
        );
    }

    let heldAt: FleetToolGateDecision['heldAt'] = null;
    if (!isRead) {
        if (input.rung === 'off') {
            return refuse(
                'ladder',
                'permission_denied',
                FLEET_TOOL_COPY.rungOff(fleetCategoryLabel(tool.category), input.agentName),
                { category: tool.category ?? null },
            );
        }
        if (input.rung === 'ask' || input.rung === 'draft') heldAt = input.rung;
        else if (tool.alwaysHeld) heldAt = 'always';

        if (input.capExceeded) return refuse('caps', 'limit_exceeded', input.capExceeded);
    }

    const computer = computerRefusal(tool.permissionFamily, input.computer);
    if (computer) return computer;

    if (heldAt) {
        return {
            outcome: 'held',
            gate: 'ladder',
            error: null,
            createsDecision: true,
            recordsRefusal: false,
            heldAt,
        };
    }
    return ALLOW;
}

/** The gates a read never passes through (kept beside the order so the two cannot drift). */
export const FLEET_TOOL_GATES_SKIPPED_BY_READS: readonly FleetToolGateName[] = Object.freeze([
    'kill_switch',
    'workspace_pause',
    'agent_pause',
    'ladder',
    'caps',
]);
