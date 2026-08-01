import {
    WORKFLOW_DEFAULT_MAX_STEPS,
    validateWorkflowGraph,
    type WorkflowGraph,
    type WorkflowNode,
} from '@ever-works/contracts';
import type { AgentToolDescriptor } from './agent-tool.service';
// The run result/status types belong to the executor, not to contracts —
// contracts owns the GRAPH model, the executor owns what running one
// produces.
import type {
    WorkflowGraphExecutorService,
    WorkflowRunResult,
} from './workflow-graph-executor.service';

/**
 * Workflow graphs as a chat tool (judgment layer G5).
 *
 * `WorkflowGraphExecutorService` has been complete, unit-tested and
 * DI-wired for a while, and its node runner is bound in production — but
 * nothing in the platform ever called `execute()`. A graph could be
 * validated and could in principle run, and no surface could start one.
 * This is that surface.
 *
 * ## The graph is UNTRUSTED input
 *
 * A model authors the graph, and the bound node runner turns
 * `agent.delegate` nodes into real child Tasks that spend real budget and
 * `ai.ask` nodes into real model calls. `validateWorkflowGraph` checks
 * STRUCTURE (reachable entry, unique ids, well-formed edges) and nothing
 * about size or cost — it will happily pass a 400-node graph made
 * entirely of delegations.
 *
 * So everything cost-shaped is clamped here, before `execute()` is
 * reached, by {@link admitModelAuthoredGraph}. The clamps are deliberately
 * REWRITES where a rewrite is safe (`maxSteps` is lowered, not rejected)
 * and refusals where it is not (an unknown node kind is a typo or a
 * probe, and guessing at intent would be worse than saying no).
 *
 * ## Identity is never taken from the model
 *
 * `WorkflowNodeRunnerService` reads `userId`, `workId`, `organizationId`,
 * `agentId` and `delegationDepth` out of the ambient run context to
 * decide what a node may touch. If the model could supply that object it
 * would be choosing its own authorization, so the context is built HERE
 * from the Agent row and the model's `context` (if it sends one) is
 * discarded rather than merged — a merge would let an unknown key win.
 */

/** Node kinds the bound runner actually implements. */
export const WORKFLOW_TOOL_ALLOWED_NODE_KINDS: readonly string[] = [
    'noop',
    'ai.ask',
    'kb.search',
    'agent.delegate',
];

/** Ceiling on graph size for a model-authored graph. */
export const WORKFLOW_TOOL_MAX_NODES = 40;
export const WORKFLOW_TOOL_MAX_EDGES = 80;
/**
 * Ceiling on delegation nodes. Each one spawns a child Task and a real
 * agent run, so this is the single most expensive thing a graph can
 * contain — an order of magnitude tighter than the node cap.
 */
export const WORKFLOW_TOOL_MAX_DELEGATE_NODES = 4;
/** Ceiling on node executions, well below the executor's own 500. */
export const WORKFLOW_TOOL_MAX_STEPS = 25;

export type WorkflowAdmission = { ok: true; graph: WorkflowGraph } | { ok: false; reason: string };

/**
 * Is `nodeId` reachable from itself by following edges?
 *
 * Plain BFS over the edge list rather than a general cycle detector: the
 * question is only ever asked about one specific node, and self-reachable
 * is exactly the property that lets a node execute more than once.
 */
function isOnCycle(graph: WorkflowGraph, nodeId: string): boolean {
    const outgoing = new Map<string, string[]>();
    for (const edge of graph.edges) {
        if (!edge || typeof edge !== 'object') continue;
        const from = (edge as { from?: unknown }).from;
        const to = (edge as { to?: unknown }).to;
        if (typeof from !== 'string' || typeof to !== 'string') continue;
        const list = outgoing.get(from);
        if (list) list.push(to);
        else outgoing.set(from, [to]);
    }

    const seen = new Set<string>();
    const queue = [...(outgoing.get(nodeId) ?? [])];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        if (current === nodeId) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of outgoing.get(current) ?? []) queue.push(next);
    }
    return false;
}

/**
 * Admit a model-authored graph, or refuse it with a reason the model can
 * act on.
 *
 * Pure and exported so the rules can be tested without a Nest graph, and
 * so a future non-chat entry point reuses the same clamps rather than
 * inventing weaker ones.
 */
