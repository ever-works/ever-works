import { SAFETY_RAIL_ORDER, type SafetyRailId } from '@ever-works/contracts';
import type { SafetyRailMiddleware } from '../safety-rails';
import { capsRail } from './caps.rail';
import { grantsRail } from './grants.rail';
import { ladderRail } from './ladder.rail';
import { platformStopRail } from './platform-stop.rail';
import { rulesRail } from './rules.rail';
import { scopePauseRail } from './scope-pause.rail';
import { workspacePauseRail } from './workspace-pause.rail';

export { capsRail } from './caps.rail';
export { grantsRail } from './grants.rail';
export { ladderRail } from './ladder.rail';
export { platformStopRail } from './platform-stop.rail';
export { rulesRail } from './rules.rail';
export { scopePauseRail } from './scope-pause.rail';
export { workspacePauseRail } from './workspace-pause.rail';

/**
 * Every rail, by its published id.
 *
 * The CHAIN is built by walking `SAFETY_RAIL_ORDER` over this map rather than
 * by listing the middlewares in an array here — so the order lives in exactly
 * one place (the contract the product documents), and a rail that is added to
 * the map without being placed in the order simply never runs, loudly, rather
 * than running in whatever position an import happened to land in.
 */
export const SAFETY_RAILS: Readonly<Record<SafetyRailId, SafetyRailMiddleware | null>> =
    Object.freeze({
        'platform-stop': platformStopRail,
        'workspace-pause': workspacePauseRail,
        'scope-pause': scopePauseRail,
        grants: grantsRail,
        ladder: ladderRail,
        caps: capsRail,
        rules: rulesRail,
        // Not a rail: `taxonomy` names the classifier so an unclassified
        // action can be recorded against something.
        taxonomy: null,
    } as Record<SafetyRailId, SafetyRailMiddleware | null>);

/** The seven rails, in the published order, ready for `composeSafetyRails`. */
export function defaultSafetyRailChain(): readonly SafetyRailMiddleware[] {
    return SAFETY_RAIL_ORDER.map((railId) => {
        const rail = SAFETY_RAILS[railId];
        if (!rail) {
            throw new Error(`SAFETY_RAIL_ORDER names "${railId}", which has no middleware.`);
        }
        return rail;
    });
}
