import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemoryFactService, type MemoryFactActor } from '@ever-works/agent/services';
import {
    MEMORY_FACT_FORGET_ALL_CONFIRMATION,
    type MemoryFactDto,
    type MemoryFactForgetAllResultDto,
    type MemoryFactForgetResultDto,
    type MemoryFactListDto,
    type MemoryFactStatsDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import {
    CreateMemoryFactDto,
    ForgetAllMemoryFactsDto,
    ListMemoryFactsQueryDto,
    UpdateMemoryFactDto,
} from './dto/memory-facts.dto';

/** 60 writes a minute per user (spec NFR-6). */
const WRITE_THROTTLE = { long: { limit: 60, ttl: 60_000 } };
/** 120 reads a minute per user. */
const READ_THROTTLE = { long: { limit: 120, ttl: 60_000 } };
/** Forget all: 3 an hour per user (spec NFR-6). */
const FORGET_ALL_THROTTLE = { long: { limit: 3, ttl: 60 * 60_000 } };

/**
 * Memory facts — `/api/memory/facts` (AW-07).
 *
 * The atomic tier of Memory: one row per durable statement an owner wants
 * every agent in the workspace to carry into its runs. Sits beside the
 * existing `/api/memory` document aggregation and `/api/memory/files`, which
 * are untouched.
 *
 * **Scope.** The workspace (tenant + organization) comes from the request
 * SCOPE CONTEXT — the `/api/<slug>/…` path or the `x-scope-slug` header —
 * never from a query or body parameter, and every read and write is keyed on
 * the caller's own `userId` plus that scope. A fact id from another
 * workspace resolves to nothing, so the answer is 404, never a 403 that
 * would confirm the row exists. Authentication is the global
 * `AuthSessionGuard`; the tenant half of the scope is enforced by the global
 * `ScopeOwnershipGuard`.
 *
 * **Status codes.** 409 at a cap (2,000 active, 200 proposed, 20 pinned) or
 * on an exact duplicate; 410 restoring a fact forgotten more than 30 days
 * ago; 422 on a wrong Forget-all confirmation.
 */
@ApiTags('Memory facts')
@ApiBearerAuth('JWT-auth')
@Controller('api/memory/facts')
export class MemoryFactsController {
    constructor(
        private readonly facts: MemoryFactService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get()
    @Throttle(READ_THROTTLE)
    @ApiOperation({
        summary: 'List or search memory facts in the active workspace',
        description:
            'Newest first, 50 per page. With `q`, matches by meaning through the workspace vector store fused with a case-insensitive substring match — every literal hit is always included — and `semantic: false` reports that meaning-based matching was unavailable, in which case the result is the literal match alone.',
    })
    @ApiResponse({ status: 200, description: 'MemoryFactListDto' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListMemoryFactsQueryDto,
    ): Promise<MemoryFactListDto> {
        return this.facts.list(this.actor(auth), {
            q: query.q,
            status: query.status,
            scope: query.scope,
            agentId: query.agentId,
            pinnedOnly: query.pinnedOnly,
            limit: query.limit,
            cursor: query.cursor,
        });
    }

    @Get('stats')
    @Throttle(READ_THROTTLE)
    @ApiOperation({
        summary: 'Counts per status, capacities, and whether meaning-based search is available',
    })
    @ApiResponse({ status: 200, description: 'MemoryFactStatsDto' })
    async stats(@CurrentUser() auth: AuthenticatedUser): Promise<MemoryFactStatsDto> {
        return this.facts.stats(this.actor(auth));
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({
        summary: 'Remember a fact',
        description:
            'A fact written by the signed-in person lands active immediately. Body 1–500 characters after trimming.',
    })
    @ApiResponse({ status: 201, description: 'MemoryFactDto' })
    @ApiResponse({
        status: 400,
        description: 'Empty or over-long body (the message names the length)',
    })
    @ApiResponse({ status: 404, description: 'The named agent is not in this workspace' })
    @ApiResponse({
        status: 409,
        description: 'Memory is full, pins are full, or the fact already exists',
    })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateMemoryFactDto,
    ): Promise<MemoryFactDto> {
        return this.facts.create(this.actor(auth), {
            body: body.body,
            scope: body.scope,
            agentId: body.agentId,
            pinned: body.pinned,
            origin: 'user',
            sourceConversationId: body.sourceConversationId ?? null,
        });
    }

    @Post('forget-all')
    @HttpCode(HttpStatus.OK)
    @Throttle(FORGET_ALL_THROTTLE)
    @ApiOperation({
        summary: 'Forget every active and proposed fact in the workspace',
        description: `Requires \`{ "confirm": "${MEMORY_FACT_FORGET_ALL_CONFIRMATION}" }\`. Context files, agent files, uploads, meetings and Knowledge Base documents are not affected. Every forgotten fact stays restorable for 30 days.`,
    })
    @ApiResponse({ status: 200, description: '{ forgotten }' })
    @ApiResponse({ status: 422, description: 'The confirmation was not typed exactly' })
    async forgetAll(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: ForgetAllMemoryFactsDto,
    ): Promise<MemoryFactForgetAllResultDto> {
        if (body?.confirm !== MEMORY_FACT_FORGET_ALL_CONFIRMATION) {
            throw new UnprocessableEntityException({
                code: 'memory_fact_forget_all_unconfirmed',
                message: `Type ${MEMORY_FACT_FORGET_ALL_CONFIRMATION} to confirm.`,
            });
        }
        return this.facts.forgetAll(this.actor(auth));
    }

    @Get(':id')
    @Throttle(READ_THROTTLE)
    @ApiOperation({ summary: 'Read one fact' })
    @ApiResponse({ status: 200, description: 'MemoryFactDto' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MemoryFactDto> {
        return this.facts.get(this.actor(auth), id);
    }

    @Patch(':id')
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({
        summary: 'Edit a fact in place, pin or unpin it, or limit it to one agent',
        description:
            'An edit takes effect for every run started after it; runs already in flight keep the previous wording.',
    })
    @ApiResponse({ status: 200, description: 'MemoryFactDto' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    @ApiResponse({ status: 409, description: 'Pins full, duplicate, or the fact is forgotten' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateMemoryFactDto,
    ): Promise<MemoryFactDto> {
        return this.facts.update(this.actor(auth), id, {
            body: body.body,
            scope: body.scope,
            agentId: body.agentId,
            pinned: body.pinned,
        });
    }

    @Post(':id/forget')
    @HttpCode(HttpStatus.OK)
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({
        summary: 'Forget one fact',
        description: 'Soft: it stops being used immediately and stays restorable for 30 days.',
    })
    @ApiResponse({ status: 200, description: '{ id, status, restorableUntil }' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    async forget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MemoryFactForgetResultDto> {
        return this.facts.forget(this.actor(auth), id);
    }

    @Post(':id/restore')
    @HttpCode(HttpStatus.OK)
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({ summary: 'Restore a forgotten fact' })
    @ApiResponse({ status: 200, description: 'MemoryFactDto' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    @ApiResponse({ status: 409, description: 'Memory is full, duplicate, or not forgotten' })
    @ApiResponse({ status: 410, description: 'Forgotten more than 30 days ago' })
    async restore(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MemoryFactDto> {
        return this.facts.restore(this.actor(auth), id);
    }

    @Post(':id/accept')
    @HttpCode(HttpStatus.OK)
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({ summary: 'Accept a proposed fact so agents can use it' })
    @ApiResponse({ status: 200, description: 'MemoryFactDto' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    @ApiResponse({ status: 409, description: 'Memory is full, or the fact is not proposed' })
    async accept(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MemoryFactDto> {
        return this.facts.accept(this.actor(auth), id);
    }

    @Post(':id/discard')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle(WRITE_THROTTLE)
    @ApiOperation({ summary: 'Discard a proposed fact' })
    @ApiResponse({ status: 204, description: 'Discarded' })
    @ApiResponse({ status: 404, description: 'Not in this workspace' })
    @ApiResponse({ status: 409, description: 'The fact is not proposed' })
    async discard(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.facts.discard(this.actor(auth), id);
    }

    /** The caller plus the request's workspace — never a client-supplied org id. */
    private actor(auth: AuthenticatedUser): MemoryFactActor {
        const scope = this.scopeContext.getScope();
        return {
            userId: auth.userId,
            ownership: {
                tenantId: scope?.tenantId ?? null,
                organizationId: scope?.organizationId ?? null,
            },
        };
    }
}
