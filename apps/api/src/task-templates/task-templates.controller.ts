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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TaskTemplatesService } from '@ever-works/agent/tasks-domain';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    CreateTaskTemplateDto,
    InstantiateTaskTemplateDto,
    UpdateTaskTemplateDto,
} from './task-templates.dto';

/**
 * Tasks upgrades — workflow Task Templates.
 *
 *   GET    /api/task-templates                  list mine (seeds defaults on first list)
 *   POST   /api/task-templates                  create
 *   GET    /api/task-templates/:id              get one (with steps)
 *   PATCH  /api/task-templates/:id              update (steps replaced wholesale)
 *   DELETE /api/task-templates/:id              delete
 *   POST   /api/task-templates/:id/instantiate  expand into parent + sub-tasks
 *
 * Cross-user reads return 404 (no existence leak via 403).
 */
@ApiTags('task-templates')
@Controller('api/task-templates')
export class TaskTemplatesController {
    constructor(private readonly service: TaskTemplatesService) {}

    @Get()
    @ApiOperation({ summary: 'List my task templates (steps embedded).' })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser) {
        return { data: await this.service.list(auth.userId) };
    }

    @Post()
    @ApiOperation({ summary: 'Create a task template with its steps.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateTaskTemplateDto) {
        return this.service.create(auth.userId, {
            name: body.name,
            slug: body.slug,
            description: body.description ?? null,
            labels: body.labels ?? null,
            steps: body.steps,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one task template (with steps).' })
    @HttpCode(HttpStatus.OK)
    async getOne(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.getOne(auth.userId, id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a task template (steps replaced wholesale when sent).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateTaskTemplateDto,
    ) {
        return this.service.update(auth.userId, id, body);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a task template (instantiated tasks are untouched).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.remove(auth.userId, id);
    }

    @Post(':id/instantiate')
    @ApiOperation({
        summary:
            'Expand the template into a parent Task + one sub-task per step (dependencies as blockers, per-step agents as assignees, approval gates as approvers) — one transaction.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async instantiate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: InstantiateTaskTemplateDto,
    ) {
        return this.service.instantiateTemplate(auth.userId, id, {
            title: body.title,
            description: body.description ?? null,
            workId: body.workId ?? null,
            missionId: body.missionId ?? null,
            ideaId: body.ideaId ?? null,
            branchName: body.branchName ?? null,
            priority: body.priority,
        });
    }
}
