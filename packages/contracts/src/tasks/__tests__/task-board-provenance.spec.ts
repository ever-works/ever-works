import { describe, expect, it } from 'vitest';

import {
	orderTaskProvenance,
	TASK_PROVENANCE_PRECEDENCE,
	type TaskProvenanceEntry,
	type TaskProvenanceKind
} from '../task-board-provenance.types.js';

const entry = (kind: TaskProvenanceKind, name: string | null = kind, id: string | null = `${kind}-id`) => ({
	kind,
	id,
	name
});

describe('orderTaskProvenance', () => {
	it('returns all twelve sources in precedence order whatever order they arrive in', () => {
		const shuffled = [...TASK_PROVENANCE_PRECEDENCE].reverse().map((kind) => entry(kind));
		expect(orderTaskProvenance(shuffled).map((e) => e.kind)).toEqual([...TASK_PROVENANCE_PRECEDENCE]);
	});

	it('puts the trigger before the recurring template before the Mission', () => {
		const ordered = orderTaskProvenance([entry('mission'), entry('recurringTemplate'), entry('trigger')]);
		expect(ordered.map((e) => e.kind)).toEqual(['trigger', 'recurringTemplate', 'mission']);
	});

	it('drops an entry whose name could not be resolved instead of rendering its id', () => {
		const ordered = orderTaskProvenance([entry('mission', null), entry('work', 'Docs'), entry('agent', '   ')]);
		expect(ordered).toEqual([{ kind: 'work', id: 'work-id', name: 'Docs' }]);
	});

	it('keeps input order between entries of the same kind', () => {
		const ordered = orderTaskProvenance([entry('agent', 'Second', 'a2'), entry('agent', 'First', 'a1')]);
		expect(ordered.map((e) => e.id)).toEqual(['a2', 'a1']);
	});

	it('ignores an unknown kind rather than ranking it arbitrarily', () => {
		const odd = { kind: 'campaign', id: 'x', name: 'X' } as unknown as TaskProvenanceEntry;
		expect(orderTaskProvenance([odd, entry('goal')]).map((e) => e.kind)).toEqual(['goal']);
	});

	it('returns an empty list for an empty input and does not mutate its input', () => {
		expect(orderTaskProvenance([])).toEqual([]);
		const input = [entry('creator'), entry('trigger')];
		orderTaskProvenance(input);
		expect(input.map((e) => e.kind)).toEqual(['creator', 'trigger']);
	});
});
