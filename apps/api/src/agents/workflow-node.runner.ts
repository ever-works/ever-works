import { Injectable, Logger, Optional } from '@nestjs/common';
import type { SubAgentScope, WorkflowNode } from '@ever-works/contracts';
import type {
    WorkflowNodeRunContext,
    WorkflowNodeRunResult,
    WorkflowNodeRunner,
} from '@ever-works/agent/agents';
import { SubAgentDelegationService } from '@ever-works/agent/agents';
import { AiFacadeService } from '@ever-works/agent/facades';
import { KnowledgeBaseService } from '@ever-works/agent/services';

/**
 * The real workflow node runner (judgment layer G5).
 *
 * `WorkflowGraphExecutorService` owns EDGE semantics — sequential,
 * conditional, on_failure, llm_decide, input mapping — and deliberately
 * knows nothing about what a node DOES. That is this seam. Until now no
 * host bound it, so the executor could validate a graph but never run
 * one.
 *
 * ## Node kinds
 *
 * Grounded in capabilities the platform already has, rather than a new
 * vocabulary invented for this file:
 *
 *   noop            — pass inputs through. Already the vocabulary the
 *                     executor's own tests use.
 *   ai.ask          — one model call through the AI facade, so it obeys
 *                     the plugin seam, budgets and provider selection.
 *   kb.search       — search the Knowledge Base / Memory.
 *   agent.delegate  — run a scoped sub-agent delegation. This is what
 *                     makes a graph able to do real work: a node spawns
 *                     a child agent run and waits for its result.
 *
 * ## Unknown kinds fail, they do not silently succeed
 *
 * An unrecognised kind returns `ok: false` with `failureCode:
 * 'unknown-node-kind'`, which an `on_failure` edge can catch. Returning
 * a successful no-op would let a graph appear to complete while doing
 * nothing — the exact silence this whole seam existed to avoid.
 */
@Injectable()
export class WorkflowNodeRunnerService implements WorkflowNodeRunner {
    private readonly logger = new Logger(WorkflowNodeRunnerService.name);

    /**
     * Delegations issued per AGENT run (falling back to the graph run when
     * no agent run is threaded), feeding the contract's fan-out cap.
     * Bounded — see {@link countDelegation}.
     */
    private readonly delegationsByRun = new Map<string, number>();
    private static readonly MAX_TRACKED_RUNS = 500;

    constructor(
        @Optional() private readonly delegation?: SubAgentDelegationService,
        @Optional() private readonly ai?: AiFacadeService,
        @Optional() private readonly kb?: KnowledgeBaseService,
    ) {}

    async run(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: WorkflowNodeRunContext,
    ): Promise<WorkflowNodeRunResult> {
        try {
            switch (node.kind) {
                case 'noop':
                    return { ok: true, output: inputs };
                case 'ai.ask':
                    return await this.runAiAsk(node, inputs, context);
                case 'kb.search':
                    return await this.runKbSearch(node, inputs, context);
                case 'agent.delegate':
                    return await this.runDelegate(node, inputs, context);
                default:
                    return {
                        ok: false,
                        failureCode: 'unknown-node-kind',
                        error: `no runner for node kind '${node.kind}'`,
                    };
            }
        } catch (error) {
            // A thrown node must not abort the whole graph: the executor's
            // on_failure edges exist precisely so a graph can recover. Turn
            // it into a typed failure the graph can match on.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Node ${node.id} (${node.kind}) threw: ${message}`);
            return { ok: false, failureCode: 'node-threw', error: message };
        }
    }

    private async runAiAsk(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: WorkflowNodeRunContext,
    ): Promise<WorkflowNodeRunResult> {
        if (!this.ai) {
            return { ok: false, failureCode: 'ai-unavailable', error: 'AI facade not bound' };
        }
        const prompt = this.stringConfig(node, 'prompt');
        if (!prompt) {
            return {
                ok: false,
                failureCode: 'bad-node-config',
                error: `node '${node.id}' of kind ai.ask requires config.prompt`,
            };
        }
        const userId = this.contextString(context, 'userId');
        if (!userId) {
            return {
                ok: false,
                failureCode: 'missing-scope',
                error: 'ai.ask requires userId in the run context',
            };
        }

        // `createChatCompletion`, not `askJson`: a generic graph node has
        // no schema to validate against, and requiring one would force
        // every ai.ask node to declare a shape it does not need.
        const completion = await this.ai.createChatCompletion(
            {
                messages: [
                    {
                        role: 'user',
                        content: `${prompt}\n\nInputs:\n${JSON.stringify(inputs).slice(0, 4000)}`,
                    },
                ],
            },
            { userId, workId: this.contextString(context, 'workId') },
        );
        // The provider contract returns choices, not a flat string.
        return { ok: true, output: completion.choices[0]?.message?.content ?? '' };
    }

