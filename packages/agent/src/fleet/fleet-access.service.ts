import {
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    effectiveControlPolicy,
    fleetFamilyAllows,
    fleetPermissionDeniedHint,
    type FleetActionFamily,
    type FleetViewerRole,
} from '@ever-works/contracts';
import type { FleetNode } from '../entities/fleet-node.entity';
import { FleetNodeRepository } from './fleet-node.repository';
import { FleetOrganizationDirectory } from './fleet-organization-directory';

/**
 * Fleet hub (FL-01) — who may see and do what on a computer.
 *
 * A Node belongs to the person who enrolled it (README D15). Everyone else
 * is judged by ROLE relative to that Node — derived here, server-side, from
 * facts the caller cannot supply — and the Node's per-family control policy
 * (CONTRACTS §2.1, `effectiveControlPolicy` in `@ever-works/contracts`):
 *
 *   - `owner`      — `node.userId` is the caller;
 *   - `org-admin`  — the Node is bound to an Organization and the caller is
 *                    that Organization's Tenant owner (who holds no roster
 *                    row: a member of every Organization of the Tenant by
 *                    construction) or holds a roster row with role `admin`;
 *   - `org-member` — the caller holds a roster row with role `member`;
 *   - `stranger`   — everyone else, including every non-owner of a Node
 *                    bound to no Organization (FR-26).
 *
 * The Organization binding is read from the NODE ROW, never from a request
 * (spec §6). Tenant membership without a roster row is deliberately NOT a
 * role: machine access fails closed (lane log, question 2).
 *
 * The roster's `role` column was display-only until EW-P2-6 made `admin`
 * grant integration keys; CONTRACTS §2.1 makes it an input to the Fleet
 * family checks too — this file is the one place that reads it for that.
 *
 * ## Refusals
 *
 * A caller outside the `view` audience gets a 404 indistinguishable from an
 * unknown id (FR-30) — for EVERY family, so the existence of a Node is never
 * confirmed to someone who may not see it. A caller who may see the Node but
 * not act in a family gets `permission_denied` with the CONTRACTS §8 hint.
 *
 * The Organization facts come through `FleetOrganizationDirectory`, which is
 * `@Optional()`: a context without it derives only `owner | stranger`,
 * which is the fail-closed answer, never a wider one.
 */

/** Who is asking: a user id, or anything carrying one. */
export type FleetCaller = string | { userId: string };

/** The columns a role and family decision read off a Node. */
export type FleetAccessNode = Pick<FleetNode, 'id' | 'userId' | 'name'> &
    Partial<Pick<FleetNode, 'organizationId' | 'controlPolicy' | 'controlPolicyFamilies'>>;

/** A Node together with the caller's role on it. */
export interface FleetNodeAccess<TNode extends FleetAccessNode = FleetNode> {
    node: TNode;
    role: FleetViewerRole;
}

/** The facts a role is derived from — pure, so the truth table is testable on its own. */
export interface FleetRoleFacts {
    nodeOwnerUserId: string;
    callerUserId: string;
    /** The Organization the Node is bound to, or null. */
    organizationId: string | null | undefined;
    /** The owner of that Organization's Tenant, when known. */
    tenantOwnerUserId?: string | null;
    /** The caller's roster role in that Organization, when they hold a row. */
    rosterRole?: string | null;
}

/**
 * The role truth table (ACC-FL01-14): owner / admin of the bound
 * Organization / member of it / member of another / no Organization →
 * owner / org-admin / org-member / stranger / stranger.
 */
export function resolveFleetViewerRole(facts: FleetRoleFacts): FleetViewerRole {
    if (facts.callerUserId && facts.nodeOwnerUserId === facts.callerUserId) return 'owner';
    if (!facts.organizationId || !facts.callerUserId) return 'stranger';
    if (facts.tenantOwnerUserId && facts.tenantOwnerUserId === facts.callerUserId) {
        return 'org-admin';
    }
    // `owner` never appears on a roster row today (the Tenant owner has none);
    // read defensively as an administrator rather than dropped to stranger.
    if (facts.rosterRole === 'admin' || facts.rosterRole === 'owner') return 'org-admin';
    if (facts.rosterRole === 'member') return 'org-member';
    return 'stranger';
}

/** The body of a family refusal: CONTRACTS §8's envelope, with `message` for existing clients. */
export function fleetPermissionDeniedBody(
    node: Pick<FleetAccessNode, 'name'>,
    family: FleetActionFamily,
    role: FleetViewerRole,
): {
    statusCode: 403;
    message: string;
    error: { code: 'permission_denied'; hint: string; details: Record<string, unknown> };
} {
    const hint = fleetPermissionDeniedHint(node.name, family, role);
    return {
        statusCode: 403,
        message: hint,
        error: { code: 'permission_denied', hint, details: { family } },
    };
}

/**
 * The body of an OWNER-ONLY refusal (favourite, the policy itself — spec §7):
 * someone who may see the Node is told only its owner can, never who that is.
 */
export function fleetOwnerOnlyBody(node: Pick<FleetAccessNode, 'name'>): {
    statusCode: 403;
    message: string;
    error: { code: 'permission_denied'; hint: string; details: Record<string, unknown> };
} {
    const hint = `Only the owner of ${node.name} can do this.`;
    return {
        statusCode: 403,
        message: hint,
        error: { code: 'permission_denied', hint, details: { ownerOnly: true } },
    };
}

function callerId(caller: FleetCaller): string {
    return typeof caller === 'string' ? caller : (caller?.userId ?? '');
}

function notFound(nodeId: string): NotFoundException {
    // The same message `FleetService.getOwnedNode` answers with, so a foreign
    // node and a missing one read identically.
    return new NotFoundException(`Fleet node ${nodeId} not found`);
}

