import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser, FleetRunCredentialBinding } from './types/auth.types';
import { IntegrationHttpException } from './integration/integration-http.exception';
import { isIntegrationPrincipal } from './integration/integration-attribution';

/**
 * Works-security lane 3a (2026-10-18) — the NON-SESSION principals that act
 * as a person without being one, and the body fields they may not set.
 *
 * Two credentials resolve `request.user` to a real person while being driven
 * by a machine:
 *
 *   - a **fleet-run token** (`ew_run_…`): minted per fleet job for the model
 *     running on the owner's PC; it acts AS the owner, and `AuthSessionGuard`
 *     leaves `request.fleetRunCredential` behind;
 *   - an **integration key** (`ew_int_…`): `authMethod: 'integration'`.
 *
 * Both are reachable by prompt injection — the model reads repository text,
 * Task descriptions and tool output; an integration mirrors another system's
 * records — so neither may change the controls that decide what the platform
 * later does on the owner's behalf without a person: the merge policy, the
 * shell commands a node runs, whether a run starts. A route-level allowlist
 * cannot see a body field, so those refusals live here and the controllers
 * call them. Personal API keys (`ew_live_…`) are the owner's own and are NOT
 * covered: humans keep every feature.
 */

/** Which machine principal made the request, if any. */
export type MachinePrincipalKind = 'fleet-run' | 'integration';

/** The request shape these helpers read: only what `AuthSessionGuard` stashes. */
export interface MachinePrincipalRequest {
    fleetRunCredential?: FleetRunCredentialBinding | unknown;
}

/** The fleet-run binding on this request, or `null` for every other credential. */
export function fleetRunBindingOf(
    req: MachinePrincipalRequest | null | undefined,
): FleetRunCredentialBinding | null {
    const binding = req?.fleetRunCredential;
    if (!binding || typeof binding !== 'object') return null;
    return binding as FleetRunCredentialBinding;
}

/** True when a fleet-run token (`ew_run_…`) authenticated this request. */
export function isFleetRunRequest(req: MachinePrincipalRequest | null | undefined): boolean {
    return fleetRunBindingOf(req) !== null;
}

/** `'fleet-run'`, `'integration'`, or `null` for a session / personal key. */
export function machinePrincipalKind(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
): MachinePrincipalKind | null {
    if (isFleetRunRequest(req)) return 'fleet-run';
    if (isIntegrationPrincipal(auth)) return 'integration';
    return null;
}

/** The fields of `fields` the body actually carries (`undefined` = absent). */
export function presentFields(
    body: Record<string, unknown> | null | undefined,
    fields: readonly string[],
): string[] {
    if (!body || typeof body !== 'object') return [];
    return fields.filter((field) => body[field] !== undefined);
}

const PRINCIPAL_LABEL: Readonly<Record<MachinePrincipalKind, string>> = {
    'fleet-run': 'A fleet-run credential',
    integration: 'An integration key',
};

/**
 * Refuse a request from a machine principal that tries to set any of
 * `fields`. A fleet-run token gets `403 Forbidden` (the posture of every
 * other run-token refusal); an integration key gets its own envelope,
 * `422 domain_rule` with `details.fields`, the integrations contract's code
 * for "a rule refuses this write". Sessions and personal keys pass untouched.
 *
 * `what` completes the sentence "… cannot change <fields> on <what>", and
 * `why` (optional) is appended so the caller learns who CAN make the change.
 */
export function refuseMachinePrincipalFields(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
    body: Record<string, unknown> | null | undefined,
    fields: readonly string[],
    what: string,
    why = 'a person changes it in the app.',
): void {
    const kind = machinePrincipalKind(auth, req);
    if (!kind) return;
    const offending = presentFields(body, fields);
    if (offending.length === 0) return;
    throwMachinePrincipalRefusal(
        kind,
        `${PRINCIPAL_LABEL[kind]} cannot change ${offending.join(', ')} on ${what}; ${why}`,
        { fields: offending },
    );
}

/**
 * Refuse an ACTION (not a field) for a machine principal: starting a run,
 * deciding a gate. Same status mapping as {@link refuseMachinePrincipalFields}.
 * `kinds` narrows which principals the rule applies to (default: both).
 */
export function refuseMachinePrincipalAction(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
    action: string,
    why: string,
    kinds: readonly MachinePrincipalKind[] = ['fleet-run', 'integration'],
): void {
    const kind = machinePrincipalKind(auth, req);
    if (!kind || !kinds.includes(kind)) return;
    throwMachinePrincipalRefusal(kind, `${PRINCIPAL_LABEL[kind]} cannot ${action}; ${why}`, {
        reason: 'machine_principal',
    });
}