    private async runKbSearch(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: WorkflowNodeRunContext,
    ): Promise<WorkflowNodeRunResult> {
        if (!this.kb) {
            return { ok: false, failureCode: 'kb-unavailable', error: 'KB service not bound' };
        }
        const query = this.stringConfig(node, 'query') ?? this.asString(inputs['query']);
        const workId = this.contextString(context, 'workId');
        const userId = this.contextString(context, 'userId');
        if (!query || !workId || !userId) {
            return {
                ok: false,
                failureCode: 'bad-node-config',
                error: 'kb.search requires a query plus workId and userId in the run context',
            };
        }
        // `listDocuments` enforces `ensureCanView(workId, userId)` itself,
        // so the node cannot read a Work the run's user cannot see.
        const results = await this.kb.listDocuments(workId, userId, { q: query, limit: 10 });
        return { ok: true, output: results };
    }

    private async runDelegate(
        node: WorkflowNode,
        inputs: Record<string, unknown>,
        context: WorkflowNodeRunContext,
    ): Promise<WorkflowNodeRunResult> {
        if (!this.delegation) {
            return {
                ok: false,
                failureCode: 'delegation-unavailable',
                error: 'sub-agent delegation service not bound',
            };
        }
        const objective =
            this.stringConfig(node, 'objective') ?? this.asString(inputs['objective']);
        const parentAgentId = this.contextString(context, 'agentId');
        if (!objective || !parentAgentId) {
            return {
                ok: false,
                failureCode: 'bad-node-config',
                error: 'agent.delegate requires an objective and an agentId in the run context',
            };
        }

        // The scope the PARENT holds, built server-side by whichever host
        // started this graph. Its presence is what activates
        // `narrowSubAgentScope` — the contract's "privilege can only ever
        // shrink going down the tree" property, which does not run at all
        // when `limits.parentScope` is undefined.
        const parentScope = this.parentScope(context);

        const result = await this.delegation.delegate(
            {
                // Deterministic per (run, node) so a retried graph step
                // reuses the dispatch dedup key instead of spawning a second
                // child for the same node.
                delegationId: `${context.runId}:${node.id}`,
                parentAgentId,
                // The REAL AgentRun id when the host supplied one, falling back
                // to the graph's own run id.
                //
                // This is what anchors delegation depth: the resolver walks
                // `agent_run -> task -> delegationDepth` from `parentRunId`, and
                // `context.runId` is minted by the graph executor — it is not an
                // `agent_runs` row, so resolving from it finds nothing and the
                // depth cap silently never fires. The fallback keeps a host that
                // supplies neither working exactly as before.
                parentRunId: this.contextString(context, 'agentRunId') ?? context.runId,
                parentTaskId: this.contextString(context, 'taskId') ?? null,
                // An advisory FLOOR. The binding number is server-derived:
                // `SubAgentDelegationService` resolves the true depth from the
                // Task chain (anchored by `parentRunId` above) and raises this
                // value before validating, never lowers it.
                depth: this.contextNumber(context, 'delegationDepth') ?? 0,
                objective,
                scope: {
                    // `['*']` means "everything the parent had" — the contract's
                    // only wildcard, and the honest default for a node that
                    // names no tools. Used ONLY when a parent scope exists to
                    // bound it; without one it would be an unbounded request,
                    // so the empty list (which the contract refuses as
                    // `scope-empty`) is kept instead. Same outcome as before
                    // this change for any host that supplies no parent scope.
                    allowedTools:
                        this.stringArrayConfig(node, 'allowedTools') ?? (parentScope ? ['*'] : []),
                    workId: this.contextString(context, 'workId') ?? null,
                    organizationId: this.contextString(context, 'organizationId') ?? null,
                },
            },
            {
                // Without these two the contract's caps are inert:
                // `narrowSubAgentScope` never runs (so a node's
                // model-supplied `allowedTools` was taken verbatim), and the
                // fan-out check compares `0 >= maxSiblings`, which is never
                // true however many delegations one run issues.
                ...(parentScope ? { parentScope } : {}),
                siblingCount: this.countDelegation(
                    // Keyed by the AGENT run, not the graph run.
                    //
                    // The contract's wording is "how many delegations the
                    // parent has already issued in this run", and the parent
                    // is an agent run — a model may call
                    // `run_workflow_graph` repeatedly, and each call mints a
                    // fresh graph id. Counting per graph run would hand out a
                    // brand-new budget on every call, which combined with the
                    // 4-delegate-node admission cap means the ceiling of 5
                    // could never be reached at all.
                    this.contextString(context, 'agentRunId') ?? context.runId,
                ),
            },
        );

        // A refusal is a legitimate graph outcome, not an exception: the
        // failure code is surfaced so an on_failure edge can route on it
        // (`budget-exceeded` and `depth-exceeded` want different arms).
        if (result.status !== 'completed') {
            return {
                ok: false,
                failureCode: result.refusalCode ?? result.status,
                error: result.summary,
                output: result.output,
            };
        }
        return { ok: true, output: result.output };
    }

