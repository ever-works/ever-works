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

    const unknown = graph.nodes.find(
        (node: WorkflowNode) => !WORKFLOW_TOOL_ALLOWED_NODE_KINDS.includes(node?.kind),
    );
    if (unknown) {
        // Refused, not skipped. A graph that silently drops a node it does
        // not understand would report success for work it never did.
        return {
            ok: false,
            reason:
                `node '${unknown.id}' has unsupported kind '${unknown.kind}'; ` +
                `supported kinds are ${WORKFLOW_TOOL_ALLOWED_NODE_KINDS.join(', ')}`,
        };
    }

    const delegateCount = graph.nodes.filter(
        (node: WorkflowNode) => node.kind === 'agent.delegate',
    ).length;
    if (delegateCount > WORKFLOW_TOOL_MAX_DELEGATE_NODES) {
        return {
            ok: false,
            reason:
                `graph has ${delegateCount} agent.delegate nodes; the limit is ` +
                `${WORKFLOW_TOOL_MAX_DELEGATE_NODES} because each one spawns a child agent run`,
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
                        // A chat-initiated graph is the ROOT of any delegation
                        // chain it starts. Stating 0 explicitly (rather than
                        // omitting it) documents that this is the anchor; the
                        // real bound comes from the server-derived depth the
                        // delegation service resolves off the Task chain.
                        delegationDepth: 0,
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
