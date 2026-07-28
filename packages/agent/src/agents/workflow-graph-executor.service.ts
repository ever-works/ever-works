import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    applyWorkflowInputMapping,
    evaluateWorkflowCondition,
    onFailureEdgeCatches,
    outgoingWorkflowEdges,
    validateWorkflowGraph,
    WORKFLOW_DEFAULT_MAX_STEPS,
    WORKFLOW_MAX_STEPS_CEILING,
    type WorkflowEdge,
    type WorkflowGraph,
    type WorkflowLlmDecideEdge,
    type WorkflowNode,
} from '@ever-works/contracts';
import {
    WORKFLOW_DECISION_PORT,
    WORKFLOW_NODE_RUNNER,
    type WorkflowDecisionPort,
    type WorkflowNodeRunner,
} from './workflow-graph.ports';

/**
 * Terminal states of a graph run.
 *
 *   - `completed` — walked off the end of the graph with the last node green.
 *   - `failed`    — a node failed and no `on_failure` edge caught it, or a
 *                   structural/traversal rule stopped the run.
 *   - `blocked`   — the run cannot continue for a reason that is not the
 *                   graph's fault (no decider bound and no fallback arm,
 *                   no node runner bound). Distinct from `failed` so a
 *                   caller can retry rather than escalate.
 */
export type WorkflowRunStatus = 'completed' | 'failed' | 'blocked';

/** Machine tokens for why a run stopped. Persisted in traces — never rename. */
export type WorkflowRunFailureCode =
    | 'graph-invalid'
    | 'node-not-found'
    | 'node-failed'
    | 'no-node-runner'
    | 'input-mapping-unresolved'
    | 'llm-decide-unavailable'
    | 'llm-decide-unknown-choice'
    | 'max-steps-exceeded';

export interface WorkflowNodeTrace {
    readonly nodeId: string;
    readonly viaEdgeId: string | null;
    readonly ok: boolean;
    readonly failureCode?: string;
    readonly error?: string;
}

export interface WorkflowDecisionTrace {
    readonly nodeId: string;
    readonly choice: string;
    readonly rationale?: string;
    /** True when the decider was unavailable and the declared fallback arm was taken. */
    readonly degraded?: boolean;
}

export interface WorkflowRunResult {
    readonly status: WorkflowRunStatus;
    readonly runId: string;
    /** Node ids in execution order. */
    readonly visited: readonly string[];
    /** Edge ids in traversal order. */
    readonly traversedEdges: readonly string[];
    readonly nodes: readonly WorkflowNodeTrace[];
    readonly decisions: readonly WorkflowDecisionTrace[];
    /** Output of the last node that ran green. `undefined` when nothing succeeded. */
    readonly output: unknown;
    readonly nodeOutputs: Readonly<Record<string, unknown>>;
    readonly failureCode?: WorkflowRunFailureCode;
    readonly failedNodeId?: string;
    readonly errors: readonly string[];
}

export interface WorkflowRunOptions {
    /** Stable id for the run — echoed into node/decision context. */
    readonly runId?: string;
    /** Inputs handed to the entry node. */
    readonly input?: Record<string, unknown>;
    /** Ambient context passed through to the runner + decider (userId, workId …). */
    readonly context?: Record<string, unknown>;
}

/** The scope every `conditional` path and `inputMapping` reads from. */
interface WorkflowScope {
    readonly input: Record<string, unknown>;
    readonly context: Record<string, unknown>;
    readonly nodes: Record<string, { output: unknown; ok: boolean; failureCode?: string }>;
    /** The node that just ran — so mappings can say `last.output.x`. */
    last: { nodeId: string; output: unknown; ok: boolean; failureCode?: string } | null;
}

let runCounter = 0;

function nextRunId(): string {
    runCounter += 1;
    return `wf-${Date.now().toString(36)}-${runCounter.toString(36)}`;
}

/**
 * Workflow-graph executor (judgment layer G5).
 *
 * Walks a {@link WorkflowGraph} one node at a time and picks the next
 * edge with a FIXED precedence that is the whole point of the model:
 *
 *   node failed  → `on_failure` edges whose `catch` matches (declaration order)
 *   node green   → `conditional` edges whose predicate holds (declaration order)
 *                → `llm_decide` edges (one question, the matching arm wins)
 *                → the single `sequential` edge
 *                → nothing left ⇒ the run completed
 *
 * `inputMapping` is applied on EVERY traversal, so the destination node
 * receives exactly the inputs the edge declared. An edge with no mapping
 * passes the source node's output through as `{ input: <output> }`,
 * which keeps the trivial two-node graph free of ceremony.
 *
 * Cycles are legal (a retry loop is a cycle); unbounded runs are not —
 * `maxSteps` is clamped to {@link WORKFLOW_MAX_STEPS_CEILING}.
 *
 * The executor NEVER throws on a graph's account: every stop is a typed
 * `WorkflowRunResult`. A throw from an injected runner or decider is
 * caught and turned into the corresponding failure, because a workflow
 * that dies mid-walk with a raw exception loses the trace, and the
 * trace is the thing a human needs.
 */
