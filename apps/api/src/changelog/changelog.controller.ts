import {
    BadRequestException,
    Body,
    Controller,
    DefaultValuePipe,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseIntPipe,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    CHANGELOG_CATEGORIES,
    CHANGELOG_LIMITS,
    CHANGELOG_SLUG_PATTERN,
    isChangelogCategory,
    type ChangelogEntryDto,
    type ChangelogListResponseDto,
    type ChangelogMarkReadResponseDto,
    type ChangelogUnreadCountResponseDto,
} from '@ever-works/contracts/api';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ChangelogService } from './changelog.service';
import { MarkChangelogReadDto } from './dto/mark-changelog-read.dto';

/** One body for "never existed" and "not published yet" (spec S-15). */
const ENTRY_NOT_FOUND = 'Changelog entry not found';

/**
 * What's new (AW-14) — the in-product changelog.
 *
 * Deliberately NOT workspace-scoped: no scope header handling, no
 * Organization filter. Entries are the same for every reader in a deployment
 * and read state follows the person, so switching Organization never changes
 * what is unread (spec FR-13). A later scope sweep must not add scoping here.
 *
 * There is no write endpoint for entries — they ship with the build (spec
 * FR-3). The only writes are the reader's own read marks.
 *
 * Per-person rate limits match spec FR-44; `UserAwareThrottlerGuard` keys
 * the `long` throttler by the authenticated user.
 */
@ApiTags('Changelog')
@ApiBearerAuth('JWT-auth')
@Controller('api/changelog')
@UseGuards(AuthSessionGuard)
export class ChangelogController {
    constructor(private readonly changelog: ChangelogService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: "List What's new entries",
        description:
            'Newest first (the pinned entry first), with per-reader read state. `unreadCount` is always unfiltered.',
    })
    @ApiQuery({ name: 'category', required: false, enum: CHANGELOG_CATEGORIES })
    @ApiQuery({
        name: 'limit',
        required: false,
        type: Number,
        description: `Page size, default ${CHANGELOG_LIMITS.pageSize}, max ${CHANGELOG_LIMITS.pageSizeMax}`,
    })
    @ApiQuery({
        name: 'cursor',
        required: false,
        type: String,
        description: 'The `nextCursor` of the previous page',
    })
    @ApiResponse({ status: 200, description: 'One page of changelog entries' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('category') category?: string,
        @Query('limit', new DefaultValuePipe(CHANGELOG_LIMITS.pageSize), ParseIntPipe)
        limit?: number,
        @Query('cursor') cursor?: string,
    ): Promise<ChangelogListResponseDto> {
        if (cursor !== undefined && !CHANGELOG_SLUG_PATTERN.test(cursor)) {
            throw new BadRequestException('cursor must be an entry slug');
        }
        return this.changelog.list(auth.userId, {
            // An unknown category is treated as "All" rather than an error: a
            // shared link from a newer build must still open a working list.
            category: isChangelogCategory(category) ? category : undefined,
            limit,
            cursor,
        });
    }

    // Declared BEFORE `GET /:slug` so `unread-count` is never swallowed as a slug.
    @Get('unread-count')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: "What's new unread count",
        description: 'Unread entries among the newest 50 published after the account was created.',
    })
    @ApiResponse({ status: 200, description: '`{ count }`' })
    async unreadCount(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<ChangelogUnreadCountResponseDto> {
        return { count: await this.changelog.unreadCount(auth.userId) };
    }

    @Get(':slug')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({ summary: "Get one What's new entry" })
    @ApiParam({ name: 'slug', type: String })
    @ApiResponse({ status: 200, description: 'The entry' })
    @ApiResponse({ status: 404, description: 'Not available on this version' })
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
    ): Promise<ChangelogEntryDto> {
        const entry = CHANGELOG_SLUG_PATTERN.test(slug)
            ? await this.changelog.getBySlug(auth.userId, slug)
            : null;
        if (!entry) {
            throw new NotFoundException(ENTRY_NOT_FOUND);
        }
        return entry;
    }

    @Post('read')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: "Mark What's new entries read",
        description: 'Idempotent. Slugs this build does not serve are ignored.',
    })
    @ApiResponse({ status: 200, description: '`{ unreadCount }` after the write' })
    async markRead(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: MarkChangelogReadDto,
    ): Promise<ChangelogMarkReadResponseDto> {
        return this.changelog.markRead(auth.userId, body.slugs);
    }

    @Post('read-all')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: "Mark every What's new entry read",
        description: 'Ignores any category filter. Idempotent.',
    })
    @ApiResponse({ status: 200, description: '`{ unreadCount: 0 }`' })
    async markAllRead(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<ChangelogMarkReadResponseDto> {
        return this.changelog.markAllRead(auth.userId);
    }
}
