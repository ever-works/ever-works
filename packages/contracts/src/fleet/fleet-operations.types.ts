/**
 * Fleet — long operations on a node (FL-02, CONTRACTS §3.3, spec FR-17/18).
 *
 * A request the node cannot finish within {@link FLEET_LINK_INLINE_REPLY_MS}
 * replies at once with an `operationId`, then reports `operation.progress`
 * and `operation.done` on the link's channel 0. The platform keeps each
 * operation readable at `GET /api/fleet/operations/:id` until
 * {@link FLEET_OPERATION_RETENTION_MS} after it completes, and
 * `DELETE /api/fleet/operations/:id` asks the node to cancel it. An
 * operation is request state, not work: nothing about it survives the
 * process that tracked it unless the relay bus carries it.
 */

import type { FleetLinkError, FleetLinkFamily, FleetLinkOperationProgressValue } from './fleet-link.types.js';

/**
 * CONTRACTS §3.3 (rev 5): `interrupted` = the link or the node went away
 * mid-operation (the node restarted, or never came back within the resume
 * window). It is never reported as `done`, and a late completion from the
 * node does not change it.
 */
export const FLEET_OPERATION_STATES = ['running', 'done', 'failed', 'cancelled', 'interrupted'] as const;

export type FleetOperationState = (typeof FLEET_OPERATION_STATES)[number];

/** States an operation never leaves. */
export const FLEET_OPERATION_TERMINAL_STATES: readonly FleetOperationState[] = [
	'done',
	'failed',
	'cancelled',
	'interrupted'
];

export function isFleetOperationTerminal(state: FleetOperationState): boolean {
	return (FLEET_OPERATION_TERMINAL_STATES as readonly string[]).includes(state);
}

/** `GET /api/fleet/operations/:id`. */
export interface FleetOperationView {
	id: string;
	nodeId: string;
	family: FleetLinkFamily;
	/** The request that started it (`docker.image.pull`, …). */
	verb: string;
	state: FleetOperationState;
	progress: FleetLinkOperationProgressValue | null;
	/** Present once `done`. */
	result?: unknown;
	/** Present once `failed`, `cancelled` (code `operation_failed`, the node's hint) or `interrupted` (code `unreachable`). */
	error?: FleetLinkError;
	startedAt: string;
	endedAt: string | null;
	/** True once someone asked to cancel it and the node has not confirmed yet. */
	cancelRequested: boolean;
}

/** `DELETE /api/fleet/operations/:id`. */
export interface FleetOperationCancelResult {
	operation: FleetOperationView;
	/** False when the operation had already ended; nothing was sent to the node. */
	sent: boolean;
}