@Injectable()
export class WorkflowGraphExecutorService {
    private readonly logger = new Logger(WorkflowGraphExecutorService.name);

    constructor(
        // Bound by the host that owns node semantics. Absent in unit tests
        // and in installs that only validate graphs — a run then stops
        // LOUDLY with `no-node-runner` rather than pretending to succeed.
        @Optional()
        @Inject(WORKFLOW_NODE_RUNNER)
        private readonly runner?: WorkflowNodeRunner,
        // Bound to the AI-facade adapter in production (`@Optional()` +
        // appended LAST, per the positional-spec arity rule). Every model
        // call therefore goes through the facade/plugin seam.
        @Optional()
        @Inject(WORKFLOW_DECISION_PORT)
        private readonly decider?: WorkflowDecisionPort,
    ) {}

    async execute(
        graph: WorkflowGraph,
        options: WorkflowRunOptions = {},
    ): Promise<WorkflowRunResult> {
        const runId = options.runId ?? nextRunId();
        const visited: string[] = [];
        const traversedEdges: string[] = [];
        const nodes: WorkflowNodeTrace[] = [];
        const decisions: WorkflowDecisionTrace[] = [];
        const errors: string[] = [];

        const validation = validateWorkflowGraph(graph);
        if (!validation.valid) {
            return {
                status: 'failed',
                runId,
                visited,
                traversedEdges,
                nodes,
                decisions,
                output: undefined,
                nodeOutputs: {},
                failureCode: 'graph-invalid',
                errors: validation.errors,
            };
        }

        const scope: WorkflowScope = {
            input: options.input ?? {},
            context: options.context ?? {},
            nodes: {},
            last: null,
        };

        const finish = (
            status: WorkflowRunStatus,
            failureCode?: WorkflowRunFailureCode,
            failedNodeId?: string,
        ): WorkflowRunResult => {
            const nodeOutputs: Record<string, unknown> = {};
            for (const [nodeId, state] of Object.entries(scope.nodes))
                nodeOutputs[nodeId] = state.output;
            const result: WorkflowRunResult = {
                status,
                runId,
                visited,
                traversedEdges,
                nodes,
                decisions,
                output: scope.last?.ok ? scope.last.output : undefined,
                nodeOutputs,
                errors,
                ...(failureCode ? { failureCode } : {}),
                ...(failedNodeId ? { failedNodeId } : {}),
            };
            return result;
        };

        if (!this.runner) {
            errors.push('no WORKFLOW_NODE_RUNNER is bound — nothing can execute a node');
            return finish('blocked', 'no-node-runner');
        }

        const byId = new Map<string, WorkflowNode>();
        for (const node of graph.nodes) byId.set(node.id, node);

        const maxSteps = Math.min(
            graph.maxSteps && graph.maxSteps > 0 ? graph.maxSteps : WORKFLOW_DEFAULT_MAX_STEPS,
            WORKFLOW_MAX_STEPS_CEILING,
        );

        let currentNodeId: string | null = graph.entryNodeId;
        let viaEdgeId: string | null = null;
        let inputs: Record<string, unknown> = { ...scope.input };

        for (let stepIndex = 0; currentNodeId !== null; stepIndex += 1) {
            if (stepIndex >= maxSteps) {
                errors.push(`run exceeded maxSteps (${maxSteps}) — the graph is looping`);
                return finish('failed', 'max-steps-exceeded', currentNodeId);
            }

            const node = byId.get(currentNodeId);
            if (!node) {
                errors.push(`node "${currentNodeId}" is not in the graph`);
                return finish('failed', 'node-not-found', currentNodeId);
            }

            const runResult = await this.runNode(node, inputs, {
                graphId: graph.id,
                runId,
                viaEdgeId,
                stepIndex,
                context: scope.context,
            });

            visited.push(node.id);
            nodes.push({
                nodeId: node.id,
                viaEdgeId,
                ok: runResult.ok,
                ...(runResult.failureCode ? { failureCode: runResult.failureCode } : {}),
                ...(runResult.error ? { error: runResult.error } : {}),
            });
            const state = {
                output: runResult.output,
                ok: runResult.ok,
                ...(runResult.failureCode ? { failureCode: runResult.failureCode } : {}),
            };
            scope.nodes[node.id] = state;
            scope.last = { nodeId: node.id, ...state };

            const selection = await this.selectNextEdge(
                graph,
                node,
                runResult.ok,
                scope,
                runId,
                decisions,
            );
            if (selection.kind === 'stop') {
                if (selection.failureCode) {
                    if (selection.error) errors.push(selection.error);
                    return finish(selection.status, selection.failureCode, node.id);
                }
                return finish(selection.status);
            }

            const edge = selection.edge;
            const mapped = applyWorkflowInputMapping(edge.inputMapping, scope);
            // `=== false` for the same reason as in the delegation service:
            // `strictNullChecks: false` breaks negated-discriminant narrowing.
            if (mapped.ok === false) {
                errors.push(
                    `edge "${edge.id}" could not resolve required input(s): ${mapped.missing.join(', ')}`,
                );
                return finish('failed', 'input-mapping-unresolved', node.id);
            }

            traversedEdges.push(edge.id);
            // No mapping ⇒ pass the source output straight through, so the
            // simple case needs no `inputMapping` boilerplate.
            inputs =
                edge.inputMapping && edge.inputMapping.length > 0
                    ? mapped.inputs
                    : { input: runResult.output };
            viaEdgeId = edge.id;
            currentNodeId = edge.to;
        }

        return finish('completed');
    }

