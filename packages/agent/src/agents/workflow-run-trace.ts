import type { WorkflowRunResult } from './workflow-graph-executor.service';

/**
 * What of a graph run is worth KEEPING (judgment layer G5).
 *
 * A `WorkflowRunResult` is built to be handed straight back to a caller
 * that is about to discard it. A `workflow_runs` row is the opposite: it
 * outlives the run, and there may be one per execution forever. So the
 * two cannot store the same thing, and this module is where that
 * difference is decided — as a pure function, so the rule is testable
 * without a database.
 *
 * ## Why `nodeOutputs` is NOT persisted
 *
 * `WorkflowRunResult.nodeOutputs` maps every visited node id to that
 * node's FULL output. For a `kb.search` node that output is
 * `KnowledgeBaseService.listDocuments(...)` — up to ten entire Knowledge
 * Base documents, content included. A graph may hold many such nodes, and
 * `agent-workflow-tools.ts` already truncates its own projection at
 * `MAX_OUTPUT_CHARS` (8 000) for exactly this reason before letting the
 * value near a model context.
 *
 * Writing that map to a column would make a single row's size a function
 * of how much content the user's KB happens to hold — unbounded, on the
 * hot path of every run, in a table that only ever grows. What a human
 * reading a run record actually needs is WHICH nodes ran, WHETHER each
 * one succeeded, and WHY it stopped. That is what is kept.
 *
 * The final output is kept too, but capped, because "what did this
 * produce" is the second question anyone asks after "did it work".
 */

/**
 * Cap on the serialized final output. Deliberately the SAME number as
 * `agent-workflow-tools.ts`'s `MAX_OUTPUT_CHARS`: both answer "how much
 * of an arbitrary node output is worth carrying", and two different
 * answers would just be drift.
 */
export const WORKFLOW_RUN_MAX_OUTPUT_CHARS = 8_000;

/**
 * Cap on one node's error string. Node errors are provider/exception
 * messages, which can carry a whole stack or an echoed request body.
 */
export const WORKFLOW_RUN_MAX_ERROR_CHARS = 500;

/**
 * Cap on decision rationale. Model prose — useful for "why did the graph
 * go left", worthless past a couple of sentences.
 */
export const WORKFLOW_RUN_MAX_RATIONALE_CHARS = 300;

/**
 * Cap on how many entries each trace list keeps. The executor already
 * stops at `WORKFLOW_MAX_STEPS_CEILING` (500), so this is not the
 * primary bound — it is the guard that keeps the row bounded even if
 * that ceiling is ever raised, and it is what makes `truncated` mean
 * something.
 */
export const WORKFLOW_RUN_MAX_TRACE_ENTRIES = 200;

/** Cap on run-level error strings, mirroring the tool's `slice(0, 10)`. */
export const WORKFLOW_RUN_MAX_ERRORS = 10;

/**
 * Cap on the persisted `failedNodeId`, which is a `varchar(128)` column.
 *
 * Node ids come from a USER-AUTHORED graph and `validateWorkflowGraph`
 * bounds their uniqueness but NOT their length, so a 200-character node
 * id is a legal graph. Without this cap the terminal write would throw on
 * Postgres (sqlite silently ignores varchar limits, so CI and e2e would
 * never see it) — and it would throw on the very path that records a
 * failure, leaving the run stuck in `running` forever. Truncating loses a
 * little of an id; not truncating loses the whole run record.
 */
export const WORKFLOW_RUN_MAX_NODE_ID_CHARS = 120;

export interface WorkflowRunNodeTraceEntry {
    readonly nodeId: string;
    readonly ok: boolean;
    readonly failureCode?: string;
    readonly error?: string;
}

export interface WorkflowRunDecisionTraceEntry {
    readonly nodeId: string;
    readonly choice: string;
    readonly rationale?: string;
    readonly degraded?: boolean;
}

/**
 * The persisted account of a run. Everything here is bounded by a
 * constant above — nothing scales with the size of the data the graph
 * touched.
 */
export interface WorkflowRunTrace {
    /** Node ids in execution order — the headline "what ran". */
    readonly visited: readonly string[];
    /** Per-node outcome. NOT per-node output — see the module note. */
    readonly nodes: readonly WorkflowRunNodeTraceEntry[];
    /** Edge ids in traversal order. */
    readonly traversedEdges: readonly string[];
    readonly decisions: readonly WorkflowRunDecisionTraceEntry[];
    readonly errors: readonly string[];
    /** True when any list above was cut short by a cap. */
    readonly truncated?: boolean;
}

export interface SummarizedWorkflowRun {
    readonly trace: WorkflowRunTrace;
    /**
     * The last green node's output, capped. Mirrors the tool's
     * `projectOutput`: the VALUE when it serializes small enough, and a
     * truncation marker string when it does not — so a consumer never
     * has to guess whether it is looking at data or at a notice.
     */
    readonly output: unknown;
    readonly outputTruncated: boolean;
    readonly failureCode: string | null;
    readonly failedNodeId: string | null;
    /** How many nodes actually executed. */
    readonly stepCount: number;
}

