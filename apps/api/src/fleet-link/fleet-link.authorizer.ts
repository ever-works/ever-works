import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { FleetKillSwitchService } from '@ever-works/agent/fleet';
import {
    effectiveConsents,
    fleetConsentMissingHint,
    fleetConsentSatisfies,
    type FleetLinkFamily,
} from '@ever-works/contracts';
import { fleetLinkError } from './fleet-link.errors';
import { resolveFleetLinkRequirement } from './fleet-link-requirement';
import { FleetLinkRegistry } from './fleet-link.registry';
import { FleetLinkRemote } from './fleet-link-remote.service';
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
 *     against what the node's live link presented (on this API replica or
 *     the one holding it), else what its last
 *     heartbeat stored (`effectiveConsents`, which never infers `manage`):
 *     `consent_missing` with the command to run on the machine.
 *  3. **Family audience** — the node's control policy for the action family
 *     against the caller's role (FL-01's role derivation behind
 *     {@link FLEET_LINK_AUDIENCE}): `permission_denied` with who to ask.
 *
 * Reachability (`unreachable`) is the service's, after all of this: a
 * refusal is never a reason to wake a machine.
 */

// The requirement resolver lives in its own module so `FleetLinkRemote` (which
// the authoriser injects) can rebuild a forwarded requirement with it without
// an import cycle; re-exported here, where callers have always found it.
export { resolveFleetLinkRequirement } from './fleet-link-requirement';

@Injectable()
export class FleetLinkAuthorizer {
    private readonly logger = new Logger(FleetLinkAuthorizer.name);

    constructor(
        private readonly killSwitch: FleetKillSwitchService,
        private readonly registry: FleetLinkRegistry,
        @Inject(FLEET_LINK_AUDIENCE) private readonly audience: FleetLinkAudience,
        // A link another API replica holds presents its consents there (FL-02 P1b).
        @Optional() private readonly remote?: FleetLinkRemote,
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
            this.remote?.liveConsents(node.id) ??
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
