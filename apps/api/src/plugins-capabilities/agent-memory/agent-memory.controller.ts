import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AgentMemoryFacadeService, NoProviderError } from '@ever-works/agent/facades';
import { WorkOwnershipService } from '@ever-works/agent/services';
import type { FacadeOptions } from '@ever-works/plugin';
import { CurrentUser, AuthSessionGuard } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    BuildContextDto,
    ListSessionsQueryDto,
    MemoryScopeQueryDto,
    OpenSessionDto,
    SaveMemoryDto,
    SearchMemoryDto,
} from './dto/agent-memory.dto';

/**
 * REST surface for the `agent-memory` capability (follow-up to PR #1073
 * + #1081 + #1084). Lets the web admin UI list, search, save, and
 * forget memory observations / sessions for the signed-in user.
 *
 * All endpoints are JWT-protected; mutating ones additionally enforce
 * `WorkOwnershipService.ensureCanView` when a `workId` is supplied so
 * users can't read another user's Work memory.
 *
 * Routing is mounted under `/api/agent-memory` to match the sibling
 * capability controllers (`/api/search`, `/api/agent/memory` was
 * considered but kept the flat `/api/agent-memory` form for
 * consistency with the rest of `plugins-capabilities/`).
 */
@ApiTags('Agent Memory')
@ApiBearerAuth('JWT-auth')
@Controller('api/agent-memory')
@UseGuards(AuthSessionGuard)
export class AgentMemoryController {
    constructor(
        private readonly agentMemory: AgentMemoryFacadeService,
        private readonly ownership: WorkOwnershipService,
    ) {}

