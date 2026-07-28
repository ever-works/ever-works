/**
 * Workflow graph model (judgment layer G5).
 *
 * The graph is the declarative half of "run these steps in this order,
 * and pick the next step from what happened". Before this file the only
 * ordering primitive was an implicit `sequential` hop, so a workflow
 * could not say "on failure go here", "only go here when X", "let the
 * model pick", or "feed THAT output into THIS input".
 *
 * Four edge kinds, one input-mapping primitive:
 *
 *   - `sequential`  — the plain happy-path hop (what already existed).
 *   - `on_failure`  — taken only when the source node failed; optionally
 *                     narrowed to specific failure codes.
 *   - `conditional` — taken when a declarative predicate over the run
 *                     scope holds. Never an eval'd expression: a
 *                     `{ path, operator, value }` triple, so a graph
 *                     authored by a model can be persisted and replayed
 *                     without executing attacker-authored code.
 *   - `llm_decide`  — the escape hatch: all `llm_decide` edges leaving a
 *                     node form ONE multiple-choice question; the model
 *                     answers with a stable `choice` token and the
 *                     matching edge wins.
 *
 * `inputMapping` hangs off EVERY edge kind: it is how the destination
 * node's inputs are built from the run scope, so nodes stay reusable
 * instead of hard-coding their predecessors' output shapes.
 *
 * Zero-dependency value types + pure helpers only — the executor lives
 * in `@ever-works/agent/agents` and the persistence (when a graph
 * becomes a stored entity) is a follow-up. Everything here is plain
 * JSON so a graph round-trips through a column, a tool call, or a wire
 * payload untouched.
 */

/** Every edge kind the executor understands. Persisted tokens — never rename. */
export type WorkflowEdgeKind = 'sequential' | 'on_failure' | 'conditional' | 'llm_decide';

/** Canonical list — one source of truth for validators, pins and `@IsIn`. */
export const WORKFLOW_EDGE_KINDS: readonly WorkflowEdgeKind[] = [
	'sequential',
	'on_failure',
	'conditional',
	'llm_decide'
];

export function isWorkflowEdgeKind(value: unknown): value is WorkflowEdgeKind {
	return typeof value === 'string' && (WORKFLOW_EDGE_KINDS as readonly string[]).includes(value);
}

/**
 * Comparison vocabulary for a `conditional` edge. Deliberately small and
 * total — a richer expression language would need a parser, and a parser
 * over model-authored text is exactly the thing this design avoids.
 */
export type WorkflowConditionOperator =
	| 'eq'
	| 'neq'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'exists'
	| 'not_exists'
	| 'truthy'
	| 'falsy'
	| 'contains'
	| 'in';

export const WORKFLOW_CONDITION_OPERATORS: readonly WorkflowConditionOperator[] = [
	'eq',
	'neq',
	'gt',
	'gte',
	'lt',
	'lte',
	'exists',
	'not_exists',
	'truthy',
	'falsy',
	'contains',
	'in'
];

/**
 * One predicate over the run scope.
 *
 * `path` is a dot-path (`nodes.research.output.count`). Numeric segments
 * index arrays (`nodes.research.output.items.0.id`).
 */
export interface WorkflowCondition {
	readonly path: string;
	readonly operator: WorkflowConditionOperator;
	/** Right-hand side. Unused by `exists` / `not_exists` / `truthy` / `falsy`. */
	readonly value?: unknown;
}

/**
 * One destination-input binding. `from` reads the run scope; `fallback`
 * is used when the path resolves to `undefined`. A `required` entry that
 * resolves to nothing is a HARD stop — the executor refuses to run the
 * destination node with a silently missing input.
 */
export interface WorkflowInputMappingEntry {
	/** Key set on the destination node's input object. */
	readonly to: string;
	/** Dot-path into the run scope. Omit to use `fallback` as a literal. */
	readonly from?: string;
	/** Literal used when `from` is absent or resolves to `undefined`. */
	readonly fallback?: unknown;
	/** When true, an unresolvable binding fails the run instead of omitting the key. */
	readonly required?: boolean;
}

