/**
 * Load report — the computed answer to "how much of this reaches the agent".
 *
 * A read model, not a stored row: it is measured from the same segment maths
 * the run's prompt assembly applies, so the meter and the run cannot
 * disagree. Only the wire shape lives here.
 */

/** `under` below 90 % of budget, `near` from 90 % to 100 %, `over` above 100 %. */
export const CONTEXT_SEGMENT_STATES = ['under', 'near', 'over'] as const;
export type ContextSegmentState = (typeof CONTEXT_SEGMENT_STATES)[number];

/** Share of a budget at which a segment stops being `under`. */
export const CONTEXT_SEGMENT_NEAR_RATIO = 0.9;

/** Classify a segment's usage against its budget. */
export function contextSegmentState(usedTokens: number, capTokens: number): ContextSegmentState {
	if (capTokens <= 0) return usedTokens > 0 ? 'over' : 'under';
	if (usedTokens > capTokens) return 'over';
	if (usedTokens >= capTokens * CONTEXT_SEGMENT_NEAR_RATIO) return 'near';
	return 'under';
}

/** One segment of a run's instructions. */
export interface ContextSegmentReport {
	name: string;
	label: string;
	capTokens: number;
	usedTokens: number;
	includedTokens: number;
	skippedChars: number;
	skippedRange: { startChar: number; endChar: number } | null;
	state: ContextSegmentState;
}

/** Every segment a run receives, with totals. */
export interface ContextLoadReport {
	totalTokens: number;
	totalCapTokens: number;
	segments: ContextSegmentReport[];
	measuredAt: string;
}
