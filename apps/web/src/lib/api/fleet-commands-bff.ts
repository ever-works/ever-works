import {
    FLEET_COMMAND_CWD_MAX_LENGTH,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_COMMAND_MAX_NODES,
    FLEET_SCHEDULE_HISTORY,
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
    type FleetCommandRunRequest,
    type FleetScheduleUpdateRequest,
} from '@ever-works/contracts';
import { isUuid } from './computer-bff';

/**
 * Commands on computers (FL-12) — the shared half of the command BFF routes
 * under `app/api/fleet/commands/`.
 *
 * The session BFF's two rules (`fleet-sessions-bff.ts`): ids are checked before
 * anything leaves the web tier, and every body is REBUILT field by field from
 * an allow-list — the browser never smuggles a field upstream. Limits a person
 * can hit (8 KiB, 50 computers, 3 600 s) are left to the platform, which
 * answers them as `limit_exceeded` naming the limit; this only refuses what no
 * legitimate request is (ten times those sizes). The platform's status and
 * CONTRACTS §8 envelope pass through untouched — including the 409
 * `confirmation_required` summary the dialog renders.
 */

export {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from './fleet-sessions-bff';

/** The run body (`POST /api/fleet/commands`), rebuilt. */
export function sanitizeRunBody(raw: Record<string, unknown>): Partial<FleetCommandRunRequest> {
    const body: Partial<FleetCommandRunRequest> = {};
    if (typeof raw.command === 'string' && raw.command.length <= FLEET_COMMAND_MAX_LENGTH * 10) {
        body.command = raw.command;
    }
    if (Array.isArray(raw.nodeIds) && raw.nodeIds.length <= FLEET_COMMAND_MAX_NODES * 10) {
        body.nodeIds = raw.nodeIds.filter((id): id is string => isUuid(id));
    }
    if (
        typeof raw.cwd === 'string' &&
        raw.cwd.trim().length > 0 &&
        raw.cwd.length <= FLEET_COMMAND_CWD_MAX_LENGTH * 4
    ) {
        body.cwd = raw.cwd;
    }
    if (typeof raw.timeoutSec === 'number' && Number.isFinite(raw.timeoutSec)) body.timeoutSec = raw.timeoutSec;
    if (raw.confirm === true) body.confirm = true;
    // Schedules on computers (FL-13): a cadence makes it a schedule on ONE computer.
    const cadence = sanitizeCadence(raw.cadence);
    if (cadence) body.cadence = cadence;
    const schedule = body as Partial<FleetCommandRunRequest> & { name?: string; nodeId?: string };
    if (typeof raw.name === 'string' && raw.name.length <= FLEET_SCHEDULE_NAME_MAX_LENGTH * 4) schedule.name = raw.name;
    if (isUuid(raw.nodeId)) schedule.nodeId = raw.nodeId;
    return body;
}

/** A cadence (FL-13), rebuilt from its three possible fields; the platform validates it. */
export function sanitizeCadence(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { timezone: 'node' };
    if (typeof record.kind === 'string' && record.kind.length <= 16) out.kind = record.kind;
    if ((typeof record.expr === 'string' && record.expr.length <= 120) || typeof record.expr === 'number') {
        out.expr = record.expr;
    }
    if (typeof record.at === 'string' && record.at.length <= 5) out.at = record.at;
    return out;
}

/** The schedule edit body (`PATCH /api/fleet/commands/:id`, FL-13), rebuilt. */
export function sanitizeScheduleUpdateBody(raw: Record<string, unknown>): FleetScheduleUpdateRequest {
    const body: FleetScheduleUpdateRequest = {};
    if (typeof raw.name === 'string' && raw.name.length <= FLEET_SCHEDULE_NAME_MAX_LENGTH * 4) body.name = raw.name;
    if (isUuid(raw.nodeId)) body.nodeId = raw.nodeId;
    if (typeof raw.command === 'string' && raw.command.length <= FLEET_COMMAND_MAX_LENGTH * 10) {
        body.command = raw.command;
    }
    if (raw.cwd === null || (typeof raw.cwd === 'string' && raw.cwd.length <= FLEET_COMMAND_CWD_MAX_LENGTH * 4)) {
        body.cwd = raw.cwd;
    }
    const cadence = sanitizeCadence(raw.cadence);
    if (cadence) body.cadence = cadence;
    if (raw.confirm === true) body.confirm = true;
    return body;
}

/** The runs query: only `limit` (1–30) survives, as a `?…` string. */
export function sanitizeRunsQuery(params: URLSearchParams): string {
    const limit = Number(params.get('limit'));
    return Number.isInteger(limit) && limit >= 1 && limit <= FLEET_SCHEDULE_HISTORY ? `?limit=${limit}` : '';
}

/** The list query: only `limit` (1–50) survives, as a `?…` string. */
export function sanitizeCommandListQuery(params: URLSearchParams): string {
    const limit = Number(params.get('limit'));
    return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? `?limit=${limit}` : '';
}
