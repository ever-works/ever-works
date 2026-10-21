import {
    fleetToolEntry,
    isFleetHeldActionStale,
    type ActionCategory,
    type FleetConfirmArgs,
    type FleetConfirmationClass,
    type FleetToolCatalogueEntry,
} from '@ever-works/contracts';

/**
 * FL-19 P2 (spec S3, FR-7, U12; CONTRACTS R-33) — a fleet act the trust ladder
 * HOLDS becomes a Decision the owner can approve.
 *
 * The AW-24 safety gate answers `held` for a call whose category sits at the
 * Ask or Draft rung, before the tool runs. For a catalogued, state-changing
 * fleet tool the run loop then files one Agent Action Approval Queue proposal
 * (`actionType: 'other'`, the platform-written `payload.kind:
 * 'fleet-tool-call'`, `humanDecisionRequired`) through {@link FleetHeldCallFiler},
 * and the tool answers `{ held: true, decisionId }`. A person's approval re-runs
 * exactly that call — same Agent, same arguments, through the same tool and so
 * the same family chain (audience, consent, the machine, the audit row as
 * `agent:<id>`) — with the confirmation the person just gave
 * (`fleetHeldCallConfirmFields`). An approval more than 24 h after the call was
 * held runs nothing (spec U12 default): the owner is told the Agent must ask
 * again.
 *
 * A LEAF file (contracts only): the run loop imports it without pulling the
 * fleet module's runtime graph.
 */

export const FLEET_TOOL_CALL_PROPOSAL_KIND = 'fleet-tool-call' as const;

/** Most bytes of model-supplied arguments a held call keeps (the proposal row is a TEXT column). */
export const FLEET_HELD_CALL_MAX_ARGS_BYTES = 8_000;

/** Fields the APPROVER supplies — never carried over from the model's call (except a typed name). */
const CONFIRMATION_FIELDS = ['confirm', 'acknowledgeBlastRadius', 'wait'] as const;

/** What a held call stores so a person's approval runs exactly it. Platform-written. */
export interface FleetHeldToolCallPayload {
    kind: typeof FLEET_TOOL_CALL_PROPOSAL_KIND;
    /** The catalogued tool name (`fleet_services_action`). */
    tool: string;
    /** The model's arguments, without the confirmation fields. */
    args: Record<string, unknown>;
    agentId: string;
    runId: string | null;
    /** ISO instant the call was held — what the 24 h staleness rule reads. */
    raisedAt: string;
    category: ActionCategory | null;
    /** The rung that held it. */
    rung: 'ask' | 'draft' | null;
    confirmationClass: FleetConfirmationClass | null;
    /** One sentence for the Decision card ("Nina wants to restart nginx on build-01"). */
    summary: string;
}

export interface FleetHeldCallInput {
    userId: string;
    agentId: string;
    agentName?: string | null;
    runId: string | null;
    tool: string;
    args: unknown;
    category: string | null;
    rung: string | null;
}

/** The port the run loop files a held fleet call through (bound by the API). */
export interface FleetHeldCallFiler {
    /** Files (or finds the pending) Decision; null when this call is not a held fleet act. */
    file(input: FleetHeldCallInput): Promise<{ decisionId: string } | null>;
}

export const FLEET_HELD_CALL_FILER = 'FLEET_HELD_CALL_FILER' as const;

/** The model's arguments as a held call keeps them, or null when they cannot be kept. */
export function sanitizeFleetHeldArgs(args: unknown): Record<string, unknown> | null {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args)) return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if ((CONFIRMATION_FIELDS as readonly string[]).includes(key)) continue;
        out[key] = value;
    }
    let size: number;
    try {
        size = JSON.stringify(out).length;
    } catch {
        return null;
    }
    return size <= FLEET_HELD_CALL_MAX_ARGS_BYTES ? out : null;
}

/** A state-changing catalogued fleet tool — the only calls a hold turns into a Decision. */
export function heldFleetToolEntry(name: string): FleetToolCatalogueEntry | null {
    const entry = fleetToolEntry(name);
    if (!entry || entry.readOnly) return null;
    return entry;
}

function argText(args: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 80);
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
}

