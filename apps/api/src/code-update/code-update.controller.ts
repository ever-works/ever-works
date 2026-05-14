import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { CodeUpdateGeneratorService } from '@ever-works/agent/generators';
import { UserRepository, WorkRepository } from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ActivityActionType,
    ActivityStatus,
    WorkCodeUpdateSource,
} from '@ever-works/agent/entities';
import { CreateCodeUpdateDto } from './dto/code-update.dto';

@ApiTags('Code Update')
@ApiBearerAuth('JWT-auth')
@Controller('api/works/:id/code-updates')
@UseGuards(AuthSessionGuard)
export class CodeUpdateController {
    constructor(
        private readonly codeUpdateService: CodeUpdateGeneratorService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly userRepository: UserRepository,
        private readonly workRepository: WorkRepository,
        private readonly activityLogService: ActivityLogService,
    ) {}

    @Post('/')
    @ApiOperation({ summary: 'Request an AI code update' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Code update created' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() dto: CreateCodeUpdateDto,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanEdit(workId, auth.userId);
        const user = await this.userRepository.findById(
            isCreator ? auth.userId : work.user.id,
        );
        if (!user) {
            throw new BadRequestException({ status: 'error', message: 'User not found' });
        }

        const record = await this.codeUpdateService.request(
            work,
            user,
            { prompt: dto.prompt, title: dto.title, aiModel: dto.aiModel },
            { autoExecute: true },
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.GENERATION,
                action: 'code_update.requested',
                status: ActivityStatus.IN_PROGRESS,
                summary: `Requested AI code update for ${work.name}`,
                details: { codeUpdateId: record.id, source: WorkCodeUpdateSource.MANUAL },
            })
            .catch(() => {});

        return { status: 'pending', codeUpdate: await this.codeUpdateService.get(record.id) };
    }

    @Get('/')
    @ApiOperation({ summary: 'List code updates for a work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Param('id') workId: string) {
        await this.ownershipService.ensureCanView(workId, auth.userId);
        const codeUpdates = await this.codeUpdateService.list(workId);
        return { status: 'success', codeUpdates };
    }

    @Get('/:codeUpdateId')
    @ApiOperation({ summary: 'Get a code update' })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('codeUpdateId') codeUpdateId: string,
    ) {
        await this.ownershipService.ensureCanView(workId, auth.userId);
        const record = await this.codeUpdateService.get(codeUpdateId);
        if (!record || record.workId !== workId) {
            throw new BadRequestException({ status: 'error', message: 'Code update not found' });
        }
        return { status: 'success', codeUpdate: record };
    }

    @Post('/:codeUpdateId/apply')
    @ApiOperation({ summary: 'Apply a proposed code update (merges the PR)' })
    async apply(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('codeUpdateId') codeUpdateId: string,
    ) {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        try {
            await this.codeUpdateService.apply(codeUpdateId);
        } catch (err) {
            throw new BadRequestException({
                status: 'error',
                message: err instanceof Error ? err.message : 'Failed to apply',
            });
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.GENERATION,
                action: 'code_update.applied',
                status: ActivityStatus.COMPLETED,
                summary: 'Applied AI code update',
                details: { codeUpdateId },
            })
            .catch(() => {});

        return { status: 'success', codeUpdate: await this.codeUpdateService.get(codeUpdateId) };
    }

    @Post('/:codeUpdateId/reject')
    @ApiOperation({ summary: 'Reject a proposed code update (closes the PR)' })
    async reject(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('codeUpdateId') codeUpdateId: string,
    ) {
        await this.ownershipService.ensureCanEdit(workId, auth.userId);
        try {
            await this.codeUpdateService.reject(codeUpdateId);
        } catch (err) {
            throw new BadRequestException({
                status: 'error',
                message: err instanceof Error ? err.message : 'Failed to reject',
            });
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.GENERATION,
                action: 'code_update.rejected',
                status: ActivityStatus.COMPLETED,
                summary: 'Rejected AI code update',
                details: { codeUpdateId },
            })
            .catch(() => {});

        return { status: 'success', codeUpdate: await this.codeUpdateService.get(codeUpdateId) };
    }
}
