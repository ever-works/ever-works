import {
    fleetLinkMachineVerbActionFamily,
    fleetLinkVerbConsent,
    FLEET_LINK_FAMILY_ACTION_FAMILY,
    FLEET_LINK_FAMILY_CONSENT,
    isFleetLinkStateChangingFamily,
    type FleetLinkConsentRequirement,
    type FleetLinkFamily,
} from '@ever-works/contracts';
import type { FleetLinkRequirement } from './fleet-link.types';

/**
 * Fleet node link — the requirement of a family or a `machine` verb (FL-02,
 * CONTRACTS §2.1): the consent it needs, its action family, whether it changes
 * the machine, its target. Used by `FleetLinkAuthorizer` before anything is
 * contacted, and by `FleetLinkRemote` to rebuild a requirement that arrived
 * over the relay bus.
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