/** "Nina wants to restart nginx" — the verb and its object, from the arguments a person recognises. */
export function fleetHeldCallSummary(
    agentName: string | null | undefined,
    entry: Pick<FleetToolCatalogueEntry, 'name' | 'family' | 'verb'>,
    args: Record<string, unknown>,
): string {
    const who = agentName && agentName.trim().length > 0 ? agentName.trim() : 'An Agent';
    const action = argText(args, 'action', 'signal');
    const object = argText(args, 'name', 'service', 'container', 'project', 'image', 'port', 'pid', 'path', 'title');
    const verb = entry.verb ? entry.verb.replace(/_/g, ' ') : entry.family;
    const what = [action, object].filter(Boolean).join(' ');
    const phrase = what ? `${what} (${entry.family} ${verb})` : `${entry.family} ${verb}`;
    return `${who} wants to ${phrase}`.slice(0, 200);
}

/** The payload for one held call, or null when it is not a held fleet act or its arguments cannot be kept. */
export function buildFleetHeldCallPayload(
    input: FleetHeldCallInput,
    now: Date = new Date(),
): FleetHeldToolCallPayload | null {
    const entry = heldFleetToolEntry(input.tool);
    if (!entry) return null;
    const args = sanitizeFleetHeldArgs(input.args);
    if (!args) return null;
    const rung = input.rung === 'ask' || input.rung === 'draft' ? input.rung : null;
    return {
        kind: FLEET_TOOL_CALL_PROPOSAL_KIND,
        tool: entry.name,
        args,
        agentId: input.agentId,
        runId: input.runId,
        raisedAt: now.toISOString(),
        category: (input.category as ActionCategory | null) ?? entry.category ?? null,
        rung,
        confirmationClass: entry.confirmationClass ?? null,
        summary: fleetHeldCallSummary(input.agentName, entry, args),
    };
}

/** A platform-written held-call payload, read back off an approved proposal. */
export function isFleetHeldCallPayload(value: unknown): value is FleetHeldToolCallPayload {
    if (!value || typeof value !== 'object') return false;
    const raw = value as Record<string, unknown>;
    return (
        raw.kind === FLEET_TOOL_CALL_PROPOSAL_KIND &&
        typeof raw.tool === 'string' &&
        typeof raw.agentId === 'string' &&
        typeof raw.raisedAt === 'string' &&
        Boolean(raw.args) &&
        typeof raw.args === 'object' &&
        !Array.isArray(raw.args)
    );
}

/**
 * The confirmation a person's approval stands for (CONTRACTS §2.2): `confirm`
 * and — the approval being the human reading of the warning —
 * `acknowledgeBlastRadius`. A `confirm-destructive` call keeps the name the
 * Agent typed (`confirmName` in its arguments); without one the family answers
 * `confirmation_required` and nothing is deleted.
 */
export function fleetHeldCallConfirmFields(payload: Pick<FleetHeldToolCallPayload, 'args'>): FleetConfirmArgs {
    const out: FleetConfirmArgs = { confirm: true, acknowledgeBlastRadius: true };
    if (typeof payload.args.confirmName === 'string') out.confirmName = payload.args.confirmName;
    return out;
}

/** Spec U12 — approved more than 24 h after it was held: nothing runs. */
export function isFleetHeldCallStale(
    payload: Pick<FleetHeldToolCallPayload, 'raisedAt'>,
    now: Date = new Date(),
): boolean {
    return isFleetHeldActionStale(payload.raisedAt, now);
}

/**
 * The de-duplication subject: one Decision per (Agent, tool, arguments, hour held) — a retry
 * loop inside the hour finds the pending one; the same act asked again later is a new Decision
 * (the queue refuses a second proposal about a decided subject, so the hour is part of it).
 */
export function fleetHeldCallSubjectKey(
    payload: Pick<FleetHeldToolCallPayload, 'agentId' | 'tool' | 'args' | 'raisedAt'>,
): string {
    const text = JSON.stringify([payload.agentId, payload.tool, payload.args, payload.raisedAt.slice(0, 13)]);
    // FNV-1a — a stable, dependency-free digest; collisions only merge two proposals' de-duplication.
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fleet-tool-call:${payload.tool}:${hash.toString(16).padStart(8, '0')}`;
}