export type WorkflowInputMapping = readonly WorkflowInputMappingEntry[];

interface WorkflowEdgeBase {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	/** How the destination node's inputs are built. Omit to pass the source output through. */
	readonly inputMapping?: WorkflowInputMapping;
	/** Human label for graph views + traces. */
	readonly label?: string;
}

/** The plain happy-path hop. At most one per source node (validated). */
export interface WorkflowSequentialEdge extends WorkflowEdgeBase {
	readonly kind: 'sequential';
}

/**
 * Taken only when the source node FAILED. `catch` narrows it to specific
 * failure codes; omit to catch every failure from that node.
 */
export interface WorkflowOnFailureEdge extends WorkflowEdgeBase {
	readonly kind: 'on_failure';
	readonly catch?: readonly string[];
}

/** Taken when `when` holds against the run scope. First match wins, in declaration order. */
export interface WorkflowConditionalEdge extends WorkflowEdgeBase {
	readonly kind: 'conditional';
	readonly when: WorkflowCondition;
}

/**
 * One arm of a model-decided branch. All `llm_decide` edges leaving a
 * node are offered together as the choice set; the edge whose `choice`
 * the decider returns wins.
 *
 * `fallback` marks the arm taken when the decider is unbound or errors —
 * at most one per source node. Without a fallback arm a decider outage
 * fails the run LOUDLY rather than silently picking a branch.
 */
export interface WorkflowLlmDecideEdge extends WorkflowEdgeBase {
	readonly kind: 'llm_decide';
	/** Stable token the decider returns. Unique per source node (validated). */
	readonly choice: string;
	/** What this arm means — handed to the decider as the choice description. */
	readonly choiceDescription?: string;
	readonly fallback?: boolean;
}

export type WorkflowEdge =
	| WorkflowSequentialEdge
	| WorkflowOnFailureEdge
	| WorkflowConditionalEdge
	| WorkflowLlmDecideEdge;

/**
 * One unit of work. `kind` is an opaque key the host's node runner
 * resolves (a pipeline step, an agent run, a tool call) — the graph
 * model deliberately knows nothing about what a node DOES.
 */
export interface WorkflowNode {
	readonly id: string;
	readonly kind: string;
	readonly name?: string;
	readonly config?: Readonly<Record<string, unknown>>;
}

export interface WorkflowGraph {
	readonly id: string;
	readonly name?: string;
	readonly entryNodeId: string;
	readonly nodes: readonly WorkflowNode[];
	readonly edges: readonly WorkflowEdge[];
	/** Loop guard — max node executions. Defaults to {@link WORKFLOW_DEFAULT_MAX_STEPS}. */
	readonly maxSteps?: number;
}

/** Default loop guard. A cyclic graph is legal; an unbounded one is not. */
export const WORKFLOW_DEFAULT_MAX_STEPS = 50;

/** Hard ceiling the executor clamps `maxSteps` to, whatever a graph asks for. */
export const WORKFLOW_MAX_STEPS_CEILING = 500;

/** Keys a dot-path may never traverse — prototype-pollution guard. */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Read a dot-path out of the run scope. Returns `undefined` for anything
 * unreachable — including a path that tries to walk the prototype chain,
 * which is refused outright rather than resolved.
 */
