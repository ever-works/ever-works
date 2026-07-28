import { describe, expect, it } from 'vitest';
import {
	applyWorkflowInputMapping,
	evaluateWorkflowCondition,
	onFailureEdgeCatches,
	outgoingWorkflowEdges,
	resolveWorkflowPath,
	validateWorkflowGraph,
	WORKFLOW_EDGE_KINDS,
	isWorkflowEdgeKind,
	type WorkflowGraph
} from '../workflow-graph.types.js';

const scope = {
	input: { seed: 3 },
	nodes: {
		research: { ok: true, output: { count: 5, items: ['a', 'b'], label: 'done' } },
		draft: { ok: false, output: null, failureCode: 'lint-red' }
	}
};

describe('WORKFLOW_EDGE_KINDS', () => {
	it('carries exactly the four edge kinds the executor implements', () => {
		expect([...WORKFLOW_EDGE_KINDS].sort()).toEqual(['conditional', 'llm_decide', 'on_failure', 'sequential']);
	});

	it('narrows unknown tokens', () => {
		expect(isWorkflowEdgeKind('on_failure')).toBe(true);
		expect(isWorkflowEdgeKind('maybe')).toBe(false);
		expect(isWorkflowEdgeKind(undefined)).toBe(false);
	});
});

describe('resolveWorkflowPath', () => {
	it('walks nested objects and array indices', () => {
		expect(resolveWorkflowPath(scope, 'nodes.research.output.count')).toBe(5);
		expect(resolveWorkflowPath(scope, 'nodes.research.output.items.1')).toBe('b');
	});

	it('returns undefined for anything unreachable', () => {
		expect(resolveWorkflowPath(scope, 'nodes.missing.output')).toBeUndefined();
		expect(resolveWorkflowPath(scope, 'nodes.research.output.items.9')).toBeUndefined();
		expect(resolveWorkflowPath(scope, '')).toBeUndefined();
		expect(resolveWorkflowPath(scope, 'nodes..output')).toBeUndefined();
	});

	it('refuses to walk the prototype chain', () => {
		expect(resolveWorkflowPath(scope, '__proto__.polluted')).toBeUndefined();
		expect(resolveWorkflowPath(scope, 'nodes.constructor.name')).toBeUndefined();
		expect(resolveWorkflowPath({ a: 1 }, 'toString')).toBeUndefined();
	});
});

describe('evaluateWorkflowCondition', () => {
	it.each([
		['eq', 'nodes.research.output.count', 5, true],
		['eq', 'nodes.research.output.count', 4, false],
		['neq', 'nodes.research.output.count', 4, true],
		['gt', 'nodes.research.output.count', 4, true],
		['gte', 'nodes.research.output.count', 5, true],
		['lt', 'nodes.research.output.count', 6, true],
		['lte', 'nodes.research.output.count', 5, true],
		['contains', 'nodes.research.output.items', 'a', true],
		['contains', 'nodes.research.output.items', 'z', false],
		['in', 'nodes.research.output.label', ['done', 'pending'], true]
	] as const)('%s over %s', (operator, path, value, expected) => {
		expect(evaluateWorkflowCondition({ path, operator, value }, scope)).toBe(expected);
	});

	it('handles the value-free operators', () => {
		expect(evaluateWorkflowCondition({ path: 'nodes.research', operator: 'exists' }, scope)).toBe(true);
		expect(evaluateWorkflowCondition({ path: 'nodes.nope', operator: 'not_exists' }, scope)).toBe(true);
		expect(evaluateWorkflowCondition({ path: 'nodes.research.ok', operator: 'truthy' }, scope)).toBe(true);
		expect(evaluateWorkflowCondition({ path: 'nodes.draft.ok', operator: 'falsy' }, scope)).toBe(true);
	});

	it('is false rather than throwing for uncomparable pairs and unknown operators', () => {
		expect(
			evaluateWorkflowCondition({ path: 'nodes.research.output.label', operator: 'gt', value: 2 }, scope)
		).toBe(false);
		expect(
			evaluateWorkflowCondition({ path: 'nodes.research', operator: 'nonsense' as never, value: 1 }, scope)
		).toBe(false);
	});
});