function capString(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/**
 * Cap an arbitrary output the way the chat tool does.
 *
 * Returns `{ value, truncated }` rather than just the value so the caller
 * can record that a cap fired — otherwise "the output was the string
 * '… [truncated N chars]'" is indistinguishable from a node that genuinely
 * returned that text.
 */
function capOutput(value: unknown): { value: unknown; truncated: boolean } {
    if (value === null || value === undefined) return { value: null, truncated: false };
    let serialized: string;
    try {
        serialized = JSON.stringify(value) ?? '';
    } catch {
        // A circular or non-serializable output is a runner bug, not a
        // reason to lose the whole run record after the work happened.
        return { value: '[unserializable output]', truncated: true };
    }
    if (serialized.length <= WORKFLOW_RUN_MAX_OUTPUT_CHARS) return { value, truncated: false };
    return {
        value: `${serialized.slice(0, WORKFLOW_RUN_MAX_OUTPUT_CHARS)}… [truncated ${
            serialized.length - WORKFLOW_RUN_MAX_OUTPUT_CHARS
        } chars]`,
        truncated: true,
    };
}

/**
 * Reduce an executor result to the bounded record that goes on the row.
 *
 * Pure and total: it never throws, because it runs on the completion path
 * of a run that has already done its work — losing the record there would
 * turn a successful run into an invisible one.
 */
export function summarizeWorkflowRun(result: WorkflowRunResult): SummarizedWorkflowRun {
    const capList = <T>(items: readonly T[] | undefined): { items: T[]; truncated: boolean } => {
        const list = items ?? [];
        if (list.length <= WORKFLOW_RUN_MAX_TRACE_ENTRIES) {
            return { items: [...list], truncated: false };
        }
        return { items: list.slice(0, WORKFLOW_RUN_MAX_TRACE_ENTRIES), truncated: true };
    };

    const visited = capList(result.visited);
    const traversedEdges = capList(result.traversedEdges);
    const rawNodes = capList(result.nodes);
    const rawDecisions = capList(result.decisions);

    const nodes: WorkflowRunNodeTraceEntry[] = rawNodes.items.map((node) => {
        const entry: WorkflowRunNodeTraceEntry = { nodeId: node.nodeId, ok: node.ok };
        // Explicit property adds rather than conditional spreads: `...(x &&
        // {k: v})` widens to `false` and breaks this package's declaration
        // emit (the DTS gotcha in CLAUDE.md).
        const out = entry as { failureCode?: string; error?: string };
        if (node.failureCode) out.failureCode = node.failureCode;
        if (node.error) out.error = capString(node.error, WORKFLOW_RUN_MAX_ERROR_CHARS);
        return entry;
    });

    const decisions: WorkflowRunDecisionTraceEntry[] = rawDecisions.items.map((decision) => {
        const entry: WorkflowRunDecisionTraceEntry = {
            nodeId: decision.nodeId,
            choice: decision.choice,
        };
        const out = entry as { rationale?: string; degraded?: boolean };
        if (decision.rationale) {
            out.rationale = capString(decision.rationale, WORKFLOW_RUN_MAX_RATIONALE_CHARS);
        }
        if (decision.degraded) out.degraded = true;
        return entry;
    });

    const errors = (result.errors ?? [])
        .slice(0, WORKFLOW_RUN_MAX_ERRORS)
        .map((error) => capString(error, WORKFLOW_RUN_MAX_ERROR_CHARS));

    const truncated =
        visited.truncated ||
        traversedEdges.truncated ||
        rawNodes.truncated ||
        rawDecisions.truncated ||
        (result.errors?.length ?? 0) > WORKFLOW_RUN_MAX_ERRORS;

    const trace: WorkflowRunTrace = {
        visited: visited.items,
        nodes,
        traversedEdges: traversedEdges.items,
        decisions,
        errors,
    };
    if (truncated) (trace as { truncated?: boolean }).truncated = true;

    const output = capOutput(result.output);

    return {
        trace,
        output: output.value,
        outputTruncated: output.truncated,
        failureCode: result.failureCode ?? null,
        // Hard-truncated (not marked): this feeds a varchar(128) column.
        // See WORKFLOW_RUN_MAX_NODE_ID_CHARS — a truncation marker would
        // itself push the value back over the limit.
        failedNodeId: result.failedNodeId
            ? result.failedNodeId.slice(0, WORKFLOW_RUN_MAX_NODE_ID_CHARS)
            : null,
        // `visited` BEFORE the cap — the count is the honest number of
        // executed nodes, not the number the trace happened to keep.
        stepCount: result.visited?.length ?? 0,
    };
}
