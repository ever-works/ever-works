/**
 * Task board — provenance ordering.
 *
 * A card names where its work came from (origin) and what it belongs to
 * (owner). When more than two sources apply, the card shows the two with
 * the highest precedence and lists the rest in its menu. Precedence runs
 * from the most specific origin to the most generic:
 *
 *   trigger → recurring template → scheduled → mission → idea → work →
 *   team → goal → agent → raised by an Agent → delegated → creator
 *
 * The server returns provenance already ordered by this rule, so the client
 * renders the first two without knowing it.
 */

export type TaskProvenanceKind =
	| 'trigger'
	| 'recurringTemplate'
	| 'scheduled'
	| 'mission'
	| 'idea'
	| 'work'
	| 'team'
	| 'goal'
	| 'agent'
	| 'raisedByAgent'
	| 'delegated'
	| 'creator';

export const TASK_PROVENANCE_PRECEDENCE: readonly TaskProvenanceKind[] = [
	'trigger',
	'recurringTemplate',
	'scheduled',
	'mission',
	'idea',
	'work',
	'team',
	'goal',
	'agent',
	'raisedByAgent',
	'delegated',
	'creator'
];

export interface TaskProvenanceEntry {
	kind: TaskProvenanceKind;
	/** Id of the thing named, when it is addressable. */
	id: string | null;
	/**
	 * Display name. `null` means the target no longer exists or is not
	 * visible to the caller — such an entry is dropped, never rendered as a
	 * raw id or a broken link.
	 */
	name: string | null;
}

/** How many provenance entries a card shows before the rest go to its menu. */
export const TASK_PROVENANCE_VISIBLE_CHIPS = 2;

/**
 * Drop unresolvable entries, then sort by precedence. Stable: entries of the
 * same kind keep their input order.
 */
export function orderTaskProvenance(entries: readonly TaskProvenanceEntry[]): TaskProvenanceEntry[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => typeof entry.name === 'string' && entry.name.trim().length > 0)
		.filter(({ entry }) => TASK_PROVENANCE_PRECEDENCE.includes(entry.kind))
		.sort((a, b) => {
			const rank =
				TASK_PROVENANCE_PRECEDENCE.indexOf(a.entry.kind) - TASK_PROVENANCE_PRECEDENCE.indexOf(b.entry.kind);
			return rank !== 0 ? rank : a.index - b.index;
		})
		.map(({ entry }) => entry);
}
