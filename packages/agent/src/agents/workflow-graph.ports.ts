import type { WorkflowNode } from '@ever-works/contracts';

/**
 * Ports the workflow-graph executor runs against (judgment layer G5).
 *
 * The executor owns EDGE semantics — on_failure / conditional /
 * llm_decide / input_mapping — and nothing else. What a node actually
 * DOES, and who answers an `llm_decide` question, are both seams:
 *
 *   - `WORKFLOW_NODE_RUNNER` is bound by whatever host is executing the
 *     graph (a pipeline, an agent run, a test double).
 *   - `WORKFLOW_DECISION_PORT` is bound to the AI-facade adapter in
 *     production, so every model call still goes through the facade /
 *     plugin seam and never a raw provider SDK.
 *
 * Both are `@Optional()` at the injection site: a graph made only of
 * sequential / conditional / on_failure edges runs with no decider
 * bound, and a host that never registered a runner gets a LOUD,
 * typed failure instead of a silent no-op.
 */

/** Everything a node runner is told about the hop that reached it. */
export interface WorkflowNodeRunContext {
    readonly graphId: string;
    readonly runId: string;
    /** Edge that led here; `null` for the entry node. */
    readonly viaEdgeId: string | null;
    /** How many nodes have already executed in this run. */
    readonly stepIndex: number;
    /** Caller-supplied ambient context (userId, workId, agentId …). */
    readonly context: Readonly<Record<string, unknown>>;
}

export interface WorkflowNodeRunResult {
    readonly ok: boolean;
    readonly output?: unknown;
    /**
     * Stable machine token for a failure, matched by an `on_failure`
     * edge's `catch` list. Free-form by design — a node kind owns its
     * own failure vocabulary.
     */
    readonly failureCode?: string;
    readonly error?: string;
}

export interface WorkflowNodeRunner {
    run(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: WorkflowNodeRunContext,
    ): Promise<WorkflowNodeRunResult>;
}

export const WORKFLOW_NODE_RUNNER = 'WORKFLOW_NODE_RUNNER' as const;

/** One arm offered to the decider. */
export interface WorkflowDecisionChoice {
    readonly choice: string;
    readonly description?: string;
    readonly targetNodeId: string;
}

export interface WorkflowDecisionRequest {
    readonly graphId: string;
    readonly runId: string;
    readonly nodeId: string;
    /** The node's own output — what the decision should be based on. */
    readonly nodeOutput: unknown;
    readonly choices: readonly WorkflowDecisionChoice[];
    readonly context: Readonly<Record<string, unknown>>;
}

export interface WorkflowDecision {
    /** Must be one of the offered `choice` tokens. */
    readonly choice: string;
    readonly rationale?: string;
}

export interface WorkflowDecisionPort {
    decide(request: WorkflowDecisionRequest): Promise<WorkflowDecision>;
}

export const WORKFLOW_DECISION_PORT = 'WORKFLOW_DECISION_PORT' as const;
