import {
    FLEET_LOGS_MAX_MERGED_SOURCES,
    clampFleetLogsLines,
    isFleetLogSourceId,
    type FleetLogsAttachRequest,
} from '@ever-works/contracts';

/**
 * Logs on computers (FL-08) — the shared half of the logs BFF routes under
 * `app/api/fleet/nodes/[id]/logs/`. Same rules as the session BFF
 * (`fleet-sessions-bff.ts`): ids are checked before anything leaves the web
 * tier, and the body is REBUILT field by field — the browser never smuggles a
 * field upstream. The platform's status and CONTRACTS §8 envelope pass
 * through untouched.
 */

export {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from './fleet-sessions-bff';

/** The attach-token body, rebuilt; null when no valid source is named (the route answers 400). */
export function sanitizeLogsAttachBody(
    raw: Record<string, unknown>,
): FleetLogsAttachRequest | null {
    if (!isFleetLogSourceId(raw.source)) return null;
    const body: FleetLogsAttachRequest = { source: raw.source };
    if (Array.isArray(raw.sources)) {
        const sources = raw.sources
            .filter(isFleetLogSourceId)
            .slice(0, FLEET_LOGS_MAX_MERGED_SOURCES - 1);
        if (sources.length !== raw.sources.length) return null;
        if (sources.length > 0) body.sources = sources;
    }
    if (raw.lines !== undefined) body.lines = clampFleetLogsLines(raw.lines);
    if (typeof raw.follow === 'boolean') body.follow = raw.follow;
    return body;
}
