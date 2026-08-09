import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { WorkflowRunsService, WorkflowsService } from '@ever-works/agent/services';
import { WorkflowStatus } from '@ever-works/agent/entities';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const WORKFLOW_STATUSES: string[] = [
    WorkflowStatus.DRAFT,
    WorkflowStatus.ACTIVE,
    WorkflowStatus.ARCHIVED,
];

export class CreateWorkflowDto {
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name: string;

    /**
     * The graph, validated by the service against
     * `validateWorkflowGraph`.
     *
     * `@IsObject()` with NO nested DTO on purpose: the global pipe runs
     * `whitelist: true`, which strips undecorated properties, so
     * modelling nodes/edges as nested DTOs would silently delete every
     * field of the graph that a DTO had not enumerated — and the graph's
     * `node.config` is deliberately open-ended. Structure is checked by
     * the contract validator, which is the one definition of a valid
     * graph.
     */
    @IsObject()
    graph: Record<string, unknown>;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @IsOptional()
    @IsIn(WORKFLOW_STATUSES)
    status?: WorkflowStatus;

    @IsOptional()
    @IsUUID()
    workId?: string;
}

export class UpdateWorkflowDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name?: string;

    @IsOptional()
    @IsObject()
    graph?: Record<string, unknown>;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @IsOptional()
    @IsIn(WORKFLOW_STATUSES)
    status?: WorkflowStatus;

    @IsOptional()
    @IsUUID()
    workId?: string;
}

export class ListWorkflowsDto {
    @IsOptional()
    @IsIn(WORKFLOW_STATUSES)
    status?: WorkflowStatus;