    /**
     * Read the parent scope the host put in the run context.
     *
     * Validated rather than trusted: the context is assembled server-side
     * today, but this is the object that decides how far a child's
     * privilege reaches, so a malformed one is dropped (returning
     * `undefined`, i.e. today's no-narrowing behaviour) rather than
     * half-applied. A scope with no tools is also dropped — it would
     * intersect to nothing and refuse every delegation with `scope-empty`,
     * which is a broken feature rather than a safe default.
     */
    private parentScope(context: WorkflowNodeRunContext): SubAgentScope | undefined {
        const raw = context.context['parentScope'];
        if (!raw || typeof raw !== 'object') return undefined;
        const candidate = raw as Partial<SubAgentScope>;
        if (!Array.isArray(candidate.allowedTools)) return undefined;
        const allowedTools = candidate.allowedTools.filter(
            (tool): tool is string => typeof tool === 'string' && tool.length > 0,
        );
        if (allowedTools.length === 0) return undefined;
        return {
            allowedTools,
            workId: typeof candidate.workId === 'string' ? candidate.workId : null,
            organizationId:
                typeof candidate.organizationId === 'string' ? candidate.organizationId : null,
            networkAccess: Boolean(candidate.networkAccess),
        };
    }

    /**
     * How many delegations this graph run has already issued, then record
     * this one.
     *
     * The contract's fan-out cap is checked against a count the CALLER
     * supplies; nothing supplied one, so `0 >= maxSiblings` was never true
     * and the cap could not fire.
     *
     * The key is the AGENT run (see the call site). The graph run is the
     * wrong unit: the executor is a single linear walk, so with
     * delegate-on-a-cycle already refused each delegate node runs at most
     * once — at most 4 per graph, under the ceiling of 5. Per-graph
     * counting would therefore never refuse anything, while a model
     * calling the tool repeatedly racked up unbounded delegations.
     *
     * Bounded on purpose: this service is a long-lived singleton, so an
     * unbounded Map keyed by run id is a slow leak. Runs are short and the
     * count only matters while one is executing, so the oldest entries are
     * evicted once the map exceeds {@link MAX_TRACKED_RUNS}. A run evicted
     * mid-flight simply restarts its count — it under-counts rather than
     * over-refusing, which is the right direction for an eviction to fail.
     */
    private countDelegation(runId: string): number {
        const previous = this.delegationsByRun.get(runId) ?? 0;
        // Re-insert so insertion order tracks recency (Map preserves it),
        // which is what makes the eviction below drop the OLDEST run.
        this.delegationsByRun.delete(runId);
        this.delegationsByRun.set(runId, previous + 1);

        while (this.delegationsByRun.size > WorkflowNodeRunnerService.MAX_TRACKED_RUNS) {
            const oldest = this.delegationsByRun.keys().next();
            if (oldest.done) break;
            this.delegationsByRun.delete(oldest.value);
        }
        return previous;
    }

    private stringConfig(node: WorkflowNode, key: string): string | undefined {
        return this.asString(node.config?.[key]);
    }

    private stringArrayConfig(node: WorkflowNode, key: string): string[] | undefined {
        const raw = node.config?.[key];
        if (!Array.isArray(raw)) return undefined;
        return raw.filter((entry): entry is string => typeof entry === 'string');
    }

    private asString(value: unknown): string | undefined {
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private contextString(context: WorkflowNodeRunContext, key: string): string | undefined {
        return this.asString(context.context[key]);
    }

    private contextNumber(context: WorkflowNodeRunContext, key: string): number | undefined {
        const value = context.context[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }
}
