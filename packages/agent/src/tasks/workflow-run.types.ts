/**
 * Payload contract for the Trigger.dev `workflow-run` task
 * (judgment layer G5).
 *
 * Deliberately just IDS. Everything the walk needs — the graph, the
 * owner, the org scope — is read from the `workflows` / `workflow_runs`
 * rows by the worker, which already shares the API's database.
 *
 * That is not incidental. A payload is written by the producer and read
 * by a consumer that deploys on its OWN release workflow
 * (`.github/workflows/release-trigger-prod.yml`), so an old worker can be
 * handed a payload shape it does not understand and will silently drop
 * the fields it does not know. Carrying the graph — or worse, any scope
 * or limit — on the payload would make correctness depend on deploy
 * ordering. Carrying an id makes the worker re-read the authoritative
 * row every time.
 */
export interface WorkflowRunPayload {
    /** The pre-created `workflow_runs` row this task must finish. */
    readonly workflowRunId: string;

    /**
     * The `workflows` row to execute. Carried alongside the run id purely
     * so the worker can log and validate the pair without a second query;
     * the run row remains the authority and is re-checked.
     */
    readonly workflowId: string;

    /**
     * Owner of the run. Threaded into the graph's execution context so
     * `ai.ask` and `kb.search` nodes run AS that user — `kb.search` in
     * particular is gated by `ensureCanView`, so a missing or wrong
     * userId is a permission failure, not a convenience.
     */
    readonly userId: string;
}
