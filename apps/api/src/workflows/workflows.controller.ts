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
import { WorkflowsService } from '@ever-works/agent/services';
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
 * Running is deliberately NOT here. A graph may hold delegate nodes that
 * each wait minutes for a child agent run — up to ~40 minutes for a
 * maximal graph — against a ~100-second edge timeout, so a synchronous
 * run endpoint could not work. It lands in its own slice as a dispatched
 * job that returns a run id immediately.
 */
@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(AuthSessionGuard)
@Controller('api/workflows')
export class WorkflowsController {
    constructor(private readonly workflows: WorkflowsService) {}

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

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Delete a saved workflow',
        description:
            'Hard delete — a workflow is authored configuration, not a record of something that happened, so there is nothing here to preserve for audit. Run records are separate rows and are unaffected.',
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
