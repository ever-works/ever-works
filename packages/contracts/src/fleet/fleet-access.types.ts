/**
 * Fleet hub (FL-01) — who may do what on a computer.
 *
 * A Node belongs to the person who enrolled it (README D15). What anyone
 * else may see or do on it is granted by that person through the Node's
 * **control policy**: a map from an **action family** to an **audience**
 * (CONTRACTS §2.1). This file is the one definition of that map, its
 * defaults, and the pure truth table every family check runs through —
 * the API, the web tier and the node link all ask the same functions, so
 * "may an org admin restart a service on build-01" can only have one
 * answer.
 *
 * ## The legacy single value
 *
 * Before this map existed a Node carried one `controlPolicy` value (AW-11:
 * who may take control of a live view). It is kept, unchanged in type and
 * meaning, as the **`desktop` family's mirror**: a map with no `desktop`
 * entry reads `desktop` from it, and every write of the map's `desktop`
 * entry writes it back. So every reader of the old value keeps reading the
 * right answer, and nothing about AW-11's behaviour moves on the day the
 * map ships.
 *
 * ## Roles
 *
 * The audience is matched against the caller's **role** relative to the
 * Node: `owner` (enrolled it), `org-admin` / `org-member` (Tenant owner or
 * roster admin / roster member of the Organization the Node is bound to),
 * or `stranger`. Roles are derived server-side, never stored and never
 * read from a request (`FleetAccessService` in the agent package).
 */

import { COMPUTER_CONTROL_POLICIES, type ComputerControlPolicy } from '../computer/computer-session.types.js';
import { COMPUTER_VIEWER_ROLES, type ComputerViewerRole } from '../computer/computer-control.types.js';

/**
 * The action families of a Node's control policy, in display order
 * (CONTRACTS §2.1). Every state-changing machine action belongs to exactly
 * one of them; actions that are not obviously one family map as CONTRACTS
 * §2.1 says (wake, virtual and cloud computers, Actions runners →
 * `machines`; port list and `health.now` → `view`).
 */
export const FLEET_ACTION_FAMILIES = [
	'view',
	'sessions',
	'desktop',
	'logs',
	'services',
	'docker',
	'processes',
	'ports',
	'files',
	'commands',
	'schedules',
	'checkouts',
	'machines'
] as const;

export type FleetActionFamily = (typeof FLEET_ACTION_FAMILIES)[number];

export function isFleetActionFamily(value: unknown): value is FleetActionFamily {
	return typeof value === 'string' && (FLEET_ACTION_FAMILIES as readonly string[]).includes(value);
}

/**
 * Who a family is open to. The same three values (and the same list
 * object) as AW-11's control policy, because the `desktop` family IS that
 * policy.
 */
export type FleetAudience = ComputerControlPolicy;

export const FLEET_AUDIENCES: readonly FleetAudience[] = COMPUTER_CONTROL_POLICIES;

export function isFleetAudience(value: unknown): value is FleetAudience {
	return typeof value === 'string' && (FLEET_AUDIENCES as readonly string[]).includes(value);
}

/** The caller relative to one Node — the AW-11 viewer roles, reused. */
export type FleetViewerRole = ComputerViewerRole;

export const FLEET_VIEWER_ROLES: readonly FleetViewerRole[] = COMPUTER_VIEWER_ROLES;

/** A complete policy: every family has an audience. */
export type FleetControlPolicyFamilies = Readonly<Record<FleetActionFamily, FleetAudience>>;

/** A partial policy as stored or sent: families that are absent take their default. */
export type FleetControlPolicyFamiliesInput = Partial<Record<FleetActionFamily, FleetAudience>>;

/**
 * Defaults: `view` is open to the members of the Organization the Node is
 * bound to (listing only — every other family stays the owner's); every
 * other family is the owner's alone. A Node bound to no Organization has
 * no members, so for it the defaults are "only me" everywhere.
 */
export const FLEET_CONTROL_POLICY_DEFAULTS: FleetControlPolicyFamilies = Object.freeze({
	view: 'org-members',
	sessions: 'owner',
	desktop: 'owner',
	logs: 'owner',
	services: 'owner',
	docker: 'owner',
	processes: 'owner',
	ports: 'owner',
	files: 'owner',
	commands: 'owner',
	schedules: 'owner',
	checkouts: 'owner',
	machines: 'owner'
});

/**
 * Plain-language name of a family for a server-side hint ("ask the owner
 * of build-01 to allow org admins: lifecycle"). `machines` reads
 * "lifecycle" because that is what it governs: rename, pause, drain,
 * remove, wake, virtual and cloud computers, Actions runners. The web tier
 * labels families from its own i18n keys; this is for API messages only.
 */
export const FLEET_ACTION_FAMILY_HINT_LABELS: Readonly<Record<FleetActionFamily, string>> = Object.freeze({
	view: 'view',
	sessions: 'sessions',
	desktop: 'desktop',
	logs: 'logs',
	services: 'services',
	docker: 'Docker',
	processes: 'processes',
	ports: 'ports',
	files: 'files',
	commands: 'commands',
	schedules: 'schedules',
	checkouts: 'checkouts',
	machines: 'lifecycle'
});

