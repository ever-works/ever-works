import { Inject, Injectable, Logger } from '@nestjs/common';
import { FleetKillSwitchService } from '@ever-works/agent/fleet';
import {
    effectiveConsents,
    fleetConsentMissingHint,
    fleetConsentSatisfies,
    fleetLinkMachineVerbActionFamily,
    fleetLinkVerbConsent,
    FLEET_LINK_FAMILY_ACTION_FAMILY,
    FLEET_LINK_FAMILY_CONSENT,
    isFleetLinkStateChangingFamily,
    type FleetLinkConsentRequirement,
    type FleetLinkFamily,
} from '@ever-works/contracts';
import { fleetLinkError } from './fleet-link.errors';
import { FleetLinkRegistry } from './fleet-link.registry';
import {
    FLEET_LINK_AUDIENCE,
    type FleetLinkAudience,
    type FleetLinkAudienceDecision,
    type FleetLinkCaller,
    type FleetLinkNodeFacts,
    type FleetLinkRequirement,
} from './fleet-link.types';

/**
 * Fleet node link — the authorisation every channel open and every request
 * passes BEFORE the node is contacted (spec FR-23, CONTRACTS §2.1, R-24).
 *
 * In order, and the first refusal is the answer:
 *
 *  0. **Existence** — a caller outside the node's `view` audience gets
 *     `not_found`, exactly as every node endpoint answers a stranger, so a
 *     refusal never confirms the node exists.
 *  1. **Kill switch** — read fail-closed: on, or unreadable, refuses
 *     `kill_switch`.
 *  2. **Consent** — the consent the family (or the `machine` verb) needs,
 *     against what the node's live link presented, else what its last
 *     heartbeat stored (`effectiveConsents`, which never infers `manage`):
 *     `consent_missing` with the command to run on the machine.
 *  3. **Family audience** — the node's control policy for the action family
 *     against the caller's role (FL-01's role derivation behind
 *     {@link FLEET_LINK_AUDIENCE}): `permission_denied` with who to ask.
 *
 * Reachability (`unreachable`) is the service's, after all of this: a
 * refusal is never a reason to wake a machine.
 */

/** How strict each consent requirement is, for "a caller may narrow, never widen". */
function atLeastAsStrict(
    candidate: FleetLinkConsentRequirement,
    base: FleetLinkConsentRequirement,
): boolean {
    if (candidate === base || base === 'link') return true;
    return base === 'work-or-manage' && (candidate === 'work' || candidate === 'manage');
}

/** The requirement of a family (or one `machine` verb), narrowed by the caller where it asked to be. */
export function resolveFleetLinkRequirement(
    family: FleetLinkFamily,
    verb: string | null,
    narrow: Partial<FleetLinkRequirement> = {},
): FleetLinkRequirement {
    const machineVerb = family === 'machine' && verb !== null;
    const baseConsent = machineVerb
        ? fleetLinkVerbConsent(verb)
        : FLEET_LINK_FAMILY_CONSENT[family];
    const consent =
        narrow.consent !== undefined && atLeastAsStrict(narrow.consent, baseConsent)
            ? narrow.consent
            : baseConsent;
    const actionFamily =
        narrow.actionFamily ??
        (machineVerb
            ? fleetLinkMachineVerbActionFamily(verb)
            : FLEET_LINK_FAMILY_ACTION_FAMILY[family]);
    // A `machine` verb changes the machine unless it is a `view` read; a
    // family by the CONTRACTS list. Fail-safe both ways: when in doubt it is
    // treated as state-changing (audited, refused while stopped).
    const stateChanging =
        narrow.stateChanging ??
        (machineVerb ? actionFamily !== 'view' : isFleetLinkStateChangingFamily(family));
    return { consent, actionFamily, stateChanging, target: narrow.target ?? null };
}

@Injectable()
export class FleetLinkAuthorizer {
    private readonly logger = new Logger(FleetLinkAuthorizer.name);

    constructor(
        private readonly killSwitch: FleetKillSwitchService,
        private readonly registry: FleetLinkRegistry,
        @Inject(FLEET_LINK_AUDIENCE) private readonly audience: FleetLinkAudience,
    ) {}

    /** Resolve and check the requirement; throws the first refusal. */
    async authorize(input: {
        node: FleetLinkNodeFacts;
        caller: FleetLinkCaller;
        family: FleetLinkFamily;
        verb?: string | null;
        requirement?: Partial<FleetLinkRequirement>;
    }): Promise<FleetLinkRequirement> {
        const { node, caller, family } = input;
        const requirement = resolveFleetLinkRequirement(
            family,
            input.verb ?? null,
            input.requirement,
        );
        if (
            input.requirement?.consent !== undefined &&
            input.requirement.consent !== requirement.consent
        ) {
            this.logger.warn(
                `a ${family} caller asked for consent "${input.requirement.consent}", weaker than "${requirement.consent}"; the stricter one applies`,
            );
        }

        // 0. Existence.
        const visible = await this.audience.check({ node, caller, actionFamily: 'view' });
        if (visible.allowed !== true) throw fleetLinkError('not_found', 'no such computer');

        // 1. Kill switch, fail-closed.
        let stopped: boolean;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        if (stopped) throw fleetLinkError('kill_switch', 'clear it under Settings → Fleet');

        // 2. Consent.
        const consents =
            this.registry.liveConsents(node.id) ??
            effectiveConsents({
                consents: node.storedConsents,
                capabilities: node.capabilities,
                workerState: node.workerState,
            });
        if (!fleetConsentSatisfies(consents, requirement.consent)) {
            throw fleetLinkError(
                'consent_missing',
                fleetConsentMissingHint(requirement.consent, node.name),
                {
                    family,
                    consent: requirement.consent,
                    ...(input.verb ? { verb: input.verb } : {}),
                },
            );
        }

        // 3. Family audience (`view` was step 0).
        if (requirement.actionFamily !== 'view') {
            const decision = await this.audience.check({
                node,
                caller,
                actionFamily: requirement.actionFamily,
            });
            if (decision.allowed !== true) {
                const refusal = decision as Extract<FleetLinkAudienceDecision, { allowed: false }>;
                if (refusal.asNotFound) throw fleetLinkError('not_found', 'no such computer');
                throw fleetLinkError(
                    'permission_denied',
                    refusal.hint ??
                        `ask the owner of ${node.name} to allow you: ${requirement.actionFamily}`,
                    { actionFamily: requirement.actionFamily },
                );
            }
        }
        return requirement;
    }
}
