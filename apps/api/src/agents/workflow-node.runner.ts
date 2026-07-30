import { Injectable, Logger, Optional } from '@nestjs/common';
import type { WorkflowNode } from '@ever-works/contracts';
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

        const result = await this.delegation.delegate({
            // Deterministic per (run, node) so a retried graph step
            // reuses the dispatch dedup key instead of spawning a second
            // child for the same node.
            delegationId: `${context.runId}:${node.id}`,
            parentAgentId,
            parentRunId: context.runId,
            parentTaskId: this.contextString(context, 'taskId') ?? null,
            depth: this.contextNumber(context, 'delegationDepth') ?? 0,
            objective,
            scope: {
                allowedTools: this.stringArrayConfig(node, 'allowedTools') ?? [],
                workId: this.contextString(context, 'workId') ?? null,
                organizationId: this.contextString(context, 'organizationId') ?? null,
            },
        });

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
