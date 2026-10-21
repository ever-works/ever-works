import { fleetRunBindingOf, type MachinePrincipalRequest } from './machine-principal';

/**
 * Works-security (run-token scope, 2026-10-18) — a fleet-run token stays in
 * the Organization it was minted for.
 *
 * `FleetRunCredentialService` mints a run token bound to the job's
 * Organization, and `SessionScopeGuard` seeds that Organization as the
 * request's scope. Every surface that READS the seeded scope (Goals,
 * Missions, Agents, Tasks) was therefore pinned already. Four did not read it
 * and answered per USER instead: Works (`WorkOwnershipService` is creator /
 * member only, the Works list is every accessible Work), the Knowledge Base
 * nested under a Work, the Inbox, and Ideas (the `mine` list and the owner's
 * single read are per user). A prompt-injected run in Organization A could
 * list and read every Work, KB document, Inbox item and Idea of the owner's
 * other Organizations, and carry it out through the tools.
 *
 * The pin is the token's binding, never a header the caller controls:
 *
 *   - `organizationId: '<org>'` — only that Organization's Works / Inbox items;
 *   - `organizationId: null` — the job had no Organization (the owner's
 *     personal scope): only Works / Inbox items with no Organization. A
 *     personal-scope run cannot reach any Organization's records, and an
 *     Organization's run cannot reach personal ones.
 *
 * Sessions, personal API keys and integration keys are never pinned here
 * (an integration key has its own Organization pin in
 * `IntegrationPrincipalGuard`).
 *
 * Switch: `FLEET_RUN_TOKEN_ORG_PIN_ENFORCED`, ON by default. Only the literal
 * `false` / `0` turns it off (the pre-2026-10-18 owner-wide behaviour); any
 * other value, or none, keeps it on.
 */
export function isFleetRunOrgPinEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED ?? '').trim().toLowerCase();
    return raw !== 'false' && raw !== '0';
}

/** The Organization a fleet-run request is pinned to (`null` = personal scope). */
export interface FleetRunOrganizationPin {
    organizationId: string | null;
}

/**
 * The Organization pin of this request, or `null` when the request is not a
 * fleet-run token (or the pin is switched off) and nothing should be narrowed.
 */
export function fleetRunOrganizationPin(
    req: MachinePrincipalRequest | null | undefined,
    env: NodeJS.ProcessEnv = process.env,
): FleetRunOrganizationPin | null {
    const binding = fleetRunBindingOf(req);
    if (!binding) return null;
    if (!isFleetRunOrgPinEnforced(env)) return null;
    const organizationId =
        typeof binding.organizationId === 'string' && binding.organizationId
            ? binding.organizationId
            : null;
    return { organizationId };
}

/** Whether a record's Organization is inside the pin (`null` matches `null` only). */
export function isInsideOrganizationPin(
    record: { organizationId?: string | null } | null | undefined,
    pin: FleetRunOrganizationPin,
): boolean {
    if (!record) return false;
    return (record.organizationId ?? null) === pin.organizationId;
}
