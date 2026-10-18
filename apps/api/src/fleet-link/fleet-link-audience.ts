import { Injectable, Optional } from '@nestjs/common';
import { FleetAccessService } from '@ever-works/agent/fleet';
import { fleetFamilyAllows, fleetPermissionDeniedHint } from '@ever-works/contracts';
import type {
    FleetLinkAudience,
    FleetLinkAudienceDecision,
    FleetLinkAudienceQuery,
} from './fleet-link.types';

/**
 * The owner-only family audience: what the link answers in a context without
 * the Fleet hub's role derivation, and what {@link RoleBasedFleetLinkAudience}
 * still answers for an Agent caller.
 *
 * A node belongs to the person who enrolled it (README D15). Without the
 * role derivation only `owner | stranger` can be told apart: so the owner is
 * in every family's audience, and nobody else is in any. That is the
 * CONTRACTS default for every family but `view` (`org-members`), and the safe
 * reading of `view` when Organization roles cannot be read. A stranger asking
 * about a node gets `not_found`, exactly as the node endpoints answer one, so
 * a refusal never confirms the node exists.
 *
 *  - a person: the node's owner only;
 *  - a schedule: the owner's own (its command was created by the owner);
 *  - a system job: the platform itself (drain-all, the idle policy);
 *  - an Agent: refused here — the Agent gates (grants, trust ladder, caps)
 *    are FL-19's, and an Agent may act only when BOTH they and the node's
 *    audience allow it (CONTRACTS §2.1).
 */
@Injectable()
export class OwnerOnlyFleetLinkAudience implements FleetLinkAudience {
    check(query: FleetLinkAudienceQuery): FleetLinkAudienceDecision {
        const { caller, node } = query;
        switch (caller.kind) {
            case 'system':
                return { allowed: true };
            case 'schedule':
                return caller.ownerUserId === node.userId
                    ? { allowed: true }
                    : { allowed: false, asNotFound: true };
            case 'user':
                return caller.userId === node.userId
                    ? { allowed: true }
                    : { allowed: false, asNotFound: true };
            case 'agent':
                if (caller.ownerUserId !== node.userId) return { allowed: false, asNotFound: true };
                // The owner's own Agent may see the owner's computers (as the
                // existing read-only `list_fleet_nodes` tool does), not act on them.
                return query.actionFamily === 'view'
                    ? { allowed: true }
                    : {
                          allowed: false,
                          hint: `Agents cannot act on ${node.name} yet: Agent access to computers arrives with the Fleet agent tools`,
                      };
        }
    }
}

/**
 * The family audience through the Fleet hub's role derivation (FL-01
 * `FleetAccessService`, CONTRACTS §2.1) — what {@link FLEET_LINK_AUDIENCE} is
 * bound to.
 *
 * The caller's ROLE on the node (owner · org-admin · org-member · stranger,
 * derived server-side from the node's Organization binding and the roster,
 * never from the request) is matched against the node's control policy for
 * the action family, with the hub's own truth table (`fleetFamilyAllows`):
 *
 *  - outside the node's `view` audience → `not_found`, for every family, so
 *    a refusal never confirms the node exists;
 *  - inside `view` but not the family → `permission_denied` with the hub's
 *    hint ("Ask the owner of build-01 to allow org admins: services.");
 *  - a schedule acts with its owner's role; a system job (drain-all, the idle
 *    policy) is the platform itself;
 *  - an Agent keeps the owner-only answer: the Agent gates (grants, trust
 *    ladder, caps) are FL-19's, and an Agent may act only when BOTH they and
 *    the node's audience allow it (CONTRACTS §2.1).
 *
 * Without `FleetAccessService` in the context it answers owner-only.
 */
@Injectable()
export class RoleBasedFleetLinkAudience implements FleetLinkAudience {
    private readonly ownerOnly = new OwnerOnlyFleetLinkAudience();

    constructor(@Optional() private readonly access?: FleetAccessService) {}

    async check(query: FleetLinkAudienceQuery): Promise<FleetLinkAudienceDecision> {
        const { caller, node, actionFamily } = query;
        if (!this.access || caller.kind === 'agent' || caller.kind === 'system') {
            return this.ownerOnly.check(query);
        }
        const userId = caller.kind === 'user' ? caller.userId : caller.ownerUserId;
        const policy = {
            controlPolicy: node.controlPolicy,
            controlPolicyFamilies: node.controlPolicyFamilies,
        };
        const role = await this.access.roleFor(
            {
                id: node.id,
                userId: node.userId,
                name: node.name,
                organizationId: node.organizationId,
                ...policy,
            },
            userId,
        );
        if (!fleetFamilyAllows(policy, role, 'view')) return { allowed: false, asNotFound: true };
        if (fleetFamilyAllows(policy, role, actionFamily)) return { allowed: true };
        return { allowed: false, hint: fleetPermissionDeniedHint(node.name, actionFamily, role) };
    }
}
