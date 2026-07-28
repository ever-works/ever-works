import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentEscalationService } from '@ever-works/agent/agents';
import type { AgentEscalationDto } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ListEscalationsQueryDto, ResolveEscalationBodyDto } from './dto/escalations.dto';

/**
 * Judgment layer G3/G10 — the ESCALATION QUEUE surface.
 *
 *   GET  /api/escalations                 my queue, highest confidence first
 *   GET  /api/escalations/:id             one escalation (owner-scoped)
 *   POST /api/escalations/:id/resolve     close it, with an optional note
 *
 * ## Why this exists next to the Task-scoped routes
 *
 * `GET /api/tasks/:id/escalations` has shipped since G3 landed, and it
 * answers "what did this Task escalate?". It cannot answer the question
 * a human actually asks — "what is waiting on ME?" — because reaching it
 * requires already knowing which Task to open. Escalations were
 * therefore written, notified, digested… and unreachable unless you
 * guessed right. This is the cross-Task read that makes them workable,
 * and it is ADDITIVE: the Task routes keep working byte for byte.
 *
 * ## Security
 *
 * Every route is owner-scoped inside `AgentEscalationService` (which is
 * owner-scoped inside the repository). There is no `userId` parameter to
 * supply, and `resolve` is a CAS on `status='open' AND userId=:me`, so a
 * foreign id and a missing id produce the same 404 — no existence
 * oracle, and a double-click resolves exactly once.
 */
@ApiTags('escalations')
@Controller('api/escalations')
export class EscalationsController {
    constructor(private readonly escalations: AgentEscalationService) {}

    @Get()
    @ApiOperation({
        summary:
            'List the escalations waiting on me — every time an agent stopped without finishing and a human decision is required. Ordered by confidence (how sure the platform is that a person is genuinely needed), then recency.',
    })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListEscalationsQueryDto,
    ): Promise<{ data: AgentEscalationDto[] }> {
        return {
            data: await this.escalations.listForUser(auth.userId, {
                status: query.status,
                limit: query.limit ?? 50,
                offset: query.offset ?? 0,
            }),
        };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one of my escalations.' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentEscalationDto> {
        const escalation = await this.escalations.getForUser(id, auth.userId);
        if (!escalation) {
            // Foreign and missing are the same answer, on purpose.
            throw new NotFoundException(`Escalation ${id} not found.`);
        }
        return escalation;
    }

    @Post(':id/resolve')
    @ApiOperation({ summary: 'Resolve one escalation with an optional decision note.' })
    @HttpCode(HttpStatus.OK)
    // A resolve is a cheap owner-scoped CAS, but it is still a write on
    // a surface a chat tool can drive — same throttle posture as the
    // other write endpoints.
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resolve(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ResolveEscalationBodyDto,
    ): Promise<{ resolved: true; escalationId: string }> {
        const resolved = await this.escalations.resolve(id, auth.userId, body.note ?? null);
        if (!resolved) {
            throw new NotFoundException(`Escalation ${id} not found or already resolved.`);
        }
        return { resolved: true, escalationId: id };
    }
}