export function admitModelAuthoredGraph(raw: unknown): WorkflowAdmission {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, reason: 'graph must be an object' };
    }
    const graph = raw as WorkflowGraph;

    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        return { ok: false, reason: 'graph.nodes and graph.edges must be arrays' };
    }
    if (graph.nodes.length === 0) {
        return { ok: false, reason: 'graph must contain at least one node' };
    }
    if (graph.nodes.length > WORKFLOW_TOOL_MAX_NODES) {
        return {
            ok: false,
            reason: `graph has ${graph.nodes.length} nodes; the limit is ${WORKFLOW_TOOL_MAX_NODES}`,
        };
    }
    if (graph.edges.length > WORKFLOW_TOOL_MAX_EDGES) {
        return {
            ok: false,
            reason: `graph has ${graph.edges.length} edges; the limit is ${WORKFLOW_TOOL_MAX_EDGES}`,
        };
    }

    // Shape check FIRST, and by index rather than with `.find()`.
    //
    // `.find()` would return the offending entry, and a `null` entry is
    // itself falsy — so an `if (found)` guard silently passes it through
    // and the next `.filter(n => n.kind)` throws a TypeError out of this
    // function, past the caller's try/catch, and out of the tool loop.
    for (let i = 0; i < graph.nodes.length; i += 1) {
        const node = graph.nodes[i];
        if (!node || typeof node !== 'object') {
            return { ok: false, reason: `graph.nodes[${i}] is not an object` };
        }
        if (typeof node.id !== 'string' || node.id.length === 0) {
            return { ok: false, reason: `graph.nodes[${i}] is missing a string id` };
        }
        if (!WORKFLOW_TOOL_ALLOWED_NODE_KINDS.includes(node.kind)) {
            // Refused, not skipped. A graph that silently drops a node it
            // does not understand would report success for work it never
            // did.
            return {
                ok: false,
                reason:
                    `node '${node.id}' has unsupported kind '${node.kind}'; ` +
                    `supported kinds are ${WORKFLOW_TOOL_ALLOWED_NODE_KINDS.join(', ')}`,
            };
        }
    }

    const delegateNodes = graph.nodes.filter(
        (node: WorkflowNode) => node.kind === 'agent.delegate',
    );
    if (delegateNodes.length > WORKFLOW_TOOL_MAX_DELEGATE_NODES) {
        return {
            ok: false,
            reason:
                `graph has ${delegateNodes.length} agent.delegate nodes; the limit is ` +
                `${WORKFLOW_TOOL_MAX_DELEGATE_NODES} because each one spawns a child agent run`,
        };
    }

    // The delegate cap counts NODES; the executor counts EXECUTIONS. A
    // delegate node on a cycle is therefore not bounded by the cap at all
    // — it re-runs once per loop iteration, so a single node could spawn
    // up to `maxSteps` child agent runs instead of one. Cycles stay legal
    // everywhere else (a retry loop is a cycle, and that is the point);
    // they are only refused when a delegation sits inside one.
    const cyclic = delegateNodes.find((node) => isOnCycle(graph, node.id));
    if (cyclic) {
        return {
            ok: false,
            reason:
                `agent.delegate node '${cyclic.id}' is on a cycle; each pass would spawn ` +
                'another child agent run, so the delegation cap could not bound it',
        };
    }

    // `maxSteps` is REWRITTEN rather than refused: a cycle is a legitimate
    // retry loop, and the only thing that actually needs bounding is how
    // many times a node may run. Rewriting keeps a well-meant graph
    // working instead of failing it on a number it had no way to guess.
    const requested = Number.isInteger(graph.maxSteps)
        ? (graph.maxSteps as number)
        : WORKFLOW_DEFAULT_MAX_STEPS;
    const maxSteps = Math.min(Math.max(requested, 1), WORKFLOW_TOOL_MAX_STEPS);

    const admitted: WorkflowGraph = { ...graph, maxSteps };

    // Structural validation LAST, on the admitted graph, so the model gets
    // the size/kind refusals (which it can fix) before the structural ones.
    const validation = validateWorkflowGraph(admitted);
    if (!validation.valid) {
        return { ok: false, reason: `invalid graph: ${validation.errors.join('; ')}` };
    }

    return { ok: true, graph: admitted };
}

export interface RunWorkflowGraphArgs {
    graph?: unknown;
    input?: unknown;
}

/**
 * What the model gets back. Deliberately a PROJECTION of
 * `WorkflowRunResult`: the raw result carries every node's full output,
 * which for a `kb.search` node is entire documents and would blow the
 * context window on a single tool call.
 */
export interface RunWorkflowGraphResult {
    status: WorkflowRunResult['status'];
    runId: string;
    visited: readonly string[];
    failureCode?: string;
    errors?: string[];
    output: unknown;
}

/**
 * The scope a delegating node is narrowed against.
 *
 * Mirrors `SubAgentScope` structurally without importing it — this module
 * only ever hands the object to the run context, and the node runner is
 * what passes it to the delegation contract.
 */
