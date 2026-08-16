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
import type { InboxItemDto } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ListInboxQueryDto, ReplyInboxItemDto, SetInboxReadStateDto } from './dto/inbox.dto';

/**
 * Inbox (operator message center) — API surface.
 *
 *   GET    /api/inbox                 my messages (?status= filter; default = active view) + unread count
 *   GET    /api/inbox/unread-count    badge count (polled by the sidebar)
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
            'List my inbox — questions, approvals, escalations and notices addressed to me, newest first.',
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
        });
        return { data: items, meta: { total, limit, offset, unreadCount } };
    }

    @Get('unread-count')
    @ApiOperation({ summary: 'Unread inbox count — the sidebar badge.' })
    @HttpCode(HttpStatus.OK)
    async unreadCount(@CurrentUser() auth: AuthenticatedUser): Promise<{ count: number }> {
        return { count: await this.inbox.unreadCount(auth.userId) };
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
