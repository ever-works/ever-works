import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
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
 * Security (EW-711 #29): metadata key used to stamp the creating user onto
 * every session / record. The agent-memory backend partitions by `project`
 * (shared across users), so this stamp is the per-resource ownership marker
 * the mutating handlers verify before close/delete. Forced from the
 * authenticated principal at write time — never read from the request body.
 */
const OWNER_METADATA_KEY = 'ownerUserId';

/**
 * REST surface for the `agent-memory` capability (follow-up to PR #1073
 * + #1081 + #1084). Lets the web admin UI list, search, save, and
 * forget memory observations / sessions for the signed-in user.
 *
 * All endpoints are JWT-protected. Reads enforce
 * `WorkOwnershipService.ensureCanView` when a `workId` is supplied so users
 * can't read another user's Work memory. Mutating, id-addressed handlers
 * (`closeSession` / `deleteEntry`) require `ensureCanEdit` for Work-scoped
 * calls AND verify the target session/entry's `ownerUserId` stamp so an
 * omitted or foreign `workId` cannot be used to mutate another user's
 * resource (EW-711 #29).
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
        // Security (EW-711 #29): stamp the creating user onto the session so
        // close/delete can verify per-session ownership. The agent-memory
        // backend partitions only by `project` (shared across users), so the
        // owner stamp is the only thing binding a session to its creator —
        // without it a user could close another user's session by id when
        // `workId` is omitted. `ownerUserId` overrides any caller-supplied
        // value of the same key so it can't be spoofed from the request body.
        metadata[OWNER_METADATA_KEY] = auth.userId;
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
        // Security (EW-711 #29): this is a mutating, id-addressed handler.
        // Previously the workId gate ran `ensureCanView` and was skipped
        // entirely when `workId` was omitted, so a user could close ANOTHER
        // user's session by guessing the id. Now: (1) a Work-scoped close
        // requires EDIT access (a viewer must not end a shared session), and
        // (2) we ALWAYS verify the session belongs to the caller via its
        // owner stamp — closing the `workId` bypass.
        await this.assertWorkEditAccess(auth, query.workId);
        const facadeOptions = this.facadeOptions(auth, query.workId);
        await this.assertOwnsSession(sessionId, auth, facadeOptions);
        try {
            await this.agentMemory.closeSession(sessionId, facadeOptions);
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
        // Security (EW-711 #29): stamp the creating user onto the record so
        // `deleteEntry` can verify per-entry ownership. Same rationale as
        // `openSession` — the backend is project-scoped, not user-scoped, so
        // the owner stamp is what lets us reject a cross-user forget by id.
        // `ownerUserId` is forced from the authenticated principal and
        // overrides any caller-supplied key of the same name.
        const metadata: Record<string, unknown> = {
            ...(dto.metadata ?? {}),
            [OWNER_METADATA_KEY]: auth.userId,
        };
        try {
            const record = await this.agentMemory.saveMemory(
                {
                    content: dto.content,
                    tags: dto.tags,
                    metadata,
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
        // Security (EW-711 #29): mutating, id-addressed handler — same IDOR
        // class as closeSession. A Work-scoped forget now requires EDIT
        // access, and we ALWAYS verify the entry belongs to the caller via
        // its owner stamp so an omitted/foreign `workId` can't be used to
        // delete another user's memory record by id.
        await this.assertWorkEditAccess(auth, query.workId);
        const facadeOptions = this.facadeOptions(auth, query.workId);
        await this.assertOwnsEntry(entryId, auth, facadeOptions);
        try {
            await this.agentMemory.deleteEntry(entryId, facadeOptions);
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

    /**
     * Security (EW-711 #29): edit-level variant of {@link assertWorkAccess}
     * for the mutating, id-addressed handlers (`closeSession` /
     * `deleteEntry`). A Work viewer can read shared memory but must not be
     * able to end sessions or forget records, so these gate on
     * `ensureCanEdit` rather than `ensureCanView`. As before, an absent
     * `workId` leaves provider/project resolution unscoped — but ownership
     * is no longer skipped: the per-session/per-entry stamp check below
     * runs unconditionally.
     */
    private async assertWorkEditAccess(
        auth: AuthenticatedUser,
        workId: string | undefined,
    ): Promise<void> {
        if (!workId) return;
        await this.ownership.ensureCanEdit(workId, auth.userId);
    }

    /**
     * Security (EW-711 #29): verify the target session was opened by the
     * caller. The agent-memory backend partitions by `project`, not by
     * user, so without this check any user sharing a project could close a
     * session they merely know the id of. We resolve the sessions visible in
     * the caller's scope via the existing `listSessions` read seam and, if
     * the target surfaces, reject when its `ownerUserId` stamp belongs to a
     * different user.
     *
     * Fail-open is deliberate ONLY for the cases that cannot be a cross-user
     * attack on a stamped resource: providers that don't implement
     * `listSessions`, and legacy/unstamped sessions (no `ownerUserId`). A
     * present, foreign stamp is always rejected. This preserves the
     * legitimate same-user flow (the caller's own sessions always carry
     * their own stamp) while closing the IDOR.
     */
    private async assertOwnsSession(
        sessionId: string,
        auth: AuthenticatedUser,
        facadeOptions: FacadeOptions,
    ): Promise<void> {
        let sessions: readonly { id: string; metadata?: Record<string, unknown> }[];
        try {
            sessions = await this.agentMemory.listSessions(undefined, facadeOptions);
        } catch (error) {
            // Provider doesn't expose `listSessions` → we cannot enumerate to
            // verify. Don't grant a free pass on a real failure, but a
            // missing optional method is not an attack signal: let the
            // downstream call proceed (the backend itself still scopes by the
            // resolved project/credentials).
            if (this.isUnsupportedError(error)) return;
            throw this.toHttpError(error, 'closeSession');
        }
        const session = sessions.find((s) => s.id === sessionId);
        this.assertStampMatches(session?.metadata, auth.userId);
    }

    /**
     * Security (EW-711 #29): per-entry analogue of {@link assertOwnsSession}
     * for `deleteEntry`. There is no get-by-id seam on the capability, so we
     * locate the record within the caller's scope via the existing
     * `searchMemory` read seam (broad query, generous limit) and reject when
     * the matched record carries a foreign `ownerUserId` stamp. Same
     * fail-open posture for unsupported providers / unstamped records as
     * sessions; a present, foreign stamp is always rejected.
     */
    private async assertOwnsEntry(
        entryId: string,
        auth: AuthenticatedUser,
        facadeOptions: FacadeOptions,
    ): Promise<void> {
        let records: readonly { id: string; metadata?: Record<string, unknown> }[];
        try {
            const response = await this.agentMemory.searchMemory(
                { query: '*', limit: 100 },
                facadeOptions,
            );
            records = response.results;
        } catch (error) {
            if (this.isUnsupportedError(error)) return;
            throw this.toHttpError(error, 'deleteEntry');
        }
        const record = records.find((r) => r.id === entryId);
        this.assertStampMatches(record?.metadata, auth.userId);
    }

    /**
     * Security (EW-711 #29): throw 403 when a resource's `ownerUserId`
     * stamp is present and belongs to a different user. Absent stamp (legacy
     * / not-found) is left to the caller's fail-open policy.
     */
    private assertStampMatches(
        metadata: Record<string, unknown> | undefined,
        userId: string,
    ): void {
        const owner = metadata?.[OWNER_METADATA_KEY];
        if (typeof owner === 'string' && owner !== userId) {
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to modify this agent-memory resource',
            });
        }
    }

    private isUnsupportedError(error: unknown): boolean {
        return error instanceof Error && error.message.includes('does not support');
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
