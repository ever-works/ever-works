import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { validateWorkflowGraph, type WorkflowGraph } from '@ever-works/contracts';
import { WORKFLOW_TOOL_ALLOWED_NODE_KINDS } from '../agents/agent-workflow-tools';
import { Workflow, WorkflowStatus } from '../entities/workflow.entity';
import {
    WorkflowRepository,
    type ListWorkflowsFilter,
    type UpdateWorkflowInput,
} from '../database/repositories/workflow.repository';

export interface CreateWorkflowRequest {
    name: string;
    graph: unknown;
    description?: string | null;
    status?: WorkflowStatus;
    workId?: string | null;
}

export type UpdateWorkflowRequest = Partial<CreateWorkflowRequest>;

/**
 * Saved workflow graphs (judgment layer G5).
 *
 * ## Validation happens on WRITE, not on run
 *
 * A stored graph is validated before it is persisted, so a row that
 * exists is a row that can be executed. Deferring the check to run time
 * would let a user save something that fails later with no idea which
 * edit broke it — and would put the error in a background run's log
 * instead of in the response to the request that caused it.
 *
 * ## Why a stored graph is validated but NOT admission-clamped
 *
 * `admitModelAuthoredGraph` exists because a MODEL authors a graph
 * inline, in the middle of a tool call, with no human between the
 * generation and the execution — so node counts, delegate counts and
 * cycles all have to be bounded defensively.
 *
 * A stored workflow is authored by a USER, deliberately, and is visible
 * and editable before it ever runs. Applying the model clamps here would
 * cap a hand-built workflow at 4 delegate nodes for a reason that does
 * not apply to it. The cost limits that DO matter still apply, because
 * they live where execution happens: `maxSteps` is clamped by the
 * executor, delegation depth is server-derived, the fan-out cap is
 * enforced per agent run, and each delegate node's wait is bounded.
 *
 * What is enforced here is STRUCTURE — `validateWorkflowGraph` — plus a
 * size ceiling generous enough for a real workflow but small enough that
 * a single row cannot become a denial-of-service payload.
 */
@Injectable()
export class WorkflowsService {
    private readonly logger = new Logger(WorkflowsService.name);

    /**
     * Ceiling on a STORED graph. An order of magnitude above the
     * model-authored cap because a human may legitimately build
     * something large; still bounded so one row cannot hold a payload
     * that costs more to parse than to run.
     */
    static readonly MAX_NODES = 200;
    static readonly MAX_EDGES = 400;

    constructor(private readonly workflows: WorkflowRepository) {}

    async create(userId: string, input: CreateWorkflowRequest): Promise<Workflow> {
        const graph = this.assertUsableGraph(input.graph);
        return this.workflows.create({
            userId,
            name: input.name.trim(),
            description: input.description ?? null,
            status: input.status ?? WorkflowStatus.DRAFT,
            graph,
            workId: input.workId ?? null,
        });
    }

    async list(
        userId: string,
        filter: ListWorkflowsFilter = {},
    ): Promise<{ items: Workflow[]; total: number }> {
        return this.workflows.list(userId, filter);
    }

    /**
     * Throws NotFound — never Forbidden — for a workflow belonging to
     * someone else, so the endpoint cannot be used to discover which ids
     * exist for other users.
     */
    async get(userId: string, id: string): Promise<Workflow> {
        const workflow = await this.workflows.findByIdAndUser(id, userId);
        if (!workflow) {
            throw new NotFoundException({ status: 'error', message: 'Workflow not found' });
        }
        return workflow;
    }

    async update(userId: string, id: string, input: UpdateWorkflowRequest): Promise<Workflow> {
        const patch: UpdateWorkflowInput = {};
        if (input.name !== undefined) patch.name = input.name.trim();
        if (input.description !== undefined) patch.description = input.description;
        if (input.status !== undefined) patch.status = input.status;
        if (input.workId !== undefined) patch.workId = input.workId;
        // Re-validated on every edit: the same guarantee as create, which
        // would otherwise be a one-time property that any PATCH could
        // quietly break.
        if (input.graph !== undefined) patch.graph = this.assertUsableGraph(input.graph);

        const updated = await this.workflows.update(id, userId, patch);
        if (!updated) {
            throw new NotFoundException({ status: 'error', message: 'Workflow not found' });
        }
        return updated;
    }

    async remove(userId: string, id: string): Promise<void> {
        const removed = await this.workflows.remove(id, userId);
        if (!removed) {
            throw new NotFoundException({ status: 'error', message: 'Workflow not found' });
        }
    }

    /**
     * Structural + size validation for a stored graph.
     *
     * Returns the graph rather than a boolean so the caller persists
     * exactly what was checked — validating one value and storing another
     * is how a "validated" column ends up holding something that was not.
     */
    private assertUsableGraph(raw: unknown): WorkflowGraph {
        if (!raw || typeof raw !== 'object') {
            throw new BadRequestException({
                status: 'error',
                message: 'graph must be an object',
            });
        }
        const graph = raw as WorkflowGraph;

        if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
            throw new BadRequestException({
                status: 'error',
                message: 'graph.nodes and graph.edges must be arrays',
            });
        }
        if (graph.nodes.length > WorkflowsService.MAX_NODES) {
            throw new BadRequestException({
                status: 'error',
                message: `graph has ${graph.nodes.length} nodes; the limit is ${WorkflowsService.MAX_NODES}`,
            });
        }
        if (graph.edges.length > WorkflowsService.MAX_EDGES) {
            throw new BadRequestException({
                status: 'error',
                message: `graph has ${graph.edges.length} edges; the limit is ${WorkflowsService.MAX_EDGES}`,
            });
        }

        // Node KINDS, not just structure.
        //
        // `validateWorkflowGraph` treats `kind` as an opaque string — the
        // graph model deliberately knows nothing about what a node does —
        // so a graph naming `shell.exec` validates cleanly and then fails
        // at run time with `unknown-node-kind`. That would make the
        // promise this service is built on ("a stored workflow is one
        // that can be executed") false, and would move the error from the
        // response that caused it into a background run's log.
        //
        // The allowlist is imported rather than re-listed: the runner's
        // supported set is the one definition, and a copy here would
        // drift the moment a node kind is added.
        const unsupported = graph.nodes.find(
            (node) =>
                !node ||
                typeof node !== 'object' ||
                !WORKFLOW_TOOL_ALLOWED_NODE_KINDS.includes(node.kind),
        );
        if (unsupported) {
            throw new BadRequestException({
                status: 'error',
                message:
                    `node '${unsupported?.id ?? '<malformed>'}' has unsupported kind ` +
                    `'${unsupported?.kind}'; supported kinds are ` +
                    WORKFLOW_TOOL_ALLOWED_NODE_KINDS.join(', '),
            });
        }

        const validation = validateWorkflowGraph(graph);
        if (!validation.valid) {
            // The reasons are returned verbatim: the author is a human
            // editing this graph, and "invalid graph" with no detail is
            // the least useful thing an editor can say.
            throw new BadRequestException({
                status: 'error',
                message: 'graph is not valid',
                errors: validation.errors,
            });
        }

        return graph;
    }
}