    private async runNode(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: Parameters<WorkflowNodeRunner['run']>[2],
    ): Promise<{ ok: boolean; output?: unknown; failureCode?: string; error?: string }> {
        try {
            return await this.runner!.run(node, inputs, context);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Workflow ${context.graphId}: node "${node.id}" threw: ${message}`);
            // A thrown runner is just another failure — `on_failure` edges
            // get their chance instead of the whole run dying untraced.
            return { ok: false, failureCode: 'node-threw', error: message };
        }
    }

    private async selectNextEdge(
        graph: WorkflowGraph,
        node: WorkflowNode,
        ok: boolean,
        scope: WorkflowScope,
        runId: string,
        decisions: WorkflowDecisionTrace[],
    ): Promise<
        | { kind: 'edge'; edge: WorkflowEdge }
        | {
              kind: 'stop';
              status: WorkflowRunStatus;
              failureCode?: WorkflowRunFailureCode;
              error?: string;
          }
    > {
        if (!ok) {
            const failureCode = scope.last?.failureCode;
            for (const edge of outgoingWorkflowEdges(graph, node.id, 'on_failure')) {
                if (onFailureEdgeCatches(edge, failureCode)) return { kind: 'edge', edge };
            }
            return {
                kind: 'stop',
                status: 'failed',
                failureCode: 'node-failed',
                error: `node "${node.id}" failed (${failureCode ?? 'no code'}) and no on_failure edge caught it`,
            };
        }

        for (const edge of outgoingWorkflowEdges(graph, node.id, 'conditional')) {
            if (evaluateWorkflowCondition(edge.when, scope)) return { kind: 'edge', edge };
        }

        const decideEdges = outgoingWorkflowEdges(graph, node.id, 'llm_decide');
        if (decideEdges.length > 0) {
            return this.decideNextEdge(graph, node, decideEdges, scope, runId, decisions);
        }

        const sequential = outgoingWorkflowEdges(graph, node.id, 'sequential');
        if (sequential.length > 0) return { kind: 'edge', edge: sequential[0] };

        return { kind: 'stop', status: 'completed' };
    }

    private async decideNextEdge(
        graph: WorkflowGraph,
        node: WorkflowNode,
        decideEdges: readonly WorkflowLlmDecideEdge[],
        scope: WorkflowScope,
        runId: string,
        decisions: WorkflowDecisionTrace[],
    ): Promise<
        | { kind: 'edge'; edge: WorkflowEdge }
        | {
              kind: 'stop';
              status: WorkflowRunStatus;
              failureCode?: WorkflowRunFailureCode;
              error?: string;
          }
    > {
        const fallback = decideEdges.find((edge) => edge.fallback);
        const degrade = (reason: string) => {
            if (!fallback) {
                return {
                    kind: 'stop' as const,
                    status: 'blocked' as const,
                    failureCode: 'llm-decide-unavailable' as const,
                    error: `${reason} and node "${node.id}" declares no fallback arm`,
                };
            }
            this.logger.warn(
                `Workflow ${graph.id}: ${reason} — taking the declared fallback arm "${fallback.choice}".`,
            );
            decisions.push({ nodeId: node.id, choice: fallback.choice, degraded: true });
            return { kind: 'edge' as const, edge: fallback as WorkflowEdge };
        };

        if (!this.decider) return degrade('no WORKFLOW_DECISION_PORT is bound');

        let decision;
        try {
            decision = await this.decider.decide({
                graphId: graph.id,
                runId,
                nodeId: node.id,
                nodeOutput: scope.last?.output,
                choices: decideEdges.map((edge) => ({
                    choice: edge.choice,
                    targetNodeId: edge.to,
                    ...(edge.choiceDescription ? { description: edge.choiceDescription } : {}),
                })),
                context: scope.context,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return degrade(`the decision port threw (${message})`);
        }

        const chosen = decideEdges.find((edge) => edge.choice === decision.choice);
        if (!chosen) {
            if (fallback)
                return degrade(`the decider returned unknown choice "${decision.choice}"`);
            return {
                kind: 'stop',
                status: 'failed',
                failureCode: 'llm-decide-unknown-choice',
                error: `the decider returned "${decision.choice}", which is not an arm of node "${node.id}"`,
            };
        }
        decisions.push({
            nodeId: node.id,
            choice: chosen.choice,
            ...(decision.rationale ? { rationale: decision.rationale } : {}),
        });
        return { kind: 'edge', edge: chosen as WorkflowEdge };
    }
}