/** What a policy read needs off a Node row or view. */
export interface FleetControlPolicySubject {
	/** The legacy single value — the `desktop` family's mirror. */
	controlPolicy?: unknown;
	/** The stored family map (a JSON column: may arrive as an object or a string). */
	controlPolicyFamilies?: unknown;
}

/**
 * Normalise a family map arriving from a column, a request or the wire.
 *
 * Unknown families and unknown audiences are DROPPED, never coerced: a
 * value this build does not understand must fall back to the family's
 * default (the narrower answer), not to whatever a guess would make of it.
 * Returns null for anything that is not an object (or a JSON string of
 * one) — "no map stored".
 */
export function normalizeControlPolicyFamilies(value: unknown): FleetControlPolicyFamiliesInput | null {
	let candidate: unknown = value;
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate);
		} catch {
			return null;
		}
	}
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
	const out: FleetControlPolicyFamiliesInput = {};
	for (const family of FLEET_ACTION_FAMILIES) {
		const audience = (candidate as Record<string, unknown>)[family];
		if (isFleetAudience(audience)) out[family] = audience;
	}
	return out;
}

/**
 * The policy in force on a Node: defaults, then the legacy single value as
 * `desktop`, then whatever the stored map says. The map's own `desktop`
 * entry therefore wins over the legacy column (CONTRACTS §2.1) — the two
 * are kept equal by every writer, so in practice they never disagree.
 */
export function effectiveControlPolicy(node: FleetControlPolicySubject | null | undefined): FleetControlPolicyFamilies {
	const legacy = node?.controlPolicy;
	const stored = normalizeControlPolicyFamilies(node?.controlPolicyFamilies) ?? {};
	return {
		...FLEET_CONTROL_POLICY_DEFAULTS,
		desktop: isFleetAudience(legacy) ? legacy : FLEET_CONTROL_POLICY_DEFAULTS.desktop,
		...stored
	};
}

/**
 * Does `audience` admit a caller in `role`?
 *
 *                 owner   org-admin   org-member   stranger
 *   owner          yes       no           no          no
 *   org-admins     yes       yes          no          no
 *   org-members    yes       yes          yes         no
 *
 * The owner is always admitted — a policy only ever widens who else may
 * act, it never narrows the owner out — and a stranger never is (FR-32).
 * The same table as AW-11's `canControl` (`packages/agent/src/computer/control-policy.ts`),
 * which answers the `desktop` family for live-view take-over.
 */
export function audienceIncludes(audience: FleetAudience, role: FleetViewerRole): boolean {
	if (role === 'owner') return true;
	if (role === 'org-admin') return audience === 'org-admins' || audience === 'org-members';
	if (role === 'org-member') return audience === 'org-members';
	return false;
}

/** May a caller in `role` act in `family` on a Node whose policy is read off `node`? */
export function fleetFamilyAllows(
	node: FleetControlPolicySubject | null | undefined,
	role: FleetViewerRole,
	family: FleetActionFamily
): boolean {
	return audienceIncludes(effectiveControlPolicy(node)[family], role);
}

/** One family whose audience a policy write changed — one `node.policy.change` audit row each. */
export interface FleetControlPolicyChange {
	family: FleetActionFamily;
	from: FleetAudience;
	to: FleetAudience;
}

/** The families whose audience differs between two policies, in family order. */
export function diffControlPolicyFamilies(
	before: FleetControlPolicyFamilies,
	after: FleetControlPolicyFamilies
): FleetControlPolicyChange[] {
	const changes: FleetControlPolicyChange[] = [];
	for (const family of FLEET_ACTION_FAMILIES) {
		if (before[family] !== after[family]) changes.push({ family, from: before[family], to: after[family] });
	}
	return changes;
}

/** The narrowest audience that admits `role` — what the owner would have to allow. Null for a stranger. */
export function narrowestAudienceFor(role: FleetViewerRole): FleetAudience | null {
	if (role === 'owner') return 'owner';
	if (role === 'org-admin') return 'org-admins';
	if (role === 'org-member') return 'org-members';
	return null;
}

/**
 * The `permission_denied` hint (CONTRACTS §8): what the caller can do about
 * a refusal, in one sentence that names the Node, who to ask and what to
 * allow — "Ask the owner of build-01 to allow org admins: services." Never
 * names the owner or any member (the hint travels to people the owner did
 * not choose to tell).
 */
export function fleetPermissionDeniedHint(nodeName: string, family: FleetActionFamily, role: FleetViewerRole): string {
	const needed = narrowestAudienceFor(role);
	const label = FLEET_ACTION_FAMILY_HINT_LABELS[family];
	if (needed === 'org-admins') return `Ask the owner of ${nodeName} to allow org admins: ${label}.`;
	if (needed === 'org-members') return `Ask the owner of ${nodeName} to allow org members: ${label}.`;
	return `Only the owner of ${nodeName} can do this.`;
}
