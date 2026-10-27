/**
 * FL-19 T-19 (CONTRACTS §2.3, spec FR-10) — the one way a fleet audit row says
 * who asked: `user:<id>` | `agent:<id>` | `schedule:<commandId>` |
 * `system:<job>`, and the Decision id when an approval ran it. Family services
 * put it in `RecordFleetNodeAuditInput.extra` (the audit `details` are free
 * form; the key `requestedBy` contains no redaction keyword, so it survives
 * `redactAuditDetails`).
 *
 * A leaf: no imports.
 */

export type FleetRequester =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string }
    | { kind: 'schedule'; commandId: string }
    | { kind: 'system'; job: string };

/** `agent:<id>` for an Agent actor, `user:<id>` otherwise (the family services' actor shape). */
export function fleetRequestedByActor(actor: { userId: string; agentId?: string | null }): string {
    return actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`;
}

export function fleetRequestedBy(requester: FleetRequester): string {
    switch (requester.kind) {
        case 'user':
            return `user:${requester.userId}`;
        case 'agent':
            return `agent:${requester.agentId}`;
        case 'schedule':
            return `schedule:${requester.commandId}`;
        case 'system':
            return `system:${requester.job}`;
    }
}

/** The audit `extra` fragment: `{ requestedBy }`, plus `decisionId` when a Decision ran it. */
export function fleetRequestedByExtra(
    requester: FleetRequester | { userId: string; agentId?: string | null },
    decisionId?: string | null,
): { requestedBy: string; decisionId?: string } {
    const requestedBy =
        'kind' in requester ? fleetRequestedBy(requester) : fleetRequestedByActor(requester);
    return decisionId ? { requestedBy, decisionId } : { requestedBy };
}

/** Read a `requestedBy` value back: its kind and id, or null when it is not one. */
export function parseFleetRequestedBy(
    value: unknown,
): { kind: FleetRequester['kind']; id: string } | null {
    if (typeof value !== 'string') return null;
    const match = /^(user|agent|schedule|system):(.+)$/.exec(value);
    if (!match) return null;
    return { kind: match[1] as FleetRequester['kind'], id: match[2] };
}