@Injectable()
export class FleetAccessService {
    private readonly logger = new Logger(FleetAccessService.name);

    constructor(
        private readonly nodes: FleetNodeRepository,
        // @Optional() per the positional-construction rule the specs rely on;
        // absent, every non-owner derives `stranger` (fail-closed).
        @Optional() private readonly directory?: FleetOrganizationDirectory,
    ) {}

    /** The caller's role on one Node. Never throws: an unreadable fact derives `stranger`. */
    async roleFor(node: FleetAccessNode, caller: FleetCaller): Promise<FleetViewerRole> {
        const userId = callerId(caller);
        if (!userId) return 'stranger';
        if (node.userId === userId) return 'owner';
        const organizationId = node.organizationId ?? null;
        if (!organizationId) return 'stranger';
        try {
            if (!this.directory) return 'stranger';
            const [tenantOwnerUserId, rosterRole] = await Promise.all([
                this.directory.tenantOwnerOf(organizationId),
                this.directory.rosterRole(organizationId, userId),
            ]);
            return resolveFleetViewerRole({
                nodeOwnerUserId: node.userId,
                callerUserId: userId,
                organizationId,
                tenantOwnerUserId,
                rosterRole,
            });
        } catch (error) {
            this.logger.warn(
                `Fleet role for node ${node.id} could not be derived, answering stranger: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return 'stranger';
        }
    }

    /** May the caller act in `family` on this Node? Pure read, never throws. */
    async canAct(
        node: FleetAccessNode,
        caller: FleetCaller,
        family: FleetActionFamily,
    ): Promise<boolean> {
        const role = await this.roleFor(node, caller);
        return this.allows(node, role, family);
    }

    /**
     * Refuse unless the caller may act in `family` on this Node; answers the
     * role on success. A caller outside `view` gets the 404 of an unknown id
     * whatever the family; inside `view` but outside `family`, a 403
     * `permission_denied` carrying the hint.
     *
     * This is the check FL-02's link authoriser and every family-gated route
     * call (CONTRACTS §2.1): kill switch and consent are checked by their
     * owners, this answers only "is this person in the audience".
     */
    async assertFamily(
        node: FleetAccessNode,
        caller: FleetCaller,
        family: FleetActionFamily,
    ): Promise<FleetViewerRole> {
        const role = await this.roleFor(node, caller);
        if (!this.allows(node, role, 'view')) throw notFound(node.id);
        if (!this.allows(node, role, family)) {
            throw new ForbiddenException(fleetPermissionDeniedBody(node, family, role));
        }
        return role;
    }

    /** Load a Node by id and {@link assertFamily}. An unknown id is the same 404. */
    async resolveForFamily(
        nodeId: string,
        caller: FleetCaller,
        family: FleetActionFamily,
    ): Promise<FleetNodeAccess> {
        const node = await this.nodes.findById(nodeId);
        if (!node) throw notFound(nodeId);
        const role = await this.assertFamily(node, caller, family);
        return { node, role };
    }

    /** A Node the caller may see, with the role they see it as (404 otherwise). */
    async resolveVisible(nodeId: string, caller: FleetCaller): Promise<FleetNodeAccess> {
        return this.resolveForFamily(nodeId, caller, 'view');
    }

    /**
     * Nodes OTHER people own that the caller may see through an Organization:
     * bound to an Organization where the caller derives `org-admin` or
     * `org-member`, and whose `view` audience admits that role. The caller's
     * own Nodes are not included (the owner-scoped list already has them, with
     * its offline sweep).
     *
     * Two reads for the caller's Organizations (their Tenant if they own one,
     * their roster rows), one for the Nodes bound to them — never one query
     * per Node.
     */
    async listSharedWith(caller: FleetCaller): Promise<FleetNodeAccess[]> {
        const userId = callerId(caller);
        if (!userId || !this.directory) return [];
        try {
            const roles = new Map<string, FleetViewerRole>();
            for (const organizationId of await this.directory.organizationsOwnedThroughTenant(
                userId,
            )) {
                roles.set(organizationId, 'org-admin');
            }
            for (const row of await this.directory.rosterRowsFor(userId)) {
                if (roles.has(row.organizationId)) continue;
                const role = resolveFleetViewerRole({
                    nodeOwnerUserId: '',
                    callerUserId: userId,
                    organizationId: row.organizationId,
                    rosterRole: row.role,
                });
                if (role !== 'stranger') roles.set(row.organizationId, role);
            }
            if (roles.size === 0) return [];
            const rows = await this.nodes.findByOrganizations([...roles.keys()]);
            const shared: FleetNodeAccess[] = [];
            for (const node of rows) {
                if (node.userId === userId || !node.organizationId) continue;
                // An `enrolling` row is an outstanding one-time token, not a
                // computer: it is the owner's business alone.
                if (node.status === 'enrolling') continue;
                const role = roles.get(node.organizationId);
                if (role && this.allows(node, role, 'view')) shared.push({ node, role });
            }
            return shared;
        } catch (error) {
            // Strictly best-effort: the caller's own Nodes never depend on it.
            this.logger.warn(
                `Fleet nodes shared with ${userId} could not be listed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }

    private allows(node: FleetAccessNode, role: FleetViewerRole, family: FleetActionFamily) {
        return fleetFamilyAllows(
            {
                controlPolicy: node.controlPolicy,
                controlPolicyFamilies: node.controlPolicyFamilies,
            },
            role,
            family,
        );
    }
}

/** The policy in force on a Node row — re-exported so callers need one import. */
export { effectiveControlPolicy };
