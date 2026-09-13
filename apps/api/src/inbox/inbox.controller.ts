import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InboxService, type InboxReplyOutcome } from '@ever-works/agent/inbox';
import {
    INBOX_DECISION_PAGE_SIZE,
    type InboxDecisionCounts,
    type InboxDecisionDto,
    type InboxItemDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    ListInboxDecisionsQueryDto,
    ListInboxQueryDto,
    ReplyInboxItemDto,
    SetInboxReadStateDto,
} from './dto/inbox.dto';

/**
 * Inbox (operator message center) — API surface.
 *
 *   GET    /api/inbox                 my messages (?status= filter; default = active view;
 *                                     ?taskId= narrows to one Task) + unread count
 *   GET    /api/inbox/unread-count    badge count (polled by the sidebar)
 *   GET    /api/inbox/decisions       My Decisions — the questions, approvals and escalations
 *                                     waiting on me, ranked blocking-first, with filters
 *   GET    /api/inbox/decisions/counts open + blocking decision counts (header, sidebar)
 *   GET    /api/inbox/:id             one message
 *   POST   /api/inbox/:id/reply       answer it — routed per kind (steer/resume run,
 *                                     approve/reject proposal, resolve escalation)
 *   PATCH  /api/inbox/:id/read        mark read (body {unread:true} marks unread again)
 *   POST   /api/inbox/:id/archive     archive
 *   POST   /api/inbox/:id/unarchive   restore
 *   DELETE /api/inbox/:id             delete the message (the mirrored records survive)
 *
 * Auth is enforced by the global guard; `@CurrentUser` threads the user
 * id. Every route is owner-scoped inside `InboxService` /
 * `InboxItemRepository`, so a foreign id and a missing id produce the
 * same 404 — no existence oracle. Replying to an already-answered item
 * is a 409.
 */
@ApiTags('inbox')
@Controller('api/inbox')
export class InboxController {
    constructor(private readonly inbox: InboxService) {}

    @Get()
    @ApiOperation({
        summary:
            'List my inbox — questions, approvals, escalations and notices addressed to me, newest first. `taskId` narrows the list to one Task (the open question a parked fleet run is waiting on).',
    })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListInboxQueryDto,
    ): Promise<{
        data: InboxItemDto[];
        meta: { total: number; limit: number; offset: number; unreadCount: number };
    }> {
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        const { items, total, unreadCount } = await this.inbox.list(auth.userId, {
            status: query.status,
            limit,
            offset,
            // Conditional so the default call shape stays byte-identical
            // for every caller that never sends a Task filter.
            ...(query.taskId ? { taskId: query.taskId } : {}),
        });
        return { data: items, meta: { total, limit, offset, unreadCount } };
    }

    @Get('unread-count')
    @ApiOperation({ summary: 'Unread inbox count — the sidebar badge.' })
    @HttpCode(HttpStatus.OK)
    async unreadCount(@CurrentUser() auth: AuthenticatedUser): Promise<{ count: number }> {
        return { count: await this.inbox.unreadCount(auth.userId) };
    }

    // The two decision routes are declared BEFORE `:id`: Nest matches in
    // declaration order, and `:id` would otherwise swallow `decisions` and
    // 400 it through ParseUUIDPipe.

    @Get('decisions')
    @ApiOperation({
        summary:
            'My Decisions — the Inbox items that need me to decide (agent questions, approvals, escalations). The open tab is ranked: work stopped behind it first, then escalation confidence (unscored counts as 0.5), then oldest first. Filter by Agent, Task, Mission, kind, or search.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async listDecisions(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListInboxDecisionsQueryDto,
    ): Promise<{
        data: InboxDecisionDto[];
        meta: {
            total: number;
            limit: number;
            offset: number;
            openCount: number;
            blockingCount: number;
            lastRaisedAt: string | null;
        };
    }> {
        const limit = query.limit ?? INBOX_DECISION_PAGE_SIZE;
        const offset = query.offset ?? 0;
        const { items, total, counts } = await this.inbox.listDecisions(auth.userId, {
            status: query.status ?? 'open',
            limit,
            offset,
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.agentId ? { agentId: query.agentId } : {}),
            ...(query.taskId ? { taskId: query.taskId } : {}),
            ...(query.missionId ? { missionId: query.missionId } : {}),
            ...(query.q?.trim() ? { search: query.q.trim() } : {}),
        });
        return {
            data: items,
            meta: {
                total,
                limit,
                offset,
                openCount: counts.open,
                blockingCount: counts.blocking,
                lastRaisedAt: counts.lastRaisedAt,
            },
        };
    }

    @Get('decisions/counts')
    @ApiOperation({
        summary:
            'My Decisions counts — open decisions, how many have work stopped behind them, and when the latest one was raised.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async decisionCounts(@CurrentUser() auth: AuthenticatedUser): Promise<InboxDecisionCounts> {
        return this.inbox.decisionCounts(auth.userId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one of my inbox messages.' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboxItemDto> {
        const item = await this.inbox.getForUser(id, auth.userId);
        if (!item) {
            // Foreign and missing are the same answer, on purpose.
            throw new NotFoundException(`Inbox item ${id} not found.`);
        }
        return item;
    }

    @Post(':id/reply')
    @ApiOperation({
        summary:
            'Answer one inbox message. Questions steer/resume the asking run; approvals proxy to approve/reject; escalations resolve with the reply as the note.',
    })
    @HttpCode(HttpStatus.OK)
    // A reply can dispatch a run resume — same throttle posture as the
    // other run-adjacent write endpoints.
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async reply(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ReplyInboxItemDto,
    ): Promise<InboxReplyOutcome> {
        return this.inbox.reply(auth.userId, id, {
            text: body.text ?? null,
            optionId: body.optionId ?? null,
            // Conditional so a caller that never opts in reaches the
            // service with exactly the call shape it always had.
            ...(body.requireReason === true ? { requireReason: true } : {}),
        });
    }

    @Patch(':id/read')
    @ApiOperation({ summary: 'Mark one message read (body {unread:true} flips it back).' })
    @HttpCode(HttpStatus.OK)
    async setReadState(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetInboxReadStateDto,
    ): Promise<InboxItemDto> {
        return this.inbox.setUnread(id, auth.userId, body.unread === true);
    }

    @Post(':id/archive')
    @ApiOperation({ summary: 'Archive one message.' })
    @HttpCode(HttpStatus.OK)
    async archive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboxItemDto> {
        return this.inbox.setArchived(id, auth.userId, true);
    }

    @Post(':id/unarchive')
    @ApiOperation({ summary: 'Restore one archived message.' })
    @HttpCode(HttpStatus.OK)
    async unarchive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboxItemDto> {
        return this.inbox.setArchived(id, auth.userId, false);
    }

    @Delete(':id')
    @ApiOperation({
        summary:
            'Delete one message. The mirrored records (escalation / proposal / run) are untouched.',
    })
    @HttpCode(HttpStatus.OK)
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true; itemId: string }> {
        await this.inbox.delete(id, auth.userId);
        return { deleted: true, itemId: id };
    }
}