function throwMachinePrincipalRefusal(
    kind: MachinePrincipalKind,
    message: string,
    details: Record<string, unknown>,
): never {
    if (kind === 'integration') {
        throw new IntegrationHttpException(422, 'domain_rule', message, details);
    }
    throw new ForbiddenException(message);
}

// ── Body-field sets ─────────────────────────────────────────────────────────

/**
 * Refuse every field of `body` that is NOT in `allowed` (present = not
 * `undefined`) for a machine principal — the allowlist twin of
 * {@link refuseMachinePrincipalFields}, for routes where the safe set is
 * small and new fields must default to refused.
 */
export function refuseMachinePrincipalFieldsOutside(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
    body: Record<string, unknown> | null | undefined,
    allowed: readonly string[],
    what: string,
    why = 'a person changes it in the app.',
): void {
    if (!machinePrincipalKind(auth, req) || !body || typeof body !== 'object') return;
    const outside = Object.keys(body).filter(
        (field) => body[field] !== undefined && !allowed.includes(field),
    );
    refuseMachinePrincipalFields(auth, req, body, outside, what, why);
}

/**
 * Task fields a machine principal may not set on create or update: the
 * acceptance checks are shell commands (`phase: 'setup'` entries are the
 * setup steps) a fleet node runs with `shell: true`, and the planner treats
 * them as owner-authored; `extraRepos` mounts further repositories into a
 * run (and opens pull requests there); `isolationMode` decides whether a run
 * works on a task branch at all; `maxGateAttempts` is how many times a red
 * gate is retried.
 */
export const MACHINE_REFUSED_TASK_FIELDS: readonly string[] = Object.freeze([
    'acceptanceChecks',
    'extraRepos',
    'isolationMode',
    'maxGateAttempts',
]);

/**
 * `DeleteWorkDto` flags that destroy something beyond the Work row: the
 * owner's GitHub repositories, an App Work's stored data, and the force
 * path. Never honoured for a machine principal.
 */
export const MACHINE_REFUSED_WORK_DELETE_FIELDS: readonly string[] = Object.freeze([
    'delete_data_repository',
    'delete_markdown_repository',
    'delete_website_repository',
    'delete_stored_data',
    'force_delete',
]);

/**
 * `DeleteWorkDto` declares class-property DEFAULTS (`= false`), so a body that
 * never mentioned a flag still carries it as `false`. Only a TRUE flag asks
 * for anything; this helper keeps the refusal to those.
 */
export function truthyFields(
    body: Record<string, unknown> | null | undefined,
    fields: readonly string[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!body || typeof body !== 'object') return out;
    for (const field of fields) {
        if (body[field] === true) out[field] = true;
    }
    return out;
}

// ── Agent assignment by a fleet run ─────────────────────────────────────────

/**
 * The permission keys of `target` that are granted while `own` does not grant
 * them — i.e. what assigning `target` would WIDEN beyond the run's own Agent.
 * Only boolean grants are compared; a missing object grants nothing.
 */
export function widerAgentPermissions(
    target: Record<string, unknown> | null | undefined,
    own: Record<string, unknown> | null | undefined,
): string[] {
    if (!target || typeof target !== 'object') return [];
    const ownGrants = own && typeof own === 'object' ? own : {};
    return Object.keys(target)
        .filter((key) => target[key] === true && ownGrants[key] !== true)
        .sort();
}

// ── Human gates ─────────────────────────────────────────────────────────────

/**
 * Works-security lane 3a — a HUMAN DECISION (an approval, a rejection, an
 * escalation resolution, a definition-of-done sign-off) may only be made in
 * a person's interactive session.
 *
 * The merge verifier accepts any `decidedVia: 'user'` approval, and every
 * credential that resolves `request.user` to the owner used to be able to
 * record one: a personal API key held by an MCP client, an integration key
 * acting as the recipient, a fleet-run token. An approval a model can give
 * is not an approval. Same fail-closed predicate as `HumanActorGuard` and
 * `SessionOnlyGuard`: only `authMethod === 'session'` passes, and a missing
 * stamp is NOT a person. Every route that is not a decision keeps accepting
 * personal keys.
 */
export function isHumanSession(auth: AuthenticatedUser | null | undefined): boolean {
    return auth?.authMethod === 'session';
}

export function requireHumanSession(
    auth: AuthenticatedUser | null | undefined,
    decision: string,
): void {
    if (isHumanSession(auth)) return;
    if (isIntegrationPrincipal(auth)) {
        throw new IntegrationHttpException(
            422,
            'domain_rule',
            `Only a person signed in to Ever Works can ${decision}; an integration key cannot.`,
            { reason: 'human_session_required' },
        );
    }
    throw new ForbiddenException(
        `Only a person signed in to Ever Works can ${decision}; an API key, an automation or a fleet run cannot.`,
    );
}
