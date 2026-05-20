import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WorkProposalStatus } from '@ever-works/agent/user-research';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WorkProposalsApiService } from './work-proposals.service';
import {
    AcceptWorkProposalDto,
    ListWorkProposalsQueryDto,
    UpdateWorkProposalPreferencesDto,
    type RefreshResponseDto,
    type WorkProposalResponseDto,
} from './dto/work-proposal.dto';

@ApiTags('work-proposals')
@Controller('api/me/work-proposals')
export class WorkProposalsController {
    constructor(private readonly service: WorkProposalsApiService) {}

    @Get()
    @ApiOperation({ summary: 'List my work proposals' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListWorkProposalsQueryDto,
    ): Promise<WorkProposalResponseDto[]> {
        const statuses: WorkProposalStatus[] =
            query.statuses && query.statuses.length > 0
                ? query.statuses
                : [WorkProposalStatus.PENDING];
        const proposals = await this.service.list(auth.userId, statuses);
        return proposals.map((p) => ({
            id: p.id,
            title: p.title,
            description: p.description,
            slugSuggestion: p.slugSuggestion,
            suggestedCategories: p.suggestedCategories,
            suggestedFields: p.suggestedFields,
            recommendedPlugins: p.recommendedPlugins,
            generatedPrompt: p.generatedPrompt,
            reasoning: p.reasoning,
            source: p.source,
            status: p.status,
            acceptedWorkId: p.acceptedWorkId ?? null,
            generatedAt: p.generatedAt,
        }));
    }

    @Get('status')
    @ApiOperation({
        summary:
            'Refresh status: whether a run is in flight and whether the caller can start a new one',
    })
    @HttpCode(HttpStatus.OK)
    async status(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getRefreshStatus(auth.userId);
    }

    @Post('refresh')
    @ApiOperation({ summary: 'Trigger a fresh research + proposal-generation run' })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 3, ttl: 60_000 } })
    async refresh(@CurrentUser() auth: AuthenticatedUser): Promise<RefreshResponseDto> {
        const result = await this.service.refresh(auth.userId);
        if (result.status === 'rate-limited') {
            throw new HttpException(
                { status: result.status, error: result.error ?? 'daily limit exceeded' },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
        return { status: result.status, error: result.error };
    }

    @Get('preferences')
    @ApiOperation({ summary: 'Get my user-research preferences' })
    @HttpCode(HttpStatus.OK)
    async getPreferences(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getPreferences(auth.userId);
    }

    @Put('preferences')
    @ApiOperation({ summary: 'Update my user-research preferences' })
    @HttpCode(HttpStatus.OK)
    async updatePreferences(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateWorkProposalPreferencesDto,
    ) {
        if (typeof body?.optOut !== 'boolean') {
            throw new BadRequestException('optOut is required and must be boolean');
        }
        return this.service.updatePreferences(auth.userId, body.optOut);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a specific proposal by id (any status)' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<WorkProposalResponseDto> {
        const proposal = await this.service.getForUser(auth.userId, id);
        if (!proposal) throw new NotFoundException('Proposal not found');
        return {
            id: proposal.id,
            title: proposal.title,
            description: proposal.description,
            slugSuggestion: proposal.slugSuggestion,
            suggestedCategories: proposal.suggestedCategories,
            suggestedFields: proposal.suggestedFields,
            recommendedPlugins: proposal.recommendedPlugins,
            generatedPrompt: proposal.generatedPrompt,
            reasoning: proposal.reasoning,
            source: proposal.source,
            status: proposal.status,
            acceptedWorkId: proposal.acceptedWorkId ?? null,
            generatedAt: proposal.generatedAt,
        };
    }

    @Patch(':id/dismiss')
    @ApiOperation({ summary: 'Dismiss a pending proposal' })
    @ApiResponse({ status: 204, description: 'Dismissed' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async dismiss(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        const ok = await this.service.dismiss(auth.userId, id);
        if (!ok) {
            throw new NotFoundException('Proposal not found or not pending');
        }
    }

    @Post(':id/accept')
    @ApiOperation({
        summary: 'Mark a proposal as accepted after the user creates a Work from it',
    })
    @HttpCode(HttpStatus.OK)
    async accept(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AcceptWorkProposalDto,
    ) {
        if (!body?.workId) {
            throw new BadRequestException('workId is required');
        }
        const ok = await this.service.accept(auth.userId, id, body.workId);
        if (!ok) {
            throw new NotFoundException('Proposal not found or already finalized');
        }
        return { ok: true };
    }
}