export interface WorkflowParentScope {
    allowedTools: string[];
    workId: string | null;
    organizationId: string | null;
    networkAccess: boolean;
}

/**
 * Build the parent scope from what the agent genuinely holds.
 *
 * `allowedTools` is the agent's REAL resolved tool list, so a delegate
 * node cannot hand its child a tool the parent never had. The wildcard
 * `['*']` is used only when the tool list cannot be resolved — it means
 * "everything the parent had", which is the honest answer when we do not
 * know the enumeration, and it still pins `workId` / `organizationId` /
 * `networkAccess`. Inventing a narrow list we could not verify would
 * refuse legitimate delegations for the wrong reason.
 *
 * Note the tool list is the pre-grant-filter set: an operator tool-grant
 * that refuses a tool for the parent is not subtracted here. That is a
 * deliberate over-approximation of ONE dimension — the child's own grants
 * are resolved independently at its run time, so nothing is actually
 * widened by it.
 */
function buildParentScope(args: {
    workId?: string | null;
    organizationId?: string | null;
    networkAccess?: boolean;
    resolveParentToolNames?: () => string[];
}): WorkflowParentScope {
    let allowedTools: string[] = ['*'];
    if (args.resolveParentToolNames) {
        try {
            const names = args.resolveParentToolNames();
            if (Array.isArray(names) && names.length > 0) {
                allowedTools = names.filter(
                    (name): name is string => typeof name === 'string' && name.length > 0,
                );
            }
        } catch {
            // Fall back to the wildcard rather than to an EMPTY list: an
            // empty parent scope intersects to nothing and would refuse
            // every delegation with `scope-empty`, turning a resolution
            // hiccup into a broken feature.
            allowedTools = ['*'];
        }
    }
    return {
        allowedTools,
        workId: args.workId ?? null,
        organizationId: args.organizationId ?? null,
        networkAccess: Boolean(args.networkAccess),
    };
}

/** Cap on the serialized size of the returned output. */
const MAX_OUTPUT_CHARS = 8_000;

function projectOutput(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    let serialized: string;
    try {
        serialized = JSON.stringify(value) ?? '';
    } catch {
        // A circular or non-serializable output is a runner bug, not a
        // reason to fail the whole call after the work already happened.
        return '[unserializable output]';
    }
    if (serialized.length <= MAX_OUTPUT_CHARS) return value;
    return `${serialized.slice(0, MAX_OUTPUT_CHARS)}… [truncated ${
        serialized.length - MAX_OUTPUT_CHARS
    } chars]`;
}

