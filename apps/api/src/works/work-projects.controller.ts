import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkLifecycleService, WorkQueryService } from '@ever-works/agent/services';
import { AuthService, AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { CreateProjectWorkDto } from './dto/create-project-work.dto';

/**
 * EW-P2-4 — the repo-less Project Work kind (`project`).
 *
 * A Project Work has no repositories, no deploy and no generator: it holds
 * Tasks, Goals and its team (plain project tracking, and the Ever Works side
 * of a Gauzy project). It is deliberately absent from
 * `USER_SELECTABLE_WORK_KINDS`, so the general `POST /api/works` cannot mint
 * one; this route is the only way in, and it is behind
 * `EVER_WORKS_PROJECT_WORKS_ENABLED` (exactly `true`, default OFF — refused
 * with `400 project_works_disabled` otherwise).
 *
 * Kept in its own controller, like `WorkCampaignsController`, rather than
 * bolted onto `WorksController`.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class WorkProjectsController {
    constructor(
        private readonly authService: AuthService,
        private readonly workLifecycle: WorkLifecycleService,
        private readonly workQuery: WorkQueryService,
    ) {}

    @Post('works/projects')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Create a Project Work',
        description:
            'Creates a repo-less Work of kind `project`: no repositories, no deploy and no generator. ' +
            'Tasks on it run without a repository. Off unless the API has `EVER_WORKS_PROJECT_WORKS_ENABLED=true`.',
    })
    @ApiResponse({ status: 201, description: 'Project Work created' })
    @ApiResponse({
        status: 400,
        description: 'Invalid input, or `project_works_disabled` when the kind is switched off',
    })
    @ApiResponse({ status: 409, description: 'Slug already taken' })
    async createProjectWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: CreateProjectWorkDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const availability = await this.workQuery.checkSlugAvailability(dto.slug ?? dto.name, user);
        // An explicit slug that is taken is refused; a derived one takes the
        // first free `<slug>-N`.
        const slug = availability.available
            ? availability.slug
            : dto.slug
              ? null
              : (availability.suggestion ?? null);
        if (!slug) {
            throw new BadRequestException(
                dto.slug
                    ? `The slug "${dto.slug}" is already taken. Pick another one.`
                    : 'Could not derive a free slug for this project. Pass an explicit slug.',
            );
        }
        return this.workLifecycle.createProjectWork(user, {
            name: dto.name,
            slug,
            description: dto.description,
        });
    }
}