describe('applyWorkflowInputMapping', () => {
	it('is a no-op for an absent or empty mapping', () => {
		expect(applyWorkflowInputMapping(undefined, scope)).toEqual({ ok: true, inputs: {} });
		expect(applyWorkflowInputMapping([], scope)).toEqual({ ok: true, inputs: {} });
	});

	it('binds scope paths onto destination input keys', () => {
		const result = applyWorkflowInputMapping(
			[
				{ to: 'count', from: 'nodes.research.output.count' },
				{ to: 'seed', from: 'input.seed' }
			],
			scope
		);
		expect(result).toEqual({ ok: true, inputs: { count: 5, seed: 3 } });
	});

	it('falls back to the literal when the path misses', () => {
		const result = applyWorkflowInputMapping([{ to: 'count', from: 'nodes.nope.count', fallback: 0 }], scope);
		expect(result).toEqual({ ok: true, inputs: { count: 0 } });
	});

	it('omits an optional unresolvable binding but FAILS a required one', () => {
		expect(applyWorkflowInputMapping([{ to: 'x', from: 'nodes.nope.x' }], scope)).toEqual({
			ok: true,
			inputs: {}
		});
		expect(applyWorkflowInputMapping([{ to: 'x', from: 'nodes.nope.x', required: true }], scope)).toEqual({
			ok: false,
			missing: ['x']
		});
	});

	it('never writes a prototype-polluting destination key', () => {
		const result = applyWorkflowInputMapping([{ to: '__proto__', fallback: { polluted: true } }], scope);
		expect(result).toEqual({ ok: true, inputs: {} });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
	id: 'g1',
	entryNodeId: 'a',
	nodes: [
		{ id: 'a', kind: 'noop' },
		{ id: 'b', kind: 'noop' },
		{ id: 'c', kind: 'noop' }
	],
	edges: [{ id: 'e1', kind: 'sequential', from: 'a', to: 'b' }],
	...over
});

describe('validateWorkflowGraph', () => {
	it('accepts a well-formed graph', () => {
		expect(validateWorkflowGraph(graph())).toEqual({ valid: true, errors: [] });
	});

	it('rejects an entry node that is not in the graph', () => {
		const result = validateWorkflowGraph(graph({ entryNodeId: 'zzz' }));
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toContain('entryNodeId "zzz"');
	});

	it('rejects dangling edge endpoints and duplicate ids', () => {
		const result = validateWorkflowGraph(
			graph({
				nodes: [
					{ id: 'a', kind: 'noop' },
					{ id: 'a', kind: 'noop' }
				],
				edges: [{ id: 'e1', kind: 'sequential', from: 'a', to: 'ghost' }]
			})
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toContain('duplicate node id "a"');
		expect(result.errors.join(' ')).toContain('unknown node "ghost"');
	});

	it('rejects two sequential edges out of one node — branching needs an explicit kind', () => {
		const result = validateWorkflowGraph(
			graph({
				edges: [
					{ id: 'e1', kind: 'sequential', from: 'a', to: 'b' },
					{ id: 'e2', kind: 'sequential', from: 'a', to: 'c' }
				]
			})
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toContain('more than one sequential edge');
	});

	it('rejects colliding llm_decide choices and a second fallback arm', () => {
		const result = validateWorkflowGraph(
			graph({
				edges: [
					{ id: 'e1', kind: 'llm_decide', from: 'a', to: 'b', choice: 'x', fallback: true },
					{ id: 'e2', kind: 'llm_decide', from: 'a', to: 'c', choice: 'x', fallback: true }
				]
			})
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toContain('two llm_decide edges with choice "x"');
		expect(result.errors.join(' ')).toContain('more than one llm_decide fallback arm');
	});

	it('rejects a conditional edge with an unknown operator and a mapping with no source', () => {
		const result = validateWorkflowGraph(
			graph({
				edges: [
					{
						id: 'e1',
						kind: 'conditional',
						from: 'a',
						to: 'b',
						when: { path: 'x', operator: 'wat' as never },
						inputMapping: [{ to: 'y' }]
					}
				]
			})
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toContain('unknown operator');
		expect(result.errors.join(' ')).toContain('neither "from" nor "fallback"');
	});
});

describe('outgoingWorkflowEdges + onFailureEdgeCatches', () => {
	it('filters by source node and kind, preserving declaration order', () => {
		const g = graph({
			edges: [
				{ id: 'e1', kind: 'conditional', from: 'a', to: 'b', when: { path: 'x', operator: 'truthy' } },
				{ id: 'e2', kind: 'sequential', from: 'a', to: 'c' },
				{ id: 'e3', kind: 'sequential', from: 'b', to: 'c' }
			]
		});
		expect(outgoingWorkflowEdges(g, 'a').map((edge) => edge.id)).toEqual(['e1', 'e2']);
		expect(outgoingWorkflowEdges(g, 'a', 'sequential').map((edge) => edge.id)).toEqual(['e2']);
	});

	it('treats an absent catch list as the catch-all and an empty one as catching nothing', () => {
		const base = { id: 'e', kind: 'on_failure', from: 'a', to: 'b' } as const;
		expect(onFailureEdgeCatches({ ...base }, 'lint-red')).toBe(true);
		expect(onFailureEdgeCatches({ ...base }, undefined)).toBe(true);
		expect(onFailureEdgeCatches({ ...base, catch: [] }, 'lint-red')).toBe(false);
		expect(onFailureEdgeCatches({ ...base, catch: ['lint-red'] }, 'lint-red')).toBe(true);
		expect(onFailureEdgeCatches({ ...base, catch: ['lint-red'] }, 'other')).toBe(false);
	});
});