    @Get('/check-availability')
    @ApiOperation({
        summary: 'Check agent-memory availability',
        description:
            'Returns whether an agent-memory provider is currently registered + loaded. The provider may still be unconfigured per-user (e.g. no API key), which would surface as a 4xx on the actual call.',
    })
    @ApiResponse({ status: 200, description: 'Availability status' })
    async checkAvailability(@CurrentUser() auth: AuthenticatedUser) {
        const configured = this.agentMemory.isConfigured();
        if (!configured) {
            return {
                status: 'success',
                available: false,
                activeProvider: null,
                message:
                    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`) in settings.',
            };
        }
        const provider = await this.agentMemory
            .getDefaultProvider(undefined, auth.userId)
            .catch(() => null);
        return {
            status: 'success',
            available: true,
            activeProvider: provider,
        };
    }

    @Post('/sessions')
    @ApiOperation({ summary: 'Open a memory session' })
    @ApiResponse({ status: 201, description: 'Opened session' })
    async openSession(@CurrentUser() auth: AuthenticatedUser, @Body() dto: OpenSessionDto) {
        await this.assertWorkAccess(auth, dto.workId);
        // Codex P2 on PR #1086 — the facade's openSession takes
        // `metadata` but the plugin reads `projectId` separately. Fold
        // a caller-supplied projectId into metadata so the session
        // actually scopes to the requested namespace.
        const metadata: Record<string, unknown> = { ...(dto.metadata ?? {}) };
        if (dto.projectId) metadata.projectId = dto.projectId;
        try {
            const session = await this.agentMemory.openSession(
                metadata,
                this.facadeOptions(auth, dto.workId),
            );
            return { status: 'success', session };
        } catch (error) {
            throw this.toHttpError(error, 'openSession');
        }
    }

    @Post('/sessions/:sessionId/close')
    @ApiOperation({ summary: 'Close an open memory session' })
    @ApiResponse({ status: 200, description: 'Closed' })
    async closeSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('sessionId') sessionId: string,
        @Query() query: MemoryScopeQueryDto,
    ) {
        if (!sessionId) throw new BadRequestException('sessionId is required');
        await this.assertWorkAccess(auth, query.workId);
        try {
            await this.agentMemory.closeSession(sessionId, this.facadeOptions(auth, query.workId));
            return { status: 'success' };
        } catch (error) {
            throw this.toHttpError(error, 'closeSession');
        }
    }

    @Get('/sessions')
    @ApiOperation({ summary: 'List recent memory sessions' })
    @ApiResponse({ status: 200, description: 'Session list' })
    async listSessions(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListSessionsQueryDto,
    ) {
        await this.assertWorkAccess(auth, query.workId);
        try {
            const sessions = await this.agentMemory.listSessions(
                { limit: query.limit, projectId: query.projectId },
                this.facadeOptions(auth, query.workId),
            );
            return { status: 'success', sessions };
        } catch (error) {
            throw this.toHttpError(error, 'listSessions');
        }
    }

    @Post('/save')
    @ApiOperation({ summary: 'Persist a memory observation' })
    @ApiResponse({ status: 201, description: 'Saved record' })
    async save(@CurrentUser() auth: AuthenticatedUser, @Body() dto: SaveMemoryDto) {
        await this.assertWorkAccess(auth, dto.workId);
        try {
            const record = await this.agentMemory.saveMemory(
                {
                    content: dto.content,
                    tags: dto.tags,
                    metadata: dto.metadata,
                    sessionId: dto.sessionId,
                    projectId: dto.projectId,
                },
                this.facadeOptions(auth, dto.workId),
            );
            return { status: 'success', record };
        } catch (error) {
            throw this.toHttpError(error, 'saveMemory');
        }
    }

    @Post('/search')
    @ApiOperation({ summary: 'Search persisted memories' })
    @ApiResponse({ status: 200, description: 'Search response' })
    async search(@CurrentUser() auth: AuthenticatedUser, @Body() dto: SearchMemoryDto) {
        await this.assertWorkAccess(auth, dto.workId);
        try {
            const response = await this.agentMemory.searchMemory(
                {
                    query: dto.query,
                    limit: dto.limit,
                    tags: dto.tags,
                    sessionId: dto.sessionId,
                    projectId: dto.projectId,
                },
                this.facadeOptions(auth, dto.workId),
            );
            return { status: 'success', ...response };
        } catch (error) {
            throw this.toHttpError(error, 'searchMemory');
        }
    }

    @Post('/context')
    @ApiOperation({ summary: 'Build a context payload for a prompt' })
    @ApiResponse({ status: 200, description: 'Context payload' })
    async context(@CurrentUser() auth: AuthenticatedUser, @Body() dto: BuildContextDto) {
        await this.assertWorkAccess(auth, dto.workId);
        try {
            const context = await this.agentMemory.buildContext(
                {
                    query: dto.query,
                    purpose: dto.purpose,
                    sessionId: dto.sessionId,
                    projectId: dto.projectId,
                    maxTokens: dto.maxTokens,
                },
                this.facadeOptions(auth, dto.workId),
            );
            return { status: 'success', context };
        } catch (error) {
            throw this.toHttpError(error, 'buildContext');
        }
    }

    @Delete('/entries/:entryId')
    @ApiOperation({ summary: 'Forget a single memory record' })
    @ApiResponse({ status: 200, description: 'Deleted' })
    async deleteEntry(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('entryId') entryId: string,
        @Query() query: MemoryScopeQueryDto,
    ) {
        if (!entryId) throw new BadRequestException('entryId is required');
        await this.assertWorkAccess(auth, query.workId);
        try {
            await this.agentMemory.deleteEntry(entryId, this.facadeOptions(auth, query.workId));
            return { status: 'success' };
        } catch (error) {
            throw this.toHttpError(error, 'deleteEntry');
        }
    }

    // ── helpers ────────────────────────────────────────────────────────

    /**
     * Enforce ownership when the caller scopes the request to a Work.
     * Anonymous-Work memory and platform-wide reads stay open per the
     * existing search/screenshot/etc. capability convention.
     */
    private async assertWorkAccess(
        auth: AuthenticatedUser,
        workId: string | undefined,
    ): Promise<void> {
        if (!workId) return;
        await this.ownership.ensureCanView(workId, auth.userId);
    }

    private facadeOptions(auth: AuthenticatedUser, workId?: string): FacadeOptions {
        return {
            userId: auth.userId,
            ...(workId && { workId }),
        };
    }

    /**
     * Translate facade-layer errors into HTTP exceptions the client can
     * act on. Notably:
     *
     *   - `NoProviderError` → 400 with a hint to enable a provider.
     *   - "does not support …" errors thrown by the facade when the
     *     resolved plugin omits an optional method → 404 (the operation
     *     isn't available against this backend).
     *   - Everything else → 400 with the original message.
     */
    private toHttpError(error: unknown, operation: string): Error {
        if (error instanceof NoProviderError) {
            return new BadRequestException({
                status: 'error',
                message:
                    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).',
                operation,
            });
        }
        const message = error instanceof Error ? error.message : 'Agent-memory operation failed';
        if (message.includes('does not support')) {
            return new NotFoundException({ status: 'error', message, operation });
        }
        return new BadRequestException({ status: 'error', message, operation });
    }
}