export function resolveWorkflowPath(scope: unknown, path: string): unknown {
	if (typeof path !== 'string' || path.length === 0) return undefined;
	let current: unknown = scope;
	for (const segment of path.split('.')) {
		if (segment.length === 0) return undefined;
		if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== 'object') return undefined;
		if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function looseContains(haystack: unknown, needle: unknown): boolean {
	if (Array.isArray(haystack)) return haystack.some((entry) => entry === needle);
	if (typeof haystack === 'string') return haystack.includes(String(needle));
	return false;
}

function numericCompare(left: unknown, right: unknown, compare: (a: number, b: number) => boolean): boolean {
	const a = typeof left === 'number' ? left : Number(left);
	const b = typeof right === 'number' ? right : Number(right);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	return compare(a, b);
}

/**
 * Evaluate one `conditional` predicate. Total by construction: an
 * unknown operator, an unreachable path or a non-comparable pair is
 * `false`, never a throw — a broken predicate must not crash a run, it
 * must simply not take the edge.
 */
export function evaluateWorkflowCondition(condition: WorkflowCondition, scope: unknown): boolean {
	const actual = resolveWorkflowPath(scope, condition.path);
	switch (condition.operator) {
		case 'exists':
			return actual !== undefined && actual !== null;
		case 'not_exists':
			return actual === undefined || actual === null;
		case 'truthy':
			return Boolean(actual);
		case 'falsy':
			return !actual;
		case 'eq':
			return actual === condition.value;
		case 'neq':
			return actual !== condition.value;
		case 'gt':
			return numericCompare(actual, condition.value, (a, b) => a > b);
		case 'gte':
			return numericCompare(actual, condition.value, (a, b) => a >= b);
		case 'lt':
			return numericCompare(actual, condition.value, (a, b) => a < b);
		case 'lte':
			return numericCompare(actual, condition.value, (a, b) => a <= b);
		case 'contains':
			return looseContains(actual, condition.value);
		case 'in':
			return looseContains(condition.value, actual);
		default:
			return false;
	}
}

/** Outcome of applying an edge's `inputMapping` to the run scope. */
export type WorkflowInputMappingResult =
	| { readonly ok: true; readonly inputs: Record<string, unknown> }
	| { readonly ok: false; readonly missing: readonly string[] };

/**
 * Build the destination node's inputs from the run scope.
 *
 * Absent mapping ⇒ `{ ok: true, inputs: {} }`; the executor treats an
 * unmapped edge as "pass the source output through" so the common case
 * needs no ceremony.
 */
export function applyWorkflowInputMapping(
	mapping: WorkflowInputMapping | undefined,
	scope: unknown
): WorkflowInputMappingResult {
	if (!mapping || mapping.length === 0) return { ok: true, inputs: {} };
	const inputs: Record<string, unknown> = {};
	const missing: string[] = [];
	for (const entry of mapping) {
		if (!entry || typeof entry.to !== 'string' || entry.to.length === 0) continue;
		if (FORBIDDEN_PATH_SEGMENTS.has(entry.to)) continue;
		const resolved = entry.from === undefined ? undefined : resolveWorkflowPath(scope, entry.from);
		const value = resolved === undefined ? entry.fallback : resolved;
		if (value === undefined) {
			if (entry.required) missing.push(entry.to);
			continue;
		}
		inputs[entry.to] = value;
	}
	return missing.length > 0 ? { ok: false, missing } : { ok: true, inputs };
}

export interface WorkflowGraphValidation {
	readonly valid: boolean;
	readonly errors: readonly string[];
}

/**
 * Structural validation. Catches the mistakes that would otherwise be
 * discovered mid-run: dangling references, duplicate ids, an entry node
 * that does not exist, two happy paths out of one node, and colliding
 * or over-supplied `llm_decide` arms.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowGraphValidation {
	const errors: string[] = [];
	if (!graph || typeof graph !== 'object') return { valid: false, errors: ['graph is not an object'] };

	const nodeIds = new Set<string>();
	for (const node of graph.nodes ?? []) {
		if (!node?.id) {
			errors.push('node without an id');
			continue;
		}
		if (nodeIds.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
		nodeIds.add(node.id);
	}

	if (!graph.entryNodeId) errors.push('graph has no entryNodeId');
	else if (!nodeIds.has(graph.entryNodeId)) {
		errors.push(`entryNodeId "${graph.entryNodeId}" is not a node in the graph`);
	}

	const edgeIds = new Set<string>();
	const sequentialBySource = new Map<string, number>();
	const choicesBySource = new Map<string, Set<string>>();
	const fallbacksBySource = new Map<string, number>();

	for (const edge of graph.edges ?? []) {
		if (!edge?.id) {
			errors.push('edge without an id');
			continue;
		}
		if (edgeIds.has(edge.id)) errors.push(`duplicate edge id "${edge.id}"`);
		edgeIds.add(edge.id);
		if (!isWorkflowEdgeKind(edge.kind)) {
			errors.push(`edge "${edge.id}" has unknown kind "${String((edge as { kind?: unknown }).kind)}"`);
			continue;
		}
		if (!nodeIds.has(edge.from)) errors.push(`edge "${edge.id}" leaves unknown node "${edge.from}"`);
		if (!nodeIds.has(edge.to)) errors.push(`edge "${edge.id}" points at unknown node "${edge.to}"`);

		if (edge.kind === 'sequential') {
			const count = (sequentialBySource.get(edge.from) ?? 0) + 1;
			sequentialBySource.set(edge.from, count);
			if (count === 2) {
				errors.push(
					`node "${edge.from}" has more than one sequential edge — use conditional or llm_decide to branch`
				);
			}
		}

		if (edge.kind === 'conditional') {
			if (!edge.when?.path) errors.push(`conditional edge "${edge.id}" has no when.path`);
			else if (!WORKFLOW_CONDITION_OPERATORS.includes(edge.when.operator)) {
				errors.push(`conditional edge "${edge.id}" has unknown operator "${String(edge.when.operator)}"`);
			}
		}

		if (edge.kind === 'llm_decide') {
			if (!edge.choice) errors.push(`llm_decide edge "${edge.id}" has no choice token`);
			else {
				const choices = choicesBySource.get(edge.from) ?? new Set<string>();
				if (choices.has(edge.choice)) {
					errors.push(`node "${edge.from}" has two llm_decide edges with choice "${edge.choice}"`);
				}
				choices.add(edge.choice);
				choicesBySource.set(edge.from, choices);
			}
			if (edge.fallback) {
				const count = (fallbacksBySource.get(edge.from) ?? 0) + 1;
				fallbacksBySource.set(edge.from, count);
				if (count === 2) {
					errors.push(`node "${edge.from}" has more than one llm_decide fallback arm`);
				}
			}
		}

		for (const binding of edge.inputMapping ?? []) {
			if (!binding?.to) errors.push(`edge "${edge.id}" has an input mapping without a "to" key`);
			else if (binding.from === undefined && binding.fallback === undefined) {
				errors.push(`edge "${edge.id}" mapping "${binding.to}" has neither "from" nor "fallback"`);
			}
		}
	}

	if (graph.maxSteps !== undefined && (!Number.isInteger(graph.maxSteps) || graph.maxSteps <= 0)) {
		errors.push('maxSteps must be a positive integer when set');
	}

	return { valid: errors.length === 0, errors };
}

/** Every edge leaving `nodeId`, in declaration order, optionally narrowed by kind. */
export function outgoingWorkflowEdges<TKind extends WorkflowEdgeKind>(
	graph: WorkflowGraph,
	nodeId: string,
	kind?: TKind
): readonly Extract<WorkflowEdge, { kind: TKind }>[] {
	return (graph.edges ?? []).filter(
		(edge): edge is Extract<WorkflowEdge, { kind: TKind }> =>
			edge.from === nodeId && (kind === undefined || edge.kind === kind)
	);
}

/**
 * Does this `on_failure` edge catch that failure code? An edge without
 * `catch` is the catch-all; an empty `catch` array catches nothing (the
 * author asked for a narrowing and supplied none).
 */
export function onFailureEdgeCatches(edge: WorkflowOnFailureEdge, failureCode?: string): boolean {
	if (edge.catch === undefined) return true;
	if (failureCode === undefined) return false;
	return edge.catch.includes(failureCode);
}
