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
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WorkProposalsApiService } from './work-proposals.service';
import {
    AcceptWorkProposalDto,
    ListWorkProposalsQueryDto,
    type RefreshResponseDto,
    type WorkProposalResponseDto,
} from './dto/work-proposal.dto';
import type { WorkProposalStatus } from '@ever-works/agent/user-research';

@ApiTags('work-proposals')
@Controller('v1')
export class WorkProposalsController {
    constructor(private readonly service: WorkProposalsApiService) {}

    @Get('me/work-proposals')
    @ApiOperation({ summary: 'List my work proposals' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListWorkProposalsQueryDto,
    ): Promise<WorkProposalResponseDto[]> {
        const statuses: WorkProposalStatus[] =
            query.statuses && query.statuses.length > 0 ? query.statuses : ['pending'];
        const proposals = await this.service.list(auth.userId, statuses);
        return proposals.map((p) => ({
            id: p.id,
            title: p.title,
            description: p.description,
            slugSuggestion: p.slugSuggestion,
            suggestedCategories: p.suggestedCategories,
            suggestedFields: p.suggestedFields,
            recommendedPlugins: p.recommendedPlugins,
            reasoning: p.reasoning,
            source: p.source,
            status: p.status as WorkProposalStatus,
            acceptedWorkId: p.acceptedWorkId ?? null,
            generatedAt: p.generatedAt,
        }));
    }

    @Get('me/work-proposals/status')
    @ApiOperation({ summary: 'Check whether a refresh is currently running for the caller' })
    @HttpCode(HttpStatus.OK)
    async status(@CurrentUser() auth: AuthenticatedUser) {
        const researching = await this.service.isResearching(auth.userId);
        return { researching };
    }

    @Post('me/work-proposals/refresh')
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

    @Patch('me/work-proposals/:id/dismiss')
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

    @Get('me/work-proposals/preferences')
    @ApiOperation({ summary: 'Get my user-research preferences' })
    @HttpCode(HttpStatus.OK)
    async getPreferences(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getPreferences(auth.userId);
    }

    @Put('me/work-proposals/preferences')
    @ApiOperation({ summary: 'Update my user-research preferences' })
    @HttpCode(HttpStatus.OK)
    async updatePreferences(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { optOut: boolean },
    ) {
        if (typeof body?.optOut !== 'boolean') {
            throw new BadRequestException('optOut is required and must be boolean');
        }
        return this.service.updatePreferences(auth.userId, body.optOut);
    }

    @Post('me/work-proposals/:id/accept')
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