    @IsOptional()
    @IsUUID()
    workId?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

export class ListWorkflowRunsDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * Saved workflow graphs (judgment layer G5).
 *
 * `WorkflowGraphExecutorService` could execute a graph long before this
 * existed, but the only caller was an agent chat tool handed an inline,
 * model-authored one — so a graph could be run and never kept. These
 * routes are what make a workflow something a user owns, edits and
 * re-runs.
 *
 * Every route is owner-scoped, and a workflow belonging to someone else
 * is reported as 404 rather than 403 so the collection cannot be used to
 * probe which ids exist.
 *
 * Running is dispatched, never awaited. A graph may hold delegate nodes
 * that each wait minutes for a child agent run — up to ~40 minutes for a
 * maximal graph — against a ~100-second edge timeout, so a synchronous
 * run endpoint could not work. `POST :id/run` records a `workflow_runs`
 * row, hands it to the Trigger.dev `workflow-run` task and answers 202
 * with the run id; the two GET routes below are how a caller follows it.
 *
 * That the endpoint cannot accidentally start awaiting the walk is
 * structural rather than a convention: `WorkflowRunsService` holds a
 * DISPATCHER and no executor, and the executor lives in a service only
 * the worker boots.
 */
@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(AuthSessionGuard)
@Controller('api/workflows')
export class WorkflowsController {
    constructor(
        private readonly workflows: WorkflowsService,
        private readonly runs: WorkflowRunsService,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'List the current user’s saved workflows',
        description:
            'Owner-scoped. `workId` narrows to workflows attached to one Work; omit it for everything the user owns. Ordered by most recently updated.',
    })
    @ApiQuery({ name: 'status', required: false, enum: WORKFLOW_STATUSES })
    @ApiQuery({ name: 'workId', required: false, type: String })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: '{ items, total }' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Query() query: ListWorkflowsDto) {
        return this.workflows.list(auth.userId, {
            status: query.status,
            workId: query.workId,
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
        });
    }

    // Declared ABOVE `:id` deliberately. `runs/:runId` is two segments and
    // `:id` is one, so under path-to-regexp v8 they cannot actually
    // collide — but a future single-segment static route (`@Get('runs')`)
    // WOULD be shadowed, and because `:id` is piped through
    // `ParseUUIDPipe` the symptom would be a 400 "uuid is expected" that
    // reads like a client bug rather than a routing one. Static-before-
    // param is the house order in the agents/tasks/works controllers.
    @Get('runs/:runId')
    @ApiOperation({
        summary: 'Read one workflow run in full',
        description:
            'Includes the capped trace: which nodes ran, each one’s outcome, the edges traversed, any `llm_decide` choices, and the truncated final output. Per-node outputs are deliberately not persisted — a `kb.search` node’s output can be entire Knowledge Base documents.',
    })
    @ApiResponse({ status: 200, description: 'The run' })
    @ApiResponse({ status: 404, description: 'No such run for this user' })
    async getRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('runId', new ParseUUIDPipe()) runId: string,
    ) {
        return this.runs.getRun(auth.userId, runId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Read one saved workflow' })
    @ApiResponse({ status: 200, description: 'The workflow' })
    @ApiResponse({ status: 404, description: 'No such workflow for this user' })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        return this.workflows.get(auth.userId, id);
    }

    @Post()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Save a workflow',
        description:
            'The graph is validated on write, so a stored workflow is one that can actually be executed — a malformed graph is refused here rather than discovered mid-run. Returns 400 with the specific structural errors when it is not valid.',
    })
    @ApiResponse({ status: 201, description: 'The created workflow' })
    @ApiResponse({ status: 400, description: 'The graph is not valid' })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateWorkflowDto) {
        return this.workflows.create(auth.userId, {
            name: body.name,
            graph: body.graph,
            description: body.description ?? null,
            status: body.status,
            workId: body.workId ?? null,
        });
    }

    @Patch(':id')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Update a saved workflow',
        description:
            'Partial update. A supplied graph is re-validated — the "a stored workflow is runnable" guarantee would otherwise be a one-time property any edit could quietly break.',
    })
    @ApiResponse({ status: 200, description: 'The updated workflow' })
    @ApiResponse({ status: 400, description: 'The graph is not valid' })
    @ApiResponse({ status: 404, description: 'No such workflow for this user' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: UpdateWorkflowDto,
    ) {
        return this.workflows.update(auth.userId, id, body);
    }

    @Post(':id/run')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Run a saved workflow',
        description:
            'Records a run and hands it to the job runtime, then returns immediately — it does NOT wait for the graph. A maximal graph walks for ~40 minutes, far past any HTTP timeout. Poll `GET /api/workflows/runs/:runId` for the outcome. The returned run is `queued` when the job runtime accepted it, and `failed` when it did not (rather than a queued row nothing will ever pick up).',
    })
    @ApiResponse({ status: 202, description: '{ runId, status }' })
    @ApiResponse({ status: 404, description: 'No such workflow for this user' })
    @ApiResponse({ status: 409, description: 'The workflow is archived' })
    async run(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        const run = await this.runs.start(auth.userId, id);
        return { runId: run.id, status: run.status };
    }

    @Get(':id/runs')
    @ApiOperation({
        summary: 'List a workflow’s run history',
        description:
            'Newest first. Returns list ROWS, not full runs — `trace` and `output` are the two columns that can be kilobytes each, so selecting them here would make the list cost scale with what the graphs produced rather than with how many runs there are. Fetch one run for those.',
    })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: '{ items, total }' })
    @ApiResponse({ status: 404, description: 'No such workflow for this user' })
    async listRuns(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Query() query: ListWorkflowRunsDto,
    ) {
        return this.runs.listForWorkflow(auth.userId, id, {
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
        });
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Delete a saved workflow',
        description:
            'Hard delete — a workflow is authored configuration, not a record of something that happened, so there is nothing here to preserve for audit. Its run history goes with it: `workflow_runs.workflowId` is ON DELETE CASCADE, matching how deleting an Agent discards its runs. A run record is not interpretable without the graph it ran.',
    })
    @ApiResponse({ status: 204, description: 'Deleted' })
    @ApiResponse({ status: 404, description: 'No such workflow for this user' })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        await this.workflows.remove(auth.userId, id);
    }
}
