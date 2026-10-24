/**
 * My Decisions — a held fleet action (FL-19 P2, spec §5.2, T-15): the pure half.
 *
 * Two platform-written proposal kinds stand for an Agent's act on a computer
 * that waits for a person:
 *
 *  - `fleet-tool-call` (FL-19) — the trust ladder held the call (Ask / Draft);
 *    approving it runs exactly that call; older than 24 h it runs nothing;
 *  - `fleet-machine-action` (FL-09) — the machine said the act could cut it
 *    off (blast radius), or it is a SIGKILL / a container run.
 *
 * This file reads what the card shows out of the payload; the payload is
 * platform-written, but its argument values came from a model, so the card
 * renders every value as text.
 */

export const FLEET_TOOL_CALL_KIND = 'fleet-tool-call';
export const FLEET_MACHINE_ACTION_KIND = 'fleet-machine-action';

/** Spec U12 default: a held fleet call approved after this runs nothing. */
export const FLEET_HELD_CALL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FleetActionDecisionView {
    kind: typeof FLEET_TOOL_CALL_KIND | typeof FLEET_MACHINE_ACTION_KIND;
    /** The AW-24 category id (`machine.admin`) when known. */
    category: string | null;
    /** `ask` | `draft` when the ladder held it. */
    rung: string | null;
    /** CONTRACTS §2.2 class when known. */
    confirmationClass: string | null;
    /** The node-computed warning (FL-09 blast radius), when there is one. */
    sentence: string | null;
    /** Why FL-09 held it (`blast-radius`, `kill`, `destructive`, `run`). */
    reason: string | null;
    /** The tool and the arguments, for the details disclosure. */
    tool: string | null;
    args: Array<[string, string]>;
    /** Milliseconds left before a `fleet-tool-call` approval runs nothing; null when it does not expire. */
    expiresInMs: number | null;
}

export function isFleetActionDecisionPayload(payload: Record<string, unknown> | null | undefined): boolean {
    const kind = payload?.kind;
    return kind === FLEET_TOOL_CALL_KIND || kind === FLEET_MACHINE_ACTION_KIND;
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function argPairs(value: unknown): Array<[string, string]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value as Record<string, unknown>)
        .slice(0, 12)
        .map(([key, item]) => [key, typeof item === 'string' ? item : JSON.stringify(item) ?? ''] as [string, string]);
}

/** What the card shows, or null when the proposal is not a held fleet action. */
export function readFleetActionDecision(
    payload: Record<string, unknown> | null | undefined,
    createdAt: string,
    now: number = Date.now(),
): FleetActionDecisionView | null {
    if (!payload || !isFleetActionDecisionPayload(payload)) return null;
    const kind = payload.kind as FleetActionDecisionView['kind'];
    let expiresInMs: number | null = null;
    if (kind === FLEET_TOOL_CALL_KIND) {
        const raised = Date.parse(text(payload.raisedAt) ?? createdAt);
        expiresInMs = Number.isFinite(raised) ? raised + FLEET_HELD_CALL_MAX_AGE_MS - now : 0;
    }
    return {
        kind,
        category: text(payload.category),
        rung: text(payload.rung),
        confirmationClass: text(payload.confirmationClass),
        sentence: text(payload.sentence),
        reason: text(payload.reason),
        tool: text(payload.tool) ?? text(payload.verb),
        args: argPairs(payload.args),
        expiresInMs,
    };
}

/** "23 h 58 m" — hours and minutes left, never negative. */
export function formatFleetDecisionExpiry(ms: number): { hours: number; minutes: number } {
    const safe = Math.max(0, ms);
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    return { hours, minutes };
}
