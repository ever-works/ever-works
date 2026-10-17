import {
    Body,
    Controller,
    Param,
    ParseUUIDPipe,
    Put,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsUUID, ValidateNested } from 'class-validator';
import {
    TaskAssigneeRepository,
    TaskBlockRepository,
    TaskRelationRepository,
    TasksService,
} from '@ever-works/agent/tasks-domain';
import { IntegrationResourcesService } from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { linkSourceOf, pinnedOrganizationOf, principalOf } from './integration-request';
import { IntegrationPrincipalRefDto } from './tasks-write.controller';

export class PutTaskAssigneesDto {
    @ApiProperty({ type: () => IntegrationPrincipalRefDto, isArray: true, maxItems: 50 })
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => IntegrationPrincipalRefDto)
    assignees!: IntegrationPrincipalRefDto[];
}

export class PutTaskWatchersDto {
    @ApiProperty({ type: [String], format: 'uuid', maxItems: 200 })
    @IsArray()
    @ArrayMaxSize(200)
    @IsUUID('all', { each: true })
    userIds!: string[];
}

export class PutTaskBlocksDto {
    @ApiProperty({ type: [String], format: 'uuid', maxItems: 200 })
    @IsArray()
    @ArrayMaxSize(200)
    @IsUUID('all', { each: true })
    blockedBy!: string[];
}

export class IntegrationRelationRefDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    taskId!: string;

    @ApiProperty({ enum: ['related', 'duplicates', 'follow-up'] })
    @IsIn(['related', 'duplicates', 'follow-up'])
    kind!: 'related' | 'duplicates' | 'follow-up';
}

export class PutTaskRelationsDto {
    @ApiProperty({ type: () => IntegrationRelationRefDto, isArray: true, maxItems: 200 })
    @IsArray()
    @ArrayMaxSize(200)
    @ValidateNested({ each: true })
    @Type(() => IntegrationRelationRefDto)
    relations!: IntegrationRelationRefDto[];
}

type Response = { setHeader(name: string, value: string): unknown };

/**
 * The PUT-set routes of a task (EW-P1-4, contract v1 B.6): each takes the FULL
 * set and answers the task DTO. The difference against the current set goes
 * through the same `TasksService` edge methods as the app, so every edge
 * change keeps its validation (actors in the task's tenant, no blocker cycles
 * — `422`) and records its own child event (`task.assignee.*`,
 * `task.watcher.*`, `task.block.*`, `task.relation.*`).
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/tasks/:id')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationTaskSetsController {
    constructor(
        private readonly tasks: TasksService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
        private readonly assigneeRows: TaskAssigneeRepository,
        private readonly blockRows: TaskBlockRepository,
        private readonly relationRows: TaskRelationRepository,
    ) {}

    @Put('assignees')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: "Set the task's assignees (the full set)" })
    async assignees(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTaskAssigneesDto,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { organizationId, scope } = await this.context(user, id);
        const rows = await this.assigneeRows.findByTaskId(id);
        const key = (type: string, actorId: string) => `${type}:${actorId}`;
        const wanted = new Set(dto.assignees.map((ref) => key(ref.type, ref.id)));
        for (const row of rows) {
            if (!wanted.has(key(row.assigneeType, row.assigneeId))) {
                await this.tasks.removeAssignee(user.userId, id, row.id, scope);
            }
        }
        const have = new Set(rows.map((row) => key(row.assigneeType, row.assigneeId)));
        for (const ref of dto.assignees) {
            if (!have.has(key(ref.type, ref.id))) {
                await this.tasks.addAssignee(user.userId, id, ref.type, ref.id, scope);
            }
        }
        return this.answer(user, organizationId, id, res);
    }

    @Put('watchers')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: "Set the task's watchers (the full set of user ids)" })
    async watchers(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTaskWatchersDto,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { organizationId, scope } = await this.context(user, id);
        const current = (await this.tasks.listWatchers(user.userId, id, scope)).map(
            (row) => row.userId,
        );
        const wanted = [...new Set(dto.userIds)];
        for (const userId of current.filter((existing) => !wanted.includes(existing))) {
            await this.tasks.removeWatcher(user.userId, id, userId, scope);
        }
        for (const userId of wanted.filter((next) => !current.includes(next))) {
            await this.tasks.addWatcher(user.userId, id, userId, scope);
        }
        return this.answer(user, organizationId, id, res);
    }

    @Put('blocks')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: 'Set the tasks that block this one (the full set)' })
    async blocks(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTaskBlocksDto,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { organizationId, scope } = await this.context(user, id);
        const rows = await this.blockRows.findByTaskId(id);
        const wanted = [...new Set(dto.blockedBy)];
        for (const row of rows.filter((block) => !wanted.includes(block.blockedByTaskId))) {
            await this.tasks.removeBlocker(user.userId, id, row.id, scope);
        }
        const have = rows.map((block) => block.blockedByTaskId);
        for (const blocker of wanted.filter((next) => !have.includes(next))) {
            await this.tasks.addBlocker(user.userId, id, blocker, scope);
        }
        return this.answer(user, organizationId, id, res);
    }

    @Put('relations')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: "Set the task's relations (the full set)" })
    async relations(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTaskRelationsDto,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { organizationId, scope } = await this.context(user, id);
        const rows = await this.relationRows.findByTaskId(id);
        const key = (taskId: string, kind: string) => `${taskId}:${kind}`;
        const wanted = new Set(dto.relations.map((ref) => key(ref.taskId, ref.kind)));
        for (const row of rows.filter((rel) => !wanted.has(key(rel.relatedTaskId, rel.kind)))) {
            await this.tasks.removeRelation(user.userId, id, row.id, scope);
        }
        const have = new Set(rows.map((rel) => key(rel.relatedTaskId, rel.kind)));
        for (const ref of dto.relations.filter((next) => !have.has(key(next.taskId, next.kind)))) {
            await this.tasks.addRelation(user.userId, id, ref.taskId, ref.kind, scope);
        }
        return this.answer(user, organizationId, id, res);
    }

    /** The pinned organization, and the task must be in it (404 otherwise). */
    private async context(user: AuthenticatedUser, id: string) {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        await this.resources.get('task', organizationId, id, linkSourceOf(principal));
        return { organizationId, scope: this.scope.getScope() as never };
    }

    private async answer(
        user: AuthenticatedUser,
        organizationId: string,
        id: string,
        res: Response,
    ) {
        const task = await this.resources.get(
            'task',
            organizationId,
            id,
            linkSourceOf(principalOf(user)),
        );
        if (task.etag) res.setHeader('ETag', task.etag);
        return task.dto;
    }
}