export function buildWorkflowTools(args: {
    /** Owner scope. Server-supplied — never from the model. */
    userId: string;
    agentId: string;
    workId?: string | null;
    organizationId?: string | null;
    /**
     * The CURRENT AgentRun's id — the anchor for delegation depth.
     *
     * A graph gets a fresh `runId` of its own from the executor, which is
     * not an `agent_runs` row, so it cannot be used to find the Task this
     * work belongs to. Without the real run id here, a delegation issued
     * by an `agent.delegate` node has nothing to resolve its depth from
     * and the recursion cap silently never fires.
     */
    agentRunId?: string | null;
    /**
     * The tool names this agent actually holds — the `allowedTools` half
     * of the parent scope every `agent.delegate` node is narrowed against.
     *
     * A THUNK, not an array, because the parent's tool list is what we are
     * in the middle of assembling when this factory runs; resolving it
     * eagerly would recurse. At invoke time the resolution has long since
     * finished, so calling it there is safe.
     */
    resolveParentToolNames?: () => string[];
    /** Whether this agent may reach the network at all. ANDed into the child's scope. */
    networkAccess?: boolean;
    executor: Pick<WorkflowGraphExecutorService, 'execute'>;
}): AgentToolDescriptor[] {
    const out: AgentToolDescriptor[] = [];

    out.push({
        name: 'run_workflow_graph',
        description:
            'Run a multi-step workflow graph. Nodes do the work (noop, ai.ask, kb.search, agent.delegate) and edges decide what happens next (sequential, conditional, on_failure, llm_decide), so this is the tool for work that branches, retries a failed step, or fans out to a sub-agent — anything a single linear answer cannot express. Supply the graph inline as `{ id, entryNodeId, nodes: [{ id, kind, config }], edges: [{ id, kind, from, to }] }`. Graph size, step count and the number of agent.delegate nodes are capped; the workflow runs as the current user and cannot reach anything they cannot.',
        parameters: {
            type: 'object',
            properties: {
                graph: {
                    type: 'object',
                    description:
                        'The workflow graph: { id, name?, entryNodeId, nodes: [{ id, kind, name?, config? }], edges: [{ id, kind, from, to, ... }], maxSteps? }. Node kinds: noop, ai.ask (config.prompt), kb.search (config.query), agent.delegate (config.objective).',
                },
                input: {
                    type: 'object',
                    description:
                        'Optional initial input object, readable by edge conditions and input mappings as `input.*`.',
                },
            },
            required: ['graph'],
        },
        // NOTE: there is deliberately NO `context`, `runId`, `userId`,
        // `workId` or `organizationId` parameter. Those decide what the
        // graph is allowed to touch, and they are built below from the
        // Agent row.
        invoke: async (raw) => {
            const a = (raw ?? {}) as RunWorkflowGraphArgs;

            const admission = admitModelAuthoredGraph(a.graph);
            // `=== false`, not `!admission.ok`: this package compiles with
            // `strictNullChecks: false`, under which negated-discriminant
            // narrowing silently picks the WRONG union member. Same trap
            // `SubAgentDelegationService.delegate` documents.
            if (admission.ok === false) {
                return { error: admission.reason };
            }

            try {
                const result = await args.executor.execute(admission.graph, {
                    // Input is model-supplied and that is fine — it is data
                    // the graph reads, not authority it acts with.
                    input: (a.input ?? {}) as Record<string, unknown>,
                    // Authority. Built here, from the Agent row. Anything the
                    // model sent under `context` never reaches this object.
                    context: {
                        userId: args.userId,
                        agentId: args.agentId,
                        workId: args.workId ?? null,
                        organizationId: args.organizationId ?? null,
                        // The anchor for delegation depth. The node runner
                        // hands this to the delegation as `parentRunId`, and
                        // the resolver walks agent_run -> task ->
                        // delegationDepth from it. The executor's own graph
                        // runId is NOT an agent_runs row, so without this the
                        // resolver finds nothing and the depth cap never
                        // fires — the exact inertness this whole seam exists
                        // to remove.
                        agentRunId: args.agentRunId ?? null,
                        // Advisory floor only. The binding number is the
                        // server-derived one the delegation service resolves
                        // off the Task chain via `agentRunId` above; it can
                        // only ever raise this.
                        delegationDepth: 0,
                        // The scope an `agent.delegate` node is narrowed
                        // AGAINST — the contract's "privilege can only ever
                        // shrink going down the tree" property.
                        //
                        // Without it, `limits.parentScope` is undefined,
                        // `narrowSubAgentScope` never runs, and a node's
                        // model-supplied `allowedTools` is taken verbatim.
                        // Built here rather than in the node runner because
                        // this is the only layer that knows what the PARENT
                        // agent actually holds.
                        parentScope: buildParentScope(args),
                    },
                });

                const projected: RunWorkflowGraphResult = {
                    status: result.status,
                    runId: result.runId,
                    visited: result.visited,
                    output: projectOutput(result.output),
                };
                if (result.failureCode) projected.failureCode = result.failureCode;
                if (result.errors?.length) projected.errors = result.errors.slice(0, 10);
                return projected;
            } catch (err) {
                // The executor is documented never to throw on a graph's
                // account, so this is an infrastructure fault. Return it as
                // the tool-error shape rather than letting it escape the
                // tool loop.
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies AgentToolDescriptor<RunWorkflowGraphArgs, RunWorkflowGraphResult>);

    out.push({
        name: 'validate_workflow_graph',
        description:
            'Check a workflow graph without running it: reports whether it would be admitted, and why not if it would be refused (unsupported node kind, too many nodes or agent.delegate nodes, unreachable entry node, malformed edges). Use this to iterate on a graph before spending anything with run_workflow_graph.',
        parameters: {
            type: 'object',
            properties: {
                graph: {
                    type: 'object',
                    description: 'The workflow graph to check. Same shape as run_workflow_graph.',
                },
            },
            required: ['graph'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as RunWorkflowGraphArgs;
            const admission = admitModelAuthoredGraph(a.graph);
            if (admission.ok === true) {
                return {
                    valid: true,
                    // Surfaced because it may have been rewritten downward —
                    // a graph that asked for 200 steps should be told it will
                    // get 25 rather than discovering it mid-run.
                    maxSteps: admission.graph.maxSteps ?? WORKFLOW_TOOL_MAX_STEPS,
                    nodes: admission.graph.nodes.length,
                };
            }
            return { valid: false, reason: admission.reason };
        },
    } satisfies AgentToolDescriptor<
        RunWorkflowGraphArgs,
        { valid: boolean; reason?: string; maxSteps?: number; nodes?: number }
    >);

    return out;
}
