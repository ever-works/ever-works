import type { WorkflowRunResult } from '../workflow-graph-executor.service';
import {
    summarizeWorkflowRun,
    WORKFLOW_RUN_MAX_ERROR_CHARS,
    WORKFLOW_RUN_MAX_ERRORS,
    WORKFLOW_RUN_MAX_NODE_ID_CHARS,
    WORKFLOW_RUN_MAX_OUTPUT_CHARS,
    WORKFLOW_RUN_MAX_RATIONALE_CHARS,
    WORKFLOW_RUN_MAX_TRACE_ENTRIES,
} from '../workflow-run-trace';

/**
 * What a run row is allowed to hold.
 *
 * The failure this guards against is not a crash — it is a table whose
 * row size is a function of how much content the user's Knowledge Base
 * happens to contain. `WorkflowRunResult.nodeOutputs` maps every visited
 * node to its FULL output, and a `kb.search` node's output is up to ten
 * entire KB documents. `agent-workflow-tools.ts` already truncates its
 * own projection for exactly this reason before letting the value near a
 * model context; a persisted row needs the same discipline, forever.
 */
describe('summarizeWorkflowRun', () => {
    const result = (over: Partial<WorkflowRunResult> = {}): WorkflowRunResult =>
        ({
            status: 'completed',
            runId: 'run-1',
            visited: ['a', 'b'],
            traversedEdges: ['e-ab'],
            nodes: [
                { nodeId: 'a', viaEdgeId: null, ok: true },
                { nodeId: 'b', viaEdgeId: 'e-ab', ok: true },
            ],
            decisions: [],
            output: { ok: true },
            nodeOutputs: { a: { huge: 'x' }, b: { huge: 'y' } },
            errors: [],
            ...over,
        }) as WorkflowRunResult;

    it('keeps the visited list, the per-node outcome and the traversed edges', async () => {
        const summary = summarizeWorkflowRun(result());
        expect(summary.trace.visited).toEqual(['a', 'b']);
        expect(summary.trace.traversedEdges).toEqual(['e-ab']);
        expect(summary.trace.nodes).toEqual([
            { nodeId: 'a', ok: true },
            { nodeId: 'b', ok: true },
        ]);
        expect(summary.stepCount).toBe(2);
    });

    it('NEVER carries nodeOutputs — the unbounded field this cap exists for', () => {
        const summary = summarizeWorkflowRun(result());
        // Serialize the whole trace: the per-node payloads must not be
        // reachable anywhere inside it, by any key.
        expect(JSON.stringify(summary.trace)).not.toContain('huge');
        expect(summary.trace).not.toHaveProperty('nodeOutputs');
    });

    it('passes a small output through unchanged and flags nothing', () => {
        const summary = summarizeWorkflowRun(result({ output: { small: true } }));
        expect(summary.output).toEqual({ small: true });
        expect(summary.outputTruncated).toBe(false);
    });

    it('truncates an oversized output and says that it did', () => {
        const huge = { blob: 'x'.repeat(WORKFLOW_RUN_MAX_OUTPUT_CHARS * 2) };
        const summary = summarizeWorkflowRun(result({ output: huge }));

        expect(summary.outputTruncated).toBe(true);
        expect(typeof summary.output).toBe('string');
        expect(summary.output as string).toContain('[truncated');
        // The marker itself is short — the point is the row stays bounded.
        expect((summary.output as string).length).toBeLessThan(WORKFLOW_RUN_MAX_OUTPUT_CHARS + 100);
    });

    it('survives a non-serializable output instead of losing the whole record', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const summary = summarizeWorkflowRun(result({ output: circular }));
        expect(summary.output).toBe('[unserializable output]');
        expect(summary.outputTruncated).toBe(true);
    });

    it('caps a node error string', () => {
        const summary = summarizeWorkflowRun(
            result({
                status: 'failed',
                nodes: [
                    {
                        nodeId: 'a',
                        viaEdgeId: null,
                        ok: false,
                        failureCode: 'node-threw',
                        error: 'E'.repeat(WORKFLOW_RUN_MAX_ERROR_CHARS * 3),
                    },
                ],
            }),
        );
        const error = summary.trace.nodes[0].error as string;
        expect(error.length).toBeLessThan(WORKFLOW_RUN_MAX_ERROR_CHARS + 60);
        expect(error).toContain('[truncated');
    });

    it('caps decision rationale — model prose, useful only in the first sentence', () => {
        const summary = summarizeWorkflowRun(
            result({
                decisions: [
                    {
                        nodeId: 'a',
                        choice: 'left',
                        rationale: 'R'.repeat(WORKFLOW_RUN_MAX_RATIONALE_CHARS * 3),
                    },
                ],
            }),
        );
        const rationale = summary.trace.decisions[0].rationale as string;
        expect(rationale.length).toBeLessThan(WORKFLOW_RUN_MAX_RATIONALE_CHARS + 60);
    });

    it('caps the trace lists and marks the trace as truncated', () => {
        const many = Array.from({ length: WORKFLOW_RUN_MAX_TRACE_ENTRIES + 50 }, (_, i) => `n${i}`);
        const summary = summarizeWorkflowRun(result({ visited: many }));

        expect(summary.trace.visited).toHaveLength(WORKFLOW_RUN_MAX_TRACE_ENTRIES);
        expect(summary.trace.truncated).toBe(true);
        // stepCount reports the HONEST count, not what the trace kept.
        expect(summary.stepCount).toBe(many.length);
    });

    it('caps the run error list', () => {
        const errors = Array.from({ length: WORKFLOW_RUN_MAX_ERRORS + 5 }, (_, i) => `err ${i}`);
        const summary = summarizeWorkflowRun(result({ status: 'failed', errors }));
        expect(summary.trace.errors).toHaveLength(WORKFLOW_RUN_MAX_ERRORS);
        expect(summary.trace.truncated).toBe(true);
    });

    it('truncates a long failedNodeId to fit its varchar(128) column', () => {
        // Node ids are user-authored and `validateWorkflowGraph` does not
        // bound their length. Overflowing here would throw on Postgres on
        // the very write that records a failure, stranding the run in
        // `running` — and sqlite would never catch it in CI.
        const summary = summarizeWorkflowRun(
            result({ status: 'failed', failureCode: 'node-failed', failedNodeId: 'n'.repeat(400) }),
        );
        expect((summary.failedNodeId as string).length).toBe(WORKFLOW_RUN_MAX_NODE_ID_CHARS);
        expect(WORKFLOW_RUN_MAX_NODE_ID_CHARS).toBeLessThan(128);
    });

    it('carries the failure code and failed node through', () => {
        const summary = summarizeWorkflowRun(
            result({ status: 'failed', failureCode: 'max-steps-exceeded', failedNodeId: 'b' }),
        );
        expect(summary.failureCode).toBe('max-steps-exceeded');
        expect(summary.failedNodeId).toBe('b');
    });

    it('nulls the codes on a clean run rather than leaving them undefined', () => {
        // `undefined` and `null` round-trip differently through a
        // simple-json column; the row should read the same either way.
        const summary = summarizeWorkflowRun(result());
        expect(summary.failureCode).toBeNull();
        expect(summary.failedNodeId).toBeNull();
        expect(summary.trace.truncated).toBeUndefined();
    });
});
