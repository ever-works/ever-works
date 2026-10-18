import { ForbiddenException } from '@nestjs/common';
import {
    reservedTaskLabelChanges,
    reservedTaskLabelRefusal,
    taskReservedLabelsEnforced,
    TASK_RESERVED_LABELS_ENFORCED_ENV,
    type ReservedTaskLabelChange,
} from '@ever-works/contracts';
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

// ── Autonomous Task text (recurring templates, scheduled Tasks) ─────────────

/**
 * Works-security (2026-10-18) — the Task fields every later autonomous run
 * DISPATCHES: what the agent reads (title, description) and which Work's
 * repository it runs in. The integrations route already refuses them on a
 * recurring template (`tasks-write.controller.ts`, lane 3a); the core
 * `PATCH /api/tasks/:id` — fleet-run allowlisted, and what MCP `update_task`
 * reaches — did not.
 */
export const AUTONOMOUS_TASK_TEXT_FIELDS: readonly string[] = Object.freeze([
    'title',
    'description',
    'workId',
]);

/** Off (refused) unless `MACHINE_PRINCIPAL_AUTONOMOUS_TEXT_EDIT=true`. Default-safe. */
export function machinePrincipalAutonomousTextEditAllowed(): boolean {
    return (process.env.MACHINE_PRINCIPAL_AUTONOMOUS_TEXT_EDIT ?? '').trim().toLowerCase() === 'true';
}

/** A Task whose text a FUTURE run dispatches with no person in between. */
export function isAutonomouslyDispatchedTask(
    task: { isRecurring?: boolean | null; scheduledAt?: Date | string | null } | null | undefined,
): boolean {
    return task?.isRecurring === true || (task?.scheduledAt !== undefined && task?.scheduledAt !== null);
}

/**
 * Refuse a machine principal's edit of {@link AUTONOMOUS_TASK_TEXT_FIELDS} on
 * a recurring template or a scheduled Task: every later fire dispatches that
 * text to an agent (`task-recurrence-dispatcher.service.ts`), so one injected
 * run would author the instructions of every run after it. Re-sending the
 * current value is not a change. A person edits it in the app; the operator
 * can re-open it with `MACHINE_PRINCIPAL_AUTONOMOUS_TEXT_EDIT=true`.
 */
export function refuseMachinePrincipalAutonomousTextEdit(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
    task: Record<string, unknown> & { isRecurring?: boolean | null; scheduledAt?: Date | string | null },
    body: Record<string, unknown> | null | undefined,
): void {
    const kind = machinePrincipalKind(auth, req);
    if (!kind || machinePrincipalAutonomousTextEditAllowed()) return;
    if (!isAutonomouslyDispatchedTask(task)) return;
    const changed = presentFields(body, AUTONOMOUS_TASK_TEXT_FIELDS).filter(
        (field) => (body as Record<string, unknown>)[field] !== (task[field] ?? null),
    );
    if (changed.length === 0) return;
    const recurring = task.isRecurring === true;
    throwMachinePrincipalRefusal(
        kind,
        `${PRINCIPAL_LABEL[kind]} cannot change ${changed.join(', ')} on a ${
            recurring ? 'recurring Task template' : 'scheduled Task'
        }: every run it starts dispatches that text to an agent. A person edits it in the app.`,
        { fields: changed, reason: recurring ? 'recurring_template' : 'scheduled_task' },
    );
}

// ── Re-filing a Task that already has a branch ──────────────────────────────

/**
 * Works-security (2026-10-18) — a fleet run may not move a Task that already
 * has a branch or a pull request to another Work, or hand it to another Agent.
 * The merge gate resolves the Task's pull request NUMBER in the Task's Work's
 * repository and judges it under that Work's / Agent's merge policy, so
 * re-filing it would have the gate judge (and possibly merge) a different
 * pull request under a different policy. Re-sending the current value is not a
 * change. A person re-files it in the app.
 */
export function refuseRunTokenRefileOfBranchedTask(
    req: MachinePrincipalRequest | null | undefined,
    task: {
        workId?: string | null;
        agentId?: string | null;
        prNumber?: number | null;
        branchRef?: string | null;
    },
    body: { workId?: string | null; agentId?: string | null } | null | undefined,
): void {
    if (!isFleetRunRequest(req)) return;
    if (!task.prNumber && !(task.branchRef && task.branchRef.trim())) return;
    const changed: string[] = [];
    if (body?.workId !== undefined && (body.workId ?? null) !== (task.workId ?? null)) {
        changed.push('workId');
    }
    if (body?.agentId !== undefined && (body.agentId ?? null) !== (task.agentId ?? null)) {
        changed.push('agentId');
    }
    if (changed.length === 0) return;
    throw new ForbiddenException(
        `A fleet-run credential cannot change ${changed.join(', ')} on a Task that already has a branch or ` +
            "pull request: its merge is judged in that Work, under that Agent's policy. A person re-files it in the app.",
    );
}

// ── Reserved Task labels ────────────────────────────────────────────────────

/**
 * Works-security (2026-10-18) — the restriction `TasksService` applies to a
 * machine principal's label writes: no RESERVED label (`awaiting-owner`,
 * `app-provision`, `release:*`, `provision-attempt-*`) may be added or
 * removed. `undefined` for a session / personal key — a person keeps full
 * control.
 */
export function reservedLabelRestrictionOf(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
): { who: string } | undefined {
    const kind = machinePrincipalKind(auth, req);
    return kind ? { who: PRINCIPAL_LABEL[kind] } : undefined;
}

/**
 * Refuse a machine principal's label write that would add or remove a reserved
 * label, in the principal's own envelope (fleet run → 403, integration key →
 * `422 domain_rule`). `before` is the Task's current labels (`[]` on create).
 * No-op for a person, a write that leaves labels alone, or with
 * `TASK_RESERVED_LABELS_ENFORCED=false`.
 */
export function refuseMachinePrincipalReservedLabels(
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
    before: readonly string[] | null | undefined,
    after: readonly string[] | null | undefined,
): void {
    const kind = machinePrincipalKind(auth, req);
    if (!kind) return;
    if (!taskReservedLabelsEnforced(process.env[TASK_RESERVED_LABELS_ENFORCED_ENV])) return;
    const change = reservedTaskLabelChanges(before, after);
    if (change.added.length === 0 && change.removed.length === 0) return;
    throwReservedLabelRefusal(kind, change);
}

/**
 * Re-throw a `TasksService` reserved-label refusal (`ReservedTaskLabelError`,
 * a 403) in the integration envelope when the caller is an integration key;
 * anything else is re-thrown unchanged. Duck-typed on the error's `name` and
 * `change` so this file need not import the agent package.
 */
export function rethrowReservedLabelRefusal(
    error: unknown,
    auth: AuthenticatedUser | null | undefined,
    req: MachinePrincipalRequest | null | undefined,
): never {
    const kind = machinePrincipalKind(auth, req);
    const change = (error as { name?: unknown; change?: ReservedTaskLabelChange } | null)?.change;
    if (
        kind === 'integration' &&
        (error as { name?: unknown } | null)?.name === 'ReservedTaskLabelError' &&
        change
    ) {
        throwReservedLabelRefusal(kind, change);
    }
    throw error;
}

function throwReservedLabelRefusal(kind: MachinePrincipalKind, change: ReservedTaskLabelChange): never {
    throwMachinePrincipalRefusal(kind, reservedTaskLabelRefusal(PRINCIPAL_LABEL[kind], change), {
        fields: ['labels'],
        reason: 'reserved_label',
        added: change.added,
        removed: change.removed,
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
