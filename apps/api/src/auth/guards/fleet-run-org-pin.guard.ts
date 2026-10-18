import {
    CanActivate,
    ExecutionContext,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import type { MachinePrincipalRequest } from '../machine-principal';
import { fleetRunOrganizationPin, isInsideOrganizationPin } from '../fleet-run-scope';

/** A Work id is a v4-shaped UUID (`@PrimaryGeneratedColumn('uuid')`). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Work a request path addresses, for the two families a fleet-run token
 * can reach: `/api/works/{id}/…` (Works, the Knowledge Base, comparisons,
 * schedule, history) and `/api/deploy/works/{id}/…`. `undefined` when the
 * path addresses no Work; the raw (decoded) segment otherwise, which may not
 * be a UUID (`/api/works/stats` routes to a static handler).
 */
export function workIdOfPath(path: unknown): string | undefined {
    if (typeof path !== 'string') return undefined;
    const withoutQuery = path.split('?')[0]?.split('#')[0] ?? '';
    const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
    const lower = segments.map((segment) => segment.toLowerCase());
    let raw: string | undefined;
    if (lower[0] === 'api' && lower[1] === 'works' && segments.length >= 3) {
        raw = segments[2];
    } else if (
        lower[0] === 'api' &&
        lower[1] === 'deploy' &&
        lower[2] === 'works' &&
        segments.length >= 4
    ) {
        raw = segments[3];
    }
    if (raw === undefined) return undefined;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/**
 * Works-security (run-token scope, 2026-10-18) — the ONE place a fleet-run
 * token's Organization pin is enforced for every `/api/works/{id}…` and
 * `/api/deploy/works/{id}…` route, whichever controller serves it.
 *
 * `WorkOwnershipService` answers "is this user the creator or a member" and
 * nothing more, so before this guard an Organization-pinned run token could
 * read (and, where the route list grants it, write) a Work — and its
 * Knowledge Base, which nests under it — of any of the owner's other
 * Organizations. This guard runs globally right after `SessionScopeGuard`
 * and, for a fleet-run request only, answers the same `404 Work not found`
 * a missing Work gets unless the Work's Organization equals the token's
 * (`null` = the owner's personal scope, which matches only Works with no
 * Organization). A path segment that is not a Work id at all
 * (`/api/works/stats`, an aggregate over every Organization) is refused the
 * same way: a run token reaches Works by id.
 *
 * Sessions, personal API keys and integration keys pass untouched, and so
 * does every request when `FLEET_RUN_TOKEN_ORG_PIN_ENFORCED=false`. The
 * Works LIST and the Inbox are narrowed in their controllers (a path guard
 * cannot filter a list).
 */
@Injectable()
export class FleetRunOrgPinGuard implements CanActivate {
    constructor(@Optional() private readonly works?: WorkRepository) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<
            MachinePrincipalRequest & { path?: unknown; url?: unknown }
        >();
        const pin = fleetRunOrganizationPin(request);
        if (!pin) return true;

        const path = typeof request.path === 'string' ? request.path : request.url;
        const workId = workIdOfPath(path);
        if (workId === undefined) return true;

        if (!UUID_PATTERN.test(workId) || !this.works) {
            // Not a Work id (a static sibling route), or no repository bound to
            // check against: refuse rather than guess. Fail closed.
            throw notFound(workId);
        }
        const work = await this.works.findByIdForAccess(workId);
        if (!isInsideOrganizationPin(work, pin)) {
            throw notFound(workId);
        }
        return true;
    }
}

/** The same body `WorkOwnershipService` answers for a missing Work. */
function notFound(workId: string): NotFoundException {
    return new NotFoundException({
        status: 'error',
        message: `Work with id '${workId.slice(0, 64)}' not found`,
    });
}
