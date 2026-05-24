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
import type { WorkProposal } from '@ever-works/agent/entities';
import { BudgetOwnerType } from '@ever-works/agent/entities';
import { BudgetService, type OwnerBudgetSummary } from '@ever-works/agent/budgets';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WorkProposalsApiService } from './work-proposals.service';
import {
    AcceptWorkProposalDto,
    BuildWorkProposalResponseDto,
    CreateWorkProposalDto,
    ListWorkProposalsQueryDto,
    UpdateWorkProposalPreferencesDto,
    type RefreshResponseDto,
    type WorkProposalResponseDto,
} from './dto/work-proposal.dto';

const GENERIC_PROPOSAL_PROMPT =
    'Create a Work from this personalized idea. Research relevant items, categories, fields, and metadata based on the proposal details.';

/**
 * Phase 1 PR FF — shared BuildWorkProposalResponseDto builder. The
 * /build, /retry, and /rebuild endpoints all return the same shape
 * (the Idea after the state transition + the freshly-created Goal).
 * Extracted so the three controller methods stay one-liners.
 */
function toBuildResponseDto(result: {
    proposal: WorkProposal;
    goal: { id: string; instruction: string; status: string; dryRun: boolean; createdAt: Date };
}): BuildWorkProposalResponseDto {
    return {
        proposal: toResponseDto(result.proposal),
        goal: {
            id: result.goal.id,
            instruction: result.goal.instruction,
            status: result.goal.status,
            dryRun: result.goal.dryRun,
            createdAt: result.goal.createdAt,
        },
    };
}

/**
 * Shared map from WorkProposal entity → response DTO. Extracted in
 * Phase 1 PR B so the three controller paths (`list()`, `getOne()`,
 * `build()`) and the user-manual `createUserManual()` all return
 * the same shape with the new missionId / failureMessage /
 * failureKind fields.
 */
function toResponseDto(proposal: WorkProposal): WorkProposalResponseDto {
    return {
        id: proposal.id,
        title: proposal.title,
        description: proposal.description,
        slugSuggestion: proposal.slugSuggestion,
        suggestedCategories: proposal.suggestedCategories,
        suggestedFields: proposal.suggestedFields,
        recommendedPlugins: proposal.recommendedPlugins,
        generatedPrompt: toProposalUserPrompt(proposal),
        reasoning: proposal.reasoning,
        source: proposal.source,
        status: proposal.status,
        acceptedWorkId: proposal.acceptedWorkId ?? null,
        missionId: proposal.missionId ?? null,
        failureMessage: proposal.failureMessage ?? null,
        failureKind: proposal.failureKind ?? null,
        generatedAt: proposal.generatedAt,
    };
}

function toProposalUserPrompt(proposal: {
    title: string;
    description: string;
    generatedPrompt?: string | null;
    suggestedCategories?: Array<{ name: string; slug: string }>;
}): string {
    const stored = proposal.generatedPrompt?.trim();
    if (stored && stored !== GENERIC_PROPOSAL_PROMPT) {
        return stored;
    }

    const categories = (proposal.suggestedCategories ?? []).map((c) => c.name).filter(Boolean);
    const parts = [
        `Create a Work about ${proposal.title}.`,
        proposal.description,
        categories.length > 0 ? `Use categories like ${categories.join(', ')}.` : '',
    ].filter(Boolean);
    return parts.join(' ').slice(0, 1000).trim();
}

@ApiTags('work-proposals')
@Controller('api/me/work-proposals')
export class WorkProposalsController {
    constructor(
        private readonly service: WorkProposalsApiService,
        // Phase 7 PR U — per-Idea budget summary.
        private readonly budgetService: BudgetService,
    ) {}

    /**
     * Phase 1 PR B — `POST /me/work-proposals` user-manual Idea
     * create. Body: `{ description, title? }`. Returns the new
     * Idea row. Title is derived from the description until the
     * AI shared titler ships in PR I.
     *
     * @Throttle: 10 per minute matches the modest cadence a real
     * user would create Ideas via the +Add quick-add (spec §3.4).
     */
    @Post()
    @ApiOperation({ summary: 'Create a user-typed Idea (USER_MANUAL source)' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async createUserManual(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateWorkProposalDto,
    ): Promise<WorkProposalResponseDto> {
        const created = await this.service.createUserManual(auth.userId, {
            description: body.description,
            title: body.title,
        });
        return toResponseDto(created);
    }

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
        const proposals = await this.service.list(auth.userId, statuses, {
            missionId: query.missionId,
        });
        return proposals.map(toResponseDto);
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
        // Accept either field. `optOut` is the canonical persisted shape;
        // `emailNotifications` is the web-client-friendly inverse
        // (notifications on === !opted-out). Sending neither is fine —
        // the partial PUT is a no-op and we re-read current state.
        let nextOptOut: boolean | undefined;
        if (typeof body?.optOut === 'boolean') {
            nextOptOut = body.optOut;
        } else if (typeof body?.emailNotifications === 'boolean') {
            nextOptOut = !body.emailNotifications;
        }
        if (nextOptOut === undefined) {
            // Caller sent a body that validated cleanly but contained
            // neither field — return current prefs without touching the
            // user row. This keeps the endpoint idempotent.
            return this.service.getPreferences(auth.userId);
        }
        return this.service.updatePreferences(auth.userId, nextOptOut);
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
        return toResponseDto(proposal);
    }

    @Get(':id/budget')
    @ApiOperation({
        summary:
            'Current period spend + cap status for this Idea (Phase 7 PR U). 404 when the Idea belongs to another user.',
    })
    @HttpCode(HttpStatus.OK)
    async budget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<OwnerBudgetSummary> {
        // Phase 7 PR U — ownership gate first so the per-Idea
        // spend isn't introspectable by unrelated users. Mirrors
        // the Mission endpoint shape.
        const proposal = await this.service.getForUser(auth.userId, id);
        if (!proposal) throw new NotFoundException('Proposal not found');
        return this.budgetService.summarizeForOwner({
            ownerType: BudgetOwnerType.IDEA,
            ownerId: id,
        });
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

    /**
     * Phase 1 PR B — `POST /me/work-proposals/:id/build` queue
     * an Idea for build. Transitions to QUEUED + creates a
     * WorkAgentGoal (`maxWorksPerRun=1`, `ideaId` set) so the
     * goal-completion handler (PR FF) can transition the Idea
     * to ACCEPTED with the new Work when the build finishes.
     */
    @Post(':id/build')
    @ApiOperation({ summary: 'Queue an Idea for build via the Work Agent goal pipeline' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async build(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<BuildWorkProposalResponseDto> {
        const result = await this.service.build(auth.userId, id);
        if (!result) {
            throw new NotFoundException('Proposal not found');
        }
        return toBuildResponseDto(result);
    }

    /**
     * Phase 1 PR FF — `POST /me/work-proposals/:id/retry` manual
     * Retry button (spec §3.9). Only valid for FAILED Ideas; clears
     * the failureMessage + failureKind, transitions FAILED → QUEUED,
     * spins up a fresh build Goal.
     */
    @Post(':id/retry')
    @ApiOperation({ summary: 'Manually retry a failed Idea build' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async retry(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<BuildWorkProposalResponseDto> {
        const result = await this.service.retry(auth.userId, id);
        if (!result) {
            throw new NotFoundException('Proposal not found');
        }
        return toBuildResponseDto(result);
    }

    /**
     * Phase 1 PR FF — `POST /me/work-proposals/:id/rebuild` for a
     * DONE Idea (Decision A27). Creates a NEW Work; on Goal
     * completion the Idea's `acceptedWorkId` is re-pointed to the
     * new Work. The original Work is NOT deleted.
     */
    @Post(':id/rebuild')
    @ApiOperation({ summary: 'Re-build a done Idea — produces a new Work, original is preserved' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async rebuild(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<BuildWorkProposalResponseDto> {
        const result = await this.service.rebuild(auth.userId, id);
        if (!result) {
            throw new NotFoundException('Proposal not found');
        }
        return toBuildResponseDto(result);
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
